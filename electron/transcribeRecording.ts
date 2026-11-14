// "Transcribe a Recording…": turns an audio or video file (say, a meeting recorded
// on a phone) into a transcript with the bundled whisper.cpp, on this computer.
// It saves <name>.transcript.txt and <name>.srt next to the file, ready to import
// into the AllKnowing meeting assistant for minutes and follow-ups.

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	type MessageBoxOptions,
	nativeTheme,
	shell,
} from "electron";
import { resolveWhisperExecutablePath } from "./ipc/captions/generate";
import { parseSrtCues } from "./ipc/captions/parser";
import { isMissingWindowsWhisperRuntimeDependency } from "./ipc/captions/runtimeErrors";
import { ensureWhisperSmallModel, getWhisperSmallModelStatus } from "./ipc/captions/whisper";
import { getFfmpegBinaryPath } from "./ipc/ffmpeg/binary";
import {
	buildSrt,
	buildTranscriptText,
	cleanWhisperCues,
	parseWhisperProgress,
	TRANSCRIBABLE_EXTENSIONS,
} from "./transcriptFiles";
import { reassertHudOverlayMousePassthrough } from "./windows";

/** Command-line flag the Windows taskbar task starts Recordly with. */
export const TRANSCRIBE_ARG = "--transcribe-recording";

const LANGUAGES = [
	{ label: "Detect automatically", code: "auto" },
	{ label: "English", code: "en" },
	{ label: "Chinese 中文", code: "zh" },
];

const FALLBACK_FOLDER_NAME = "Recordly Transcripts";

let busy = false;
let activeWindow: BrowserWindow | null = null;

class Cancelled extends Error {}

export function isTranscribingRecording() {
	return busy;
}

const PROGRESS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Transcribe a recording</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 20px 22px; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1f2430; background: #fff; user-select: none; cursor: default; }
h1 { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
.file { margin: 0 0 14px; color: #5b6270; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.4em; }
.bar { position: relative; height: 8px; border-radius: 99px; background: #e6e9f0; overflow: hidden; }
.fill { position: absolute; top: 0; bottom: 0; left: 0; width: 0; background: #2f5bea; border-radius: 99px; transition: width .4s ease; }
.bar.busy .fill { width: 30%; animation: slide 1.3s ease-in-out infinite; }
@keyframes slide { from { left: -30%; } to { left: 100%; } }
.status { margin: 10px 0 0; font-size: 13px; }
.hint { margin: 4px 0 0; font-size: 12px; color: #8a90a0; }
@media (prefers-color-scheme: dark) { body { background: #1d2027; color: #e8eaf0; } .file { color: #a5abb8; } .bar { background: #343946; } .fill { background: #6c8cff; } }
@media (prefers-reduced-motion: reduce) { .bar.busy .fill { animation: none; width: 100%; opacity: .35; } }
</style></head>
<body>
<h1>Transcribe a recording</h1>
<p class="file" id="file"></p>
<div class="bar busy" id="bar"><div class="fill" id="fill"></div></div>
<p class="status" id="status">Choose the recording…</p>
<p class="hint">Runs on this computer. Nothing is uploaded. Close this window to stop.</p>
<script>
window.setState = function (s) {
	document.getElementById("file").textContent = s.file || "";
	document.getElementById("status").textContent = s.status || "";
	var bar = document.getElementById("bar");
	var fill = document.getElementById("fill");
	if (typeof s.percent === "number") {
		bar.classList.remove("busy");
		fill.style.left = "0";
		fill.style.width = s.percent + "%";
	} else {
		bar.classList.add("busy");
		fill.style.left = "";
		fill.style.width = "";
	}
};
</script>
</body></html>`;

async function openProgressWindow(): Promise<BrowserWindow> {
	const win = new BrowserWindow({
		width: 460,
		height: 170,
		useContentSize: true,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		title: "Transcribe a recording",
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d2027" : "#ffffff",
		autoHideMenuBar: true,
		show: false,
		webPreferences: {
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	if (process.platform !== "darwin") {
		win.removeMenu();
	}
	await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PROGRESS_PAGE)}`);
	win.show();
	win.focus();
	// A new window can break the Windows 11 HUD's click-through; restore it.
	reassertHudOverlayMousePassthrough();
	return win;
}

function showProgress(
	win: BrowserWindow,
	state: { file: string; status: string; percent?: number | null },
) {
	if (win.isDestroyed()) return;
	const percent = typeof state.percent === "number" ? state.percent : null;
	// Taskbar / Dock progress: above 1 means "busy, no percentage".
	win.setProgressBar(percent === null ? 2 : percent / 100);
	void win.webContents
		.executeJavaScript(`window.setState(${JSON.stringify({ ...state, percent })})`)
		.catch(() => undefined);
}

function messageBox(win: BrowserWindow | null, options: MessageBoxOptions) {
	return win && !win.isDestroyed()
		? dialog.showMessageBox(win, options)
		: dialog.showMessageBox(options);
}

function runTool(
	command: string,
	args: string[],
	children: Set<ChildProcess>,
	onLine?: (line: string) => void,
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		// stdout is ignored: whisper prints the transcript there, and we read the .srt instead.
		const child = spawn(command, args, {
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		children.add(child);
		let output = "";
		let pending = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			output = (output + text).slice(-6000);
			if (!onLine) return;
			pending += text;
			const lines = pending.split(/\r\n|\r|\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		});
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			children.delete(child);
			resolve({ code, output });
		};
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			children.delete(child);
			reject(error);
		});
		// "close" waits for the output pipe; if something else still holds it after
		// the process has ended, don't wait for that.
		child.on("close", (code) => finish(code));
		child.on("exit", (code) => {
			setTimeout(() => finish(code), 1000);
		});
	});
}

const lastLines = (text: string, count = 3) =>
	text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-count)
		.join("\n");

