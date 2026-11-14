// Turns Whisper's caption cues into the files "Transcribe a Recording…" saves:
// a readable .txt (paragraphs with a time at the start) and a standard .srt.

export type TranscriptCue = {
	startMs: number;
	endMs: number;
	text: string;
};

const CJK = "\\u3400-\\u9fff\\uf900-\\ufaff";
const ENDS_WITH_CJK = new RegExp(`[${CJK}\\u3000-\\u303f\\uff00-\\uffef]$`);
const STARTS_WITH_CJK = new RegExp(`^[${CJK}]`);

/** Joins two pieces of text without putting a space between Chinese characters. */
export function joinTranscriptText(a: string, b: string): string {
	if (!a) return b;
	if (!b) return a;
	return ENDS_WITH_CJK.test(a) && STARTS_WITH_CJK.test(b) ? a + b : `${a} ${b}`;
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** 75_000 -> "01:15", 3_725_000 -> "1:02:05" */
export function formatTranscriptClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 3_725_042 -> "01:02:05,042" */
export function formatSrtTime(ms: number): string {
	const total = Math.max(0, Math.round(ms));
	const hours = Math.floor(total / 3_600_000);
	const minutes = Math.floor((total % 3_600_000) / 60_000);
	const seconds = Math.floor((total % 60_000) / 1000);
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(total % 1000, 3)}`;
}

/**
 * Drops what Whisper writes for silence and music ("[BLANK_AUDIO]", "(music)", "♪")
 * and the same line repeated back to back, which Whisper does when it loops.
 */
export function cleanWhisperCues(cues: TranscriptCue[]): TranscriptCue[] {
	const out: TranscriptCue[] = [];
	for (const cue of cues) {
		const text = cue.text.replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (/^[[(（【][^\])）】]*[\])）】]$/.test(text)) continue;
		if (/^[♪♫\s.…-]+$/.test(text)) continue;
		const previous = out[out.length - 1];
		if (previous && previous.text.toLowerCase() === text.toLowerCase()) {
			previous.endMs = Math.max(previous.endMs, cue.endMs);
			continue;
		}
		out.push({ startMs: cue.startMs, endMs: cue.endMs, text });
	}
	return out;
}

/**
 * Groups cues into paragraphs: a new one starts after a pause of more than
 * two seconds or once a paragraph gets long. Each starts with its time, e.g.
 * "[01:15] We agreed the pilot covers three sites."
 */
export function buildTranscriptText(cues: TranscriptCue[]): string {
	const paragraphs: Array<{ startMs: number; endMs: number; text: string }> = [];
	for (const cue of cues) {
		const current = paragraphs[paragraphs.length - 1];
		if (current && cue.startMs - current.endMs <= 2000 && current.text.length < 400) {
			current.text = joinTranscriptText(current.text, cue.text);
			current.endMs = Math.max(current.endMs, cue.endMs);
		} else {
			paragraphs.push({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text });
		}
	}
	return `${paragraphs.map((p) => `[${formatTranscriptClock(p.startMs)}] ${p.text}`).join("\n\n")}\n`;
}

export function buildSrt(cues: TranscriptCue[]): string {
	return `${cues
		.map(
			(cue, index) =>
				`${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}`,
		)
		.join("\n\n")}\n`;
}

/** Reads whisper-cli's "--print-progress" lines, e.g. "whisper_print_progress_callback: progress =  45%". */
export function parseWhisperProgress(line: string): number | null {
	const match = line.match(/progress\s*=\s*(\d{1,3})\s*%/);
	if (!match) return null;
	return Math.max(0, Math.min(100, Number(match[1])));
}

export const TRANSCRIBABLE_EXTENSIONS = [
	"mp4",
	"m4a",
	"mp3",
	"wav",
	"mov",
	"m4v",
	"aac",
	"webm",
	"mkv",
	"ogg",
	"oga",
	"opus",
	"flac",
	"amr",
	"3gp",
	"wma",
	"avi",
	"wmv",
];