async function firstFreePath(folder: string, base: string, suffix: string) {
	for (let n = 1; n < 100; n++) {
		const candidate = path.join(
			folder,
			n === 1 ? `${base}${suffix}` : `${base} (${n})${suffix}`,
		);
		try {
			await fs.access(candidate);
		} catch {
			return candidate;
		}
	}
	return path.join(folder, `${base}-${Date.now()}${suffix}`);
}

/** Saves next to the recording, or in Documents if that folder can't be written to. */
async function saveTranscript(sourcePath: string, text: string, srt: string) {
	const base = path.parse(sourcePath).name;
	const folders = [
		path.dirname(sourcePath),
		path.join(app.getPath("documents"), FALLBACK_FOLDER_NAME),
	];
	let lastError: unknown = null;
	for (const folder of folders) {
		let textPath: string | null = null;
		try {
			await fs.mkdir(folder, { recursive: true });
			textPath = await firstFreePath(folder, base, ".transcript.txt");
			const srtPath = await firstFreePath(folder, base, ".srt");
			await fs.writeFile(textPath, text, "utf8");
			await fs.writeFile(srtPath, srt, "utf8");
			return { textPath, srtPath, besideRecording: folder === folders[0] };
		} catch (error) {
			lastError = error;
			if (textPath) await fs.rm(textPath, { force: true }).catch(() => undefined);
		}
	}
	throw lastError ?? new Error("Couldn't save the transcript.");
}

async function chooseRecording(win: BrowserWindow) {
	const result = await dialog.showOpenDialog(win, {
		title: "Choose a recording to transcribe",
		buttonLabel: "Transcribe",
		properties: ["openFile"],
		filters: [
			{ name: "Audio and video", extensions: TRANSCRIBABLE_EXTENSIONS },
			{ name: "All files", extensions: ["*"] },
		],
	});
	return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function chooseLanguage(win: BrowserWindow, modelReady: boolean) {
	const { response } = await messageBox(win, {
		type: "question",
		message: "What language is the recording in?",
		detail: modelReady
			? "Recordly transcribes it on this computer. Nothing is uploaded."
			: "Recordly transcribes it on this computer. Nothing is uploaded.\n\nThe first time, it downloads its speech model (about 470 MB).",
		buttons: [...LANGUAGES.map((language) => language.label), "Cancel"],
		defaultId: 0,
		cancelId: LANGUAGES.length,
		noLink: true,
	});
	return LANGUAGES[response]?.code ?? null;
}

/**
 * Asks for a recording and a language, transcribes it with the bundled
 * whisper.cpp and saves .transcript.txt and .srt files. Safe to call again
 * while it runs: it brings the progress window forward instead.
 */
export async function startTranscribeRecording(): Promise<void> {
	if (busy) {
		if (activeWindow && !activeWindow.isDestroyed()) {
			activeWindow.show();
			activeWindow.focus();
		}
		return;
	}
	busy = true;

	const children = new Set<ChildProcess>();
	let cancelled = false;
	let win: BrowserWindow | null = null;
	let wavPath: string | null = null;
	let whisperOutBase: string | null = null;

	const checkCancelled = () => {
		if (cancelled) throw new Cancelled();
	};

	try {
		win = await openProgressWindow();
		activeWindow = win;
		win.on("close", () => {
			cancelled = true;
			for (const child of children) child.kill();
		});

		const sourcePath = await chooseRecording(win);
		checkCancelled();
		if (!sourcePath) return;
		const file = path.basename(sourcePath);
		const language = await chooseLanguage(win, (await getWhisperSmallModelStatus()).exists);
		checkCancelled();
		if (!language) return;

		// 1. The speech model (downloaded once, then reused by captions too)
		let shownPercent = -1;
		showProgress(win, { file, status: "Getting the speech model…" });
		let modelPath: string;
		try {
			modelPath = await ensureWhisperSmallModel((percent) => {
				if (percent === shownPercent || !win) return;
				shownPercent = percent;
				showProgress(win, {
					file,
					status: `Downloading the speech model (one time only)… ${percent}%`,
					percent,
				});
			});
		} catch (error) {
			throw new Error(
				`Couldn't download the speech model. Check the internet connection and try again.\n\n${error instanceof Error ? error.message : String(error)}`,
			);
		}
		checkCancelled();
		const whisperPath = await resolveWhisperExecutablePath();

		// 2. The sound, as 16 kHz mono WAV for whisper
		showProgress(win, { file, status: "Reading the audio…" });
		const tempBase = path.join(
			app.getPath("temp"),
			`recordly-transcribe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		wavPath = `${tempBase}.wav`;
		whisperOutBase = `${tempBase}-whisper`;
		const extract = await runTool(
			getFfmpegBinaryPath(),
			[
				"-hide_banner",
				"-nostats",
				"-y",
				"-i",
				sourcePath,
				"-map",
				"0:a:0",
				"-vn",
				"-ac",
				"1",
				"-ar",
				"16000",
				"-c:a",
				"pcm_s16le",
				wavPath,
			],
			children,
		);
		checkCancelled();
		if (extract.code !== 0) {
			throw new Error(
				/matches no streams|does not contain any stream|Output file .* does not contain/i.test(
					extract.output,
				)
					? "This file has no sound track to transcribe."
					: `Couldn't read the sound in this file.\n\n${lastLines(extract.output)}`,
			);
		}

		// 3. Speech to text
		showProgress(win, { file, status: "Transcribing… Long recordings take a while." });
		const whisper = await runTool(
			whisperPath,
			[
				"-m",
				modelPath,
				"-f",
				wavPath,
				"-l",
				language,
				"-osrt",
				"-of",
				whisperOutBase,
				"-np",
				"-pp",
			],
			children,
			(line) => {
				const percent = parseWhisperProgress(line);
				if (percent !== null && win) {
					showProgress(win, { file, status: `Transcribing… ${percent}%`, percent });
				}
			},
		);
		checkCancelled();
		if (whisper.code !== 0) {
			if (isMissingWindowsWhisperRuntimeDependency({ code: whisper.code })) {
				throw new Error(
					"Whisper could not start because the Microsoft Visual C++ x64 Redistributable is missing. Install it from https://aka.ms/vc14/vc_redist.x64.exe, then try again.",
				);
			}
			throw new Error(`Whisper stopped with an error.\n\n${lastLines(whisper.output)}`);
		}

		// 4. Save the transcript files
		showProgress(win, { file, status: "Saving…", percent: 100 });
		const cues = cleanWhisperCues(
			parseSrtCues(await fs.readFile(`${whisperOutBase}.srt`, "utf8")),
		);
		if (cues.length === 0) {
			throw new Error("No speech was found in this recording.");
		}
		const text = buildTranscriptText(cues);
		const saved = await saveTranscript(sourcePath, text, buildSrt(cues));
		checkCancelled();
		win.setProgressBar(-1);

		const { response } = await messageBox(win, {
			type: "info",
			message: "Transcript ready",
			detail: [
				saved.besideRecording
					? "Saved next to the recording:"
					: `Saved in Documents › ${FALLBACK_FOLDER_NAME}:`,
				path.basename(saved.textPath),
				path.basename(saved.srtPath),
				"",
				"For minutes and follow-ups, open AllKnowing in claude.ai, go to Import, then paste the transcript or add the .srt file.",
			].join("\n"),
			buttons: ["Copy transcript", "Show in folder", "Done"],
			defaultId: 0,
			cancelId: 2,
			noLink: true,
		});
		if (response === 0) clipboard.writeText(text);
		if (response === 1) shell.showItemInFolder(saved.textPath);
	} catch (error) {
		if (!(error instanceof Cancelled) && !cancelled) {
			console.error("[transcribe-recording] Failed:", error);
			if (win && !win.isDestroyed()) win.setProgressBar(1, { mode: "error" });
			await messageBox(win, {
				type: "error",
				message: "Couldn't transcribe this recording",
				detail: error instanceof Error ? error.message : String(error),
				buttons: ["OK"],
				noLink: true,
			});
		}
	} finally {
		for (const child of children) child.kill();
		await Promise.allSettled(
			[wavPath, whisperOutBase && `${whisperOutBase}.srt`]
				.filter((value): value is string => Boolean(value))
				.map((value) => fs.rm(value, { force: true })),
		);
		busy = false;
		activeWindow = null;
		if (win && !win.isDestroyed()) {
			win.destroy();
			reassertHudOverlayMousePassthrough();
		}
	}
}
