#!/usr/bin/env node
/* AllKnowing on your Mac mini.

   One small server, with nothing to install but Node.js, that makes the Mac mini the home for AllKnowing:
   - it serves the web app (the same page as https://godraymond.github.io/AllKnowing/) to every device
   - it keeps every meeting, transcript and follow-up in one place, so the desktop, the Mac mini and the
     phones all see the same list, and an open page hears about changes as they happen
   - it keeps your Claude API key and your Soniox speech key on the Mac. Claude is asked through here, and
     a device that wants to listen gets a one-use speech key that lasts a minute, never the real one
   - a device gives the pairing code once before it can see or change anything (the Mac itself needn't)
   - it turns recordings into text: a device sends the file here, and the Mac mini has Soniox transcribe
     it, by itself, so the device can be put away meanwhile
   - it copies every note into a file once a day, and keeps the page up to date from GitHub

   Everything is in ~/AllKnowing (AK_HUB_HOME):
     config.json   port, pairing code and your keys (only you can read it)
     notes/        one JSON file per stored document
     backups/      "AllKnowing notes YYYY-MM-DD.json", one a day, the last 30 days
     recordings/   a folder for each recording while it's turned into text
     app/          the web app's files
     hub/hub.cjs   this file
     logs/hub.log

   The installer (install.sh) sets this up with a LaunchAgent that starts it at login and keeps it running,
   and shares it on your own devices' Tailscale network over HTTPS. */
"use strict";
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const VERSION = "1.2";
// What the page may expect from this hub. A page that needs more waits for the hub to be updated.
// 2: recordings turned into text (/api/transcribe).
// 3: recordings turned into text on this Mac, by free speech models (status.local, engine).
const HUB_API = 3;
const HOME = process.env.AK_HUB_HOME || path.join(os.homedir(), "AllKnowing");
const CONFIG = path.join(HOME, "config.json");
const NOTES = path.join(HOME, "notes");
const BACKUPS = path.join(HOME, "backups");
const APP = path.join(HOME, "app");
const RECORDINGS = path.join(HOME, "recordings");
const ANTHROPIC = (process.env.AK_HUB_ANTHROPIC || "https://api.anthropic.com").replace(/\/+$/, "");
const SONIOX = (process.env.AK_HUB_SONIOX || "https://api.soniox.com").replace(/\/+$/, "");
const SOURCE = (
	process.env.AK_HUB_SOURCE || "https://raw.githubusercontent.com/Godraymond/AllKnowing/gh-pages"
).replace(/\/+$/, "");
// The page keeps one person's notes under data/users/<id>/home. On the Mac mini that person is "owner".
const OWNER = "owner";
const BASE = `data/users/${OWNER}/home`;
const KEEP_BACKUPS = 30;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

/* ---------- settings ---------- */
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
	const b = crypto.randomBytes(12);
	let s = "";
	for (let i = 0; i < 12; i++) s += CODE_LETTERS[b[i] % 32] + (i % 4 === 3 && i < 11 ? "-" : "");
	return s;
}
function writeAtomic(file, text, mode) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
	fs.renameSync(tmp, file);
}
function loadConfig() {
	let c = {};
	try {
		c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
	} catch (e) {
		if (e.code !== "ENOENT")
			log("config.json couldn't be read, starting from defaults:", e.message);
	}
	const cfg = {
		port: Number(process.env.AK_HUB_PORT) || Number(c.port) || 4790,
		// "0.0.0.0" lets other devices at home open it; "127.0.0.1" keeps it to this Mac (and Tailscale).
		host: process.env.AK_HUB_BIND || (typeof c.host === "string" && c.host) || "0.0.0.0",
		code: typeof c.code === "string" && plain(c.code).length >= 8 ? c.code : "",
		claudeKey: typeof c.claudeKey === "string" ? c.claudeKey : "",
		speechKey: typeof c.speechKey === "string" ? c.speechKey : "",
		// Whether Soniox takes more than an hour of audio in one file: found out with the first long
		// recording, and kept (see "recordings" below). null until then.
		longFiles: typeof c.longFiles === "boolean" ? c.longFiles : null,
		// Soniox's model for recordings; empty picks its newest by itself.
		fileModel:
			typeof c.fileModel === "string" && /^[a-z0-9._-]{1,60}$/.test(c.fileModel)
				? c.fileModel
				: "",
		tsName: typeof c.tsName === "string" ? c.tsName : "",
		lanName:
			typeof c.lanName === "string" && /^[a-z0-9-]{1,63}$/.test(c.lanName) ? c.lanName : "",
		autoUpdate: c.autoUpdate !== false,
		// Phones can only reach a Mac that is awake. The screen may still sleep.
		keepAwake: c.keepAwake !== false,
		// Turn recordings into text here, with free speech models (see "on this Mac for free" below).
		localSpeech: c.localSpeech !== false,
	};
	const fresh = !cfg.code;
	if (fresh) cfg.code = newCode();
	return { cfg, fresh, extra: c };
}
const plain = (code) =>
	String(code || "")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
const loaded = loadConfig();
const cfg = loaded.cfg;
function saveConfig() {
	writeAtomic(CONFIG, `${JSON.stringify({ ...loaded.extra, ...cfg }, null, 2)}\n`, 0o600);
	try {
		fs.chmodSync(CONFIG, 0o600);
	} catch {
		/* not ours to change */
	}
}
if (loaded.fresh) saveConfig();

/* ---------- the notes: one JSON file per document, all held in memory as well ----------
   Paths are the page's own: segments of letters, digits, - and _, an even number of them for a
   document (data/users/owner/home) and an odd number for a collection (…/home/meetings). */
const SEG = /^[A-Za-z0-9_-]{1,100}$/;
const docs = new Map(); // path → { data, at }
let lastWriteAt = 0;
function badPath(message) {
	return Object.assign(new Error(message), { status: 400, type: "invalid_request_error" });
}
function checkPath(p, kind) {
	const segs = String(p || "").split("/");
	if (segs.length > 16 || !segs.every((x) => SEG.test(x)))
		throw badPath("That isn't a valid path.");
	if (kind === "doc" && segs.length % 2)
		throw badPath("A document path needs an even number of parts.");
	if (kind === "col" && segs.length % 2 === 0)
		throw badPath("A collection path needs an odd number of parts.");
	return segs.join("/");
}
const fileOf = (p) => `${path.join(NOTES, ...p.split("/"))}.json`;
function loadNotes() {
	let n = 0;
	const walk = (dir, rel) => {
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory() && SEG.test(e.name))
				walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
			else if (e.isFile() && e.name.endsWith(".json") && SEG.test(e.name.slice(0, -5))) {
				const p = rel ? `${rel}/${e.name.slice(0, -5)}` : e.name.slice(0, -5);
				if (p.split("/").length % 2) continue;
				const file = path.join(dir, e.name);
				try {
					docs.set(p, {
						data: JSON.parse(fs.readFileSync(file, "utf8")),
						at: fs.statSync(file).mtimeMs,
					});
					n++;
				} catch (err) {
					log(`Skipped a damaged note file (kept as it is): ${file}: ${err.message}`);
				}
			}
		}
	};
	walk(NOTES, "");
	return n;
}
const watchers = new Set();
function announce(event) {
	const line = `data: ${JSON.stringify(event)}\n\n`;
	for (const res of watchers) res.write(line);
}
function putDoc(p, data) {
	const text = JSON.stringify(data);
	writeAtomic(fileOf(p), text);
	docs.set(p, { data: JSON.parse(text), at: Date.now() });
	lastWriteAt = Date.now();
	announce({ p });
}
function deleteDoc(p) {
	if (!docs.has(p)) return;
	try {
		fs.unlinkSync(fileOf(p));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	docs.delete(p);
	lastWriteAt = Date.now();
	// Tidy away folders that are now empty, up to notes/ itself.
	let dir = path.dirname(fileOf(p));
	while (dir.startsWith(NOTES) && dir !== NOTES) {
		try {
			fs.rmdirSync(dir);
		} catch {
			break;
		}
		dir = path.dirname(dir);
	}
	announce({ p });
}
function listDocs(col, { order, dir, limit }) {
	const prefix = `${col}/`;
	let out = [];
	for (const [p, d] of docs) {
		if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
			out.push({ id: p.slice(prefix.length), data: d.data });
	}
	if (order) {
		const sign = dir === "desc" ? -1 : 1;
		out.sort((a, b) => {
			const av = a.data && a.data[order];
			const bv = b.data && b.data[order];
			return (av > bv ? 1 : av < bv ? -1 : 0) * sign || (a.id < b.id ? -1 : 1);
		});
	} else out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (limit > 0) out = out.slice(0, limit);
	return out;
}

/* ---------- a copy of everything, once a day ----------
   In the same "AllKnowing notes" format the page downloads, so "Bring in notes" can read it anywhere. */
function notesBundle() {
	const meetings = [];
	const todos = [];
	for (const { id, data } of listDocs(`${BASE}/meetings`, {})) {
		if (!data || typeof data !== "object") continue;
		const segs = listDocs(`${BASE}/meetings/${id}/parts`, {}).flatMap((x) =>
			x.data && Array.isArray(x.data.segs) ? x.data.segs : [],
		);
		meetings.push({ ...data, id, segs });
	}
	for (const { data } of listDocs(`${BASE}/todos`, {}))
		if (data && typeof data === "object") todos.push(data);
	const home = docs.get(BASE);
	return {
		kind: "allknowing-notes",
		version: 1,
		exportedAt: Date.now(),
		from: "Saved on your Mac mini",
		meetings,
		todos,
		settings: (home && home.data && home.data.settings) || {},
	};
}
const localDay = (d = new Date()) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const BACKUP_RE = /^AllKnowing notes (\d{4}-\d{2}-\d{2})\.json$/;
function backupList() {
	try {
		return fs
			.readdirSync(BACKUPS)
			.filter((n) => BACKUP_RE.test(n))
			.sort();
	} catch {
		return [];
	}
}
function backupNow() {
	if (!listDocs(`${BASE}/meetings`, {}).length && !listDocs(`${BASE}/todos`, {}).length)
		return null;
	const name = `AllKnowing notes ${localDay()}.json`;
	writeAtomic(path.join(BACKUPS, name), JSON.stringify(notesBundle()), 0o600);
	const all = backupList();
	for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
		try {
			fs.unlinkSync(path.join(BACKUPS, old));
		} catch {
			/* leave it */
		}
	}
	return name;
}
function backupIfDue() {
	if (backupList().includes(`AllKnowing notes ${localDay()}.json`)) return;
	try {
		const name = backupNow();
		if (name) log(`Saved a copy of every note: backups/${name}`);
	} catch (e) {
		log("Couldn't save today's copy of the notes:", e.message);
	}
}

/* ---------- who may ask ---------- */
const codeHash = () => crypto.createHash("sha256").update(plain(cfg.code)).digest();
function givenCode(req) {
	const h = req.headers;
	return String(h["x-api-key"] || String(h.authorization || "").replace(/^Bearer\s+/i, "") || "");
}
const isLoopback = (a) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
// Through Tailscale Serve every request comes from this Mac, so the device's own address is in X-Forwarded-For.
function clientOf(req) {
	const remote = req.socket.remoteAddress || "";
	const fwd = String(req.headers["x-forwarded-for"] || "")
		.split(",")[0]
		.trim();
	return isLoopback(remote) && fwd ? fwd : remote;
}
// This Mac's own browser at http://localhost: no code needed. Tailscale's requests also come from this Mac,
// but they carry its headers and the Mac's Tailscale name, so they don't count.
function fromThisMac(req) {
	if (!isLoopback(req.socket.remoteAddress || "")) return false;
	const h = req.headers;
	if (h["x-forwarded-for"] || h["tailscale-user-login"] || h["tailscale-headers-info"])
		return false;
	const host = String(h.host || "")
		.replace(/:\d+$/, "")
		.toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
const misses = new Map(); // client → { n, since }
function tooManyMisses(who) {
	const m = misses.get(who);
	if (!m) return false;
	if (Date.now() - m.since > 10 * 60000) {
		misses.delete(who);
		return false;
	}
	return m.n >= 12;
}
function authorised(req) {
	if (fromThisMac(req)) return true;
	const who = clientOf(req);
	if (tooManyMisses(who)) return false;
	const given = givenCode(req);
	if (!given) return false;
	const ok = crypto.timingSafeEqual(
		crypto.createHash("sha256").update(plain(given)).digest(),
		codeHash(),
	);
	// Only wrong codes count towards the lock-out, not a device that hasn't been given one yet.
	if (!ok) {
		const m = misses.get(who) || { n: 0, since: Date.now() };
		m.n++;
		misses.set(who, m);
	} else misses.delete(who);
	return ok;
}

/* ---------- replies ---------- */
const SECURITY = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
};
function sendJson(res, status, body) {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, {
		...SECURITY,
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
}
// Errors in the shape the Claude API uses, marked as the Mac mini's own so the page shows them as they are.
const hubError = (type, message) => ({ type: "error", error: { type, message, relay: true } });
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) {
				reject(
					Object.assign(new Error("That's too much to send at once."), { status: 413 }),
				);
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
async function readJson(req, limit = 12 * 1024 * 1024) {
	const buf = await readBody(req, limit);
	try {
		return JSON.parse(buf.toString("utf8") || "{}");
	} catch {
		throw Object.assign(new Error("That wasn't JSON."), { status: 400 });
	}
}

/* ---------- the web app's files ---------- */
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
};
// Tells the page it was served by the Mac mini, so it keeps meetings here and asks Claude through here.
const MARK = '<meta name="allknowing-hub" content="1">';
function appVersion() {
	try {
		return String(
			JSON.parse(fs.readFileSync(path.join(APP, "version.json"), "utf8")).version || "",
		);
	} catch {
		return "";
	}
}
function serveApp(req, res, name) {
	const ext = path.extname(name).toLowerCase();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !TYPES[ext]) return notFound(res);
	const file = path.join(APP, name);
	let body;
	try {
		body = fs.readFileSync(file);
	} catch {
		if (name !== "index.html") return notFound(res);
		res.writeHead(503, {
			...SECURITY,
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(
			"<!doctype html><meta charset=utf-8><title>AllKnowing</title><p style='font:16px system-ui;margin:2em'>AllKnowing is running on this Mac, but the app itself is missing. It fetches it from GitHub by itself; if this stays, run the installer again.</p>",
		);
		ensureApp();
		return;
	}
	if (name === "index.html")
		body = Buffer.from(String(body).replace("<head>", `<head>\n${MARK}`));
	const fresh = name === "index.html" || name === "version.json" || ext === ".webmanifest";
	res.writeHead(200, {
		...SECURITY,
		"content-type": TYPES[ext],
		"cache-control": fresh ? "no-cache" : "public, max-age=3600",
	});
	res.end(req.method === "HEAD" ? undefined : body);
}
function notFound(res) {
	sendJson(res, 404, { error: { type: "not_found", message: "Nothing here." } });
}

/* ---------- Claude, with the key that stays on this Mac ---------- */
async function claudeMessages(req, res) {
	if (!cfg.claudeKey)
		return sendJson(
			res,
			400,
			hubError(
				"authentication_error",
				"Add your Claude API key first: Home → Mac mini → Claude API key.",
			),
		);
	const body = await readBody(req, 32 * 1024 * 1024);
	const headers = {
		"content-type": "application/json",
		"x-api-key": cfg.claudeKey,
		"anthropic-version": String(req.headers["anthropic-version"] || "2023-06-01"),
	};
	if (req.headers["anthropic-beta"])
		headers["anthropic-beta"] = String(req.headers["anthropic-beta"]);
	const ctl = new AbortController();
	res.on("close", () => {
		if (!res.writableFinished) ctl.abort();
	});
	let up;
	try {
		up = await fetch(`${ANTHROPIC}/v1/messages`, {
			method: "POST",
			headers,
			body,
			signal: ctl.signal,
		});
	} catch (e) {
		if (ctl.signal.aborted) return;
		log("Claude couldn't be reached:", e.message);
		return sendJson(
			res,
			502,
			hubError(
				"api_error",
				"The Mac mini couldn't reach Claude. Check the Mac mini's internet connection, then try again.",
			),
		);
	}
	res.writeHead(up.status, {
		...SECURITY,
		"content-type": up.headers.get("content-type") || "application/json",
		"cache-control": "no-store",
	});
	if (!up.body) return res.end();
	const stream = Readable.fromWeb(up.body);
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}

/* ---------- listening: a one-use key, made fresh for each connection ---------- */
async function speechKey(res) {
	if (!cfg.speechKey)
		return sendJson(res, 400, {
			error: {
				type: "no_key",
				message: "Add your Soniox speech key first: Home → Mac mini → Speech key.",
			},
		});
	const ask = (body) =>
		fetch(`${SONIOX}/v1/auth/temporary-api-key`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${cfg.speechKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15000),
		});
	let r;
	try {
		r = await ask({
			usage_type: "transcribe_websocket",
			expires_in_seconds: 60,
			single_use: true,
			max_session_duration_seconds: 18000,
			client_reference_id: "allknowing",
		});
		// An older service that doesn't take the extra settings: ask with just the two it must have.
		if (r.status === 400 || r.status === 422)
			r = await ask({ usage_type: "transcribe_websocket", expires_in_seconds: 60 });
	} catch (e) {
		log("Soniox couldn't be reached:", e.message);
		return sendJson(res, 502, {
			error: {
				type: "unreachable",
				message:
					"The Mac mini couldn't reach the speech service. Check its internet connection.",
			},
		});
	}
	const j = await r.json().catch(() => ({}));
	if (!r.ok || !j.api_key) {
		const said = String(
			(j && (j.message || j.error_message || (j.error && j.error.message))) || "",
		).slice(0, 200);
		const message =
			r.status === 401 || r.status === 403
				? "Soniox refused the speech key saved on the Mac mini. Check it under Home → Mac mini."
				: r.status === 402
					? "Soniox says the account needs credit. Top it up at console.soniox.com."
					: `The speech service said no (${r.status}${said ? `: ${said}` : ""}).`;
		return sendJson(res, r.status === 401 || r.status === 403 ? 400 : 502, {
			error: { type: "refused", message },
		});
	}
	sendJson(res, 200, { api_key: j.api_key, expires_at: j.expires_at || "" });
}

/* ---------- recordings, turned into text by Soniox ----------
   A device sends a recording here a few megabytes at a time (so a phone that drops off can carry on), then
   the Mac mini does the rest by itself: it hands the audio to Soniox with the key it keeps, waits, and
   holds the text until a device takes it. The device can be put away meanwhile.

   How much audio Soniox takes in one file isn't certain: its own pages say an hour in one place and five
   in another. So the Mac mini finds out. The first recording longer than an hour is sent whole; if
   Soniox won't have it, it goes in parts of under an hour instead, and config.json remembers which it
   was (longFiles) for next time.
   Parts overlap by four minutes. In the overlap the same words are heard twice, which shows which voice
   in the next part is which voice already heard, and where a quiet moment makes a clean cut. (A voice
   that says nothing in those minutes can't be matched, and gets a new number afterwards; the result
   says where the joins are, so the page can tell Claude.) MP3, WAV, AAC and the sound in
   MP4, M4A and MOV files are read and cut here with nothing to install. Anything else that's too long is
   first turned into WAV by ffmpeg, if it's installed, or by macOS's own afconvert.

   Each recording has a folder in recordings/ while it's worked on. The audio goes from here and from
   Soniox as soon as the text is back; the text goes once a device has saved it, or after a week.
   The Soniox calls are its file API as its own SDK makes them (@soniox/node 2.5.0): POST /v1/files,
   POST /v1/transcriptions, GET /v1/transcriptions/<id> and …/transcript, DELETE for both. */
const MAX_RECORDING = 2 * 1024 ** 3;
const CHUNK = Number(process.env.AK_HUB_CHUNK_BYTES) || 4 * 1024 * 1024; // what a device sends at a time
const MAX_CHUNK = 16 * 1024 * 1024;
// The most audio in one file: an hour or five, each less a margin (see above).
const SHORT_PART = Number(process.env.AK_HUB_PART_SECONDS) || 57 * 60;
const LONG_PART = Math.max(SHORT_PART, Number(process.env.AK_HUB_LONG_PART_SECONDS) || 295 * 60);
const OVERLAP = Math.min(Number(process.env.AK_HUB_OVERLAP_SECONDS) || 240, SHORT_PART / 3);
const MAX_FILE = 900 * 1000 * 1000; // Soniox takes files up to 1 GB
const POLL_MS = Number(process.env.AK_HUB_POLL_MS) || 3000;
const FILE_MODEL = "stt-async-v6";
const CLAIM_MS = 10 * 60000;
const KEEP_MS = 7 * 864e5;
const AUDIO_EXT = new Set(
	"mp3 m4a mp4 mov m4v 3gp wav aac flac ogg oga opus webm mkv amr wma avi aif aiff caf".split(
		" ",
	),
);
const TOO_LONG =
	"This recording is longer than an hour, and the Mac mini can't cut this kind of file into parts. Save it as MP3 or M4A and import it again.";
const CANT_READ =
	"The Mac mini couldn't read this recording. Save it as MP3 or M4A and import it again.";
const NO_SPEECH_KEY = "Add your Soniox speech key first: Home → Mac mini → Speech key.";
const userError = (message, extra) => Object.assign(new Error(message), { user: message }, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const breathe = () => new Promise((r) => setImmediate(r));

/* Reading a recording: how long it is, and where it can be cut. */
function openFile(file) {
	const fd = fs.openSync(file, "r");
	const size = fs.fstatSync(fd).size;
	return {
		size,
		read(pos, len) {
			const n = Math.max(0, Math.min(len, size - pos));
			const b = Buffer.alloc(n);
			let got = 0;
			while (got < n) {
				const k = fs.readSync(fd, b, got, n - got, pos + got);
				if (!k) break;
				got += k;
			}
			return got < n ? b.subarray(0, got) : b;
		},
		close: () => fs.closeSync(fd),
	};
}
// Reads through a file a megabyte at a time: [buffer, where pos is in it], with `need` bytes there
// unless the file ends first.
function windowed(f, size = 1 << 20) {
	let buf = Buffer.alloc(0);
	let start = 0;
	return (pos, need) => {
		if (pos < start || pos + need > start + buf.length) {
			buf = f.read(pos, Math.max(size, need));
			start = pos;
		}
		return [buf, pos - start];
	};
}
function writeAll(fd, buf) {
	let off = 0;
	while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}
// The first index whose value is at least x.
function lowerBound(list, x, count) {
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (list[mid] < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
// An ID3v2 tag in front of the sound: where it ends.
function id3End(f) {
	const h = f.read(0, 10);
	if (h.length < 10 || h.toString("latin1", 0, 3) !== "ID3") return 0;
	const size =
		((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
	return 10 + size + (h[5] & 0x10 ? 10 : 0);
}
const MP3_HZ = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
// Kilobits a second by the header's bitrate number: MPEG-1 and MPEG-2/2.5, each by layer bits (1 = III).
const MP3_V2_III = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_V1 = [
	null,
	[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
	[0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
	[0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
];
const MP3_V2 = [
	null,
	MP3_V2_III,
	MP3_V2_III,
	[0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
];
// An MP3 (MPEG audio) frame header at b[i]: the frame's length in bytes, its samples and their rate.
function mp3Head(b, i) {
	if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
	const ver = (b[i + 1] >> 3) & 3;
	const layer = (b[i + 1] >> 1) & 3;
	const rate = b[i + 2] >> 4;
	const hzIndex = (b[i + 2] >> 2) & 3;
	if (ver === 1 || layer === 0 || rate === 0 || rate === 15 || hzIndex === 3) return null;
	const v1 = ver === 3;
	const hz = MP3_HZ[ver][hzIndex];
	const pad = (b[i + 2] >> 1) & 1;
	const kbps = (v1 ? MP3_V1 : MP3_V2)[layer][rate];
	const samples = layer === 3 ? 384 : layer === 2 || v1 ? 1152 : 576;
	const len =
		layer === 3
			? (Math.floor((12000 * kbps) / hz) + pad) * 4
			: Math.floor((samples * 125 * kbps) / hz) + pad;
	return { len, samples, hz, key: ((b[i + 1] & 0xfe) << 8) | hzIndex };
}
const ADTS_HZ = [
	96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
// The same for a frame of plain AAC (ADTS).
function adtsHead(b, i) {
	if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null;
	const hzIndex = (b[i + 2] >> 2) & 15;
	const len = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
	if (hzIndex > 12 || len < 7) return null;
	return {
		len,
		samples: 1024 * ((b[i + 6] & 3) + 1),
		hz: ADTS_HZ[hzIndex],
		key: b[i + 2] & 0xfc,
	};
}
// After something that isn't a frame: the next place where two frames in a row agree, within a megabyte.
function nextFrame(f, view, head, from, key) {
	const limit = Math.min(f.size, from + (1 << 20));
	let p = from;
	while (p + 4 <= limit) {
		const [b, i] = view(p, 65536);
		const at = b.indexOf(0xff, i);
		if (at < 0) {
			p += Math.max(1, b.length - i - 3);
			continue;
		}
		const q = p + (at - i);
		const [b2, i2] = view(q, 8200);
		const h = head(b2, i2);
		if (h && (key < 0 || h.key === key)) {
			const next = head(b2, i2 + h.len);
			if (next && next.key === h.key) return q;
		}
		p = q + 1;
	}
	return -1;
}
// Every frame of an MP3 or AAC stream: where each starts in the file and when, read straight through.
async function scanFrames(f, head, mp3) {
	const view = windowed(f);
	const offs = [];
	const times = [];
	let pos = id3End(f);
	let t = 0;
	let key = -1;
	while (pos + 4 <= f.size) {
		const [b, i] = view(pos, 8200);
		const h = head(b, i);
		let good = !!h && (key < 0 || h.key === key);
		if (good) {
			// A frame counts when another like it follows, or when it ends the sound; one alone may be noise.
			const next = head(b, i + h.len);
			if (next) good = next.key === h.key;
			else good = offs.length > 0 && f.size - (pos + h.len) < 131072;
		}
		if (good) {
			key = h.key;
			offs.push(pos);
			times.push(t);
			t += h.samples / h.hz;
			pos += h.len;
			if (offs.length % 20000 === 0) await breathe();
			continue;
		}
		const found = nextFrame(f, view, head, pos + 1, key);
		if (found < 0) break;
		pos = found;
	}
	// Many MP3s start with a frame that is only a table of contents ("Xing", "Info", "VBRI"), not sound.
	if (mp3 && offs.length > 1) {
		const first = f.read(offs[0], Math.min(offs[1] - offs[0], 64)).toString("latin1");
		if (/Xing|Info|VBRI/.test(first.slice(4))) {
			const d = times[1];
			offs.shift();
			times.shift();
			for (let k = 0; k < times.length; k++) times[k] -= d;
			t -= d;
		}
	}
	return { offs, times, count: offs.length, end: Math.min(pos, f.size), duration: t };
}
function wavInfo(f) {
	const h = f.read(0, 12);
	if (h.length < 12 || h.toString("latin1", 0, 4) !== "RIFF") return null;
	if (h.toString("latin1", 8, 12) !== "WAVE") return null;
	let pos = 12;
	let fmt = null;
	while (pos + 8 <= f.size) {
		const c = f.read(pos, 8);
		const id = c.toString("latin1", 0, 4);
		let len = c.readUInt32LE(4);
		if (id === "fmt ") {
			if (len < 16 || len > 4096 || pos + 8 + len > f.size) return null;
			// Kept whole, to go in front of each part as it is.
			fmt = Buffer.concat([f.read(pos, 8 + len), Buffer.alloc(len & 1)]);
		} else if (id === "data") {
			if (!fmt) return null;
			const at = pos + 8;
			if (!len || len === 0xffffffff || at + len > f.size) len = f.size - at;
			const byteRate = fmt.readUInt32LE(16);
			const align = fmt.readUInt16LE(20);
			if (!byteRate || !align) return null;
			len -= len % align;
			return {
				kind: "wav",
				fmt,
				dataAt: at,
				dataLen: len,
				byteRate,
				align,
				duration: len / byteRate,
			};
		}
		pos += 8 + len + (len & 1);
	}
	return null;
}
// The boxes of an MP4 (ISO base media) file between two offsets: type, where the insides start, the end.
function mp4Boxes(read, start, end) {
	const out = [];
	let pos = start;
	while (pos + 8 <= end) {
		const h = read(pos, 16);
		if (h.length < 8) break;
		let size = h.readUInt32BE(0);
		let body = pos + 8;
		if (size === 1) {
			if (h.length < 16) break;
			size = Number(h.readBigUInt64BE(8));
			body = pos + 16;
		} else if (size === 0) size = end - pos;
		if (size < body - pos) break;
		out.push({ type: h.toString("latin1", 4, 8), body, end: Math.min(end, pos + size) });
		pos += size;
	}
	return out;
}
// The elementary stream descriptor of an MP4 sound track: which codec, and its own setup bytes.
function esdsInfo(buf, start, end) {
	let p = start + 4;
	const descriptor = () => {
		if (p + 2 > end) return null;
		const tag = buf[p++];
		let len = 0;
		for (let k = 0; k < 4 && p < end; k++) {
			const c = buf[p++];
			len = (len << 7) | (c & 0x7f);
			if (!(c & 0x80)) break;
		}
		return { tag, len, at: p };
	};
	const es = descriptor();
	if (!es || es.tag !== 3) return null;
	p = es.at + 2;
	const flags = buf[p++];
	if (flags & 0x80) p += 2;
	if (flags & 0x40) p += 1 + buf[p];
	if (flags & 0x20) p += 2;
	const dec = descriptor();
	if (!dec || dec.tag !== 4 || dec.at + 13 > end) return null;
	const kind = buf[dec.at];
	p = dec.at + 13;
	const own = descriptor();
	const setup =
		own && own.tag === 5 && own.at + own.len <= end
			? buf.subarray(own.at, own.at + own.len)
			: null;
	return { kind, setup };
}
// What an ADTS header needs from AAC's setup bytes (an MPEG-4 AudioSpecificConfig), plain or HE-AAC.
function adtsConfig(setup) {
	if (!setup || setup.length < 2) return null;
	let bit = 0;
	const get = (n) => {
		let v = 0;
		for (let k = 0; k < n; k++, bit++)
			v = (v << 1) | ((setup[bit >> 3] >> (7 - (bit & 7))) & 1);
		return v;
	};
	const objectType = () => {
		const x = get(5);
		return x === 31 ? 32 + get(6) : x;
	};
	let type = objectType();
	const hzIndex = get(4);
	if (hzIndex === 15) return null;
	const channels = get(4);
	// HE-AAC says so first, then names the plain AAC underneath, which is what ADTS carries.
	if (type === 5 || type === 29) {
		if (get(4) === 15) get(24);
		type = objectType();
	}
	if (type < 1 || type > 4 || hzIndex > 12 || channels < 1 || channels > 7) return null;
	return { profile: type - 1, hzIndex, channels };
}
function adtsHeader(c, payload) {
	const len = payload + 7;
	return Buffer.from([
		0xff,
		0xf1,
		(c.profile << 6) | (c.hzIndex << 2) | (c.channels >> 2),
		((c.channels & 3) << 6) | (len >> 11),
		(len >> 3) & 0xff,
		((len & 7) << 5) | 0x1f,
		0xfc,
	]);
}
// What the sound in an MP4 is, and whether its frames can be written out as plain AAC or MP3.
function mp4Codec(buf, read, stsd) {
	const entry = mp4Boxes(read, stsd.body + 8, stsd.end)[0];
	if (!entry || entry.body + 28 > entry.end) return { name: "?" };
	if (entry.type === ".mp3") return { name: "mp3", raw: true };
	if (entry.type !== "mp4a") return { name: entry.type.trim() };
	// A sound entry: 8 bytes, then 20 more (QuickTime's versions 1 and 2 add 16 or 36), then its own
	// boxes. QuickTime's .mov keeps the descriptor inside a "wave" box.
	const version = buf.readUInt16BE(entry.body + 8);
	const from = entry.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
	const inside = mp4Boxes(read, from, entry.end);
	let esds = inside.find((x) => x.type === "esds");
	const wave = inside.find((x) => x.type === "wave");
	if (!esds && wave) esds = mp4Boxes(read, wave.body, wave.end).find((x) => x.type === "esds");
	const es = esds ? esdsInfo(buf, esds.body, esds.end) : null;
	if (!es) return { name: "mp4a" };
	if (es.kind === 0x69 || es.kind === 0x6b) return { name: "mp3", raw: true };
	if (![0x40, 0x66, 0x67, 0x68].includes(es.kind))
		return { name: `mp4a.${es.kind.toString(16)}` };
	const adts = adtsConfig(es.setup);
	return adts ? { name: "aac", adts } : { name: "aac (not plain)" };
}
const MP4_TOP = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "uuid", "meta"]);
// An MP4, M4A or MOV: its first sound track, every sample's place in the file, size and time.
function mp4Info(f) {
	const top = mp4Boxes((p, n) => f.read(p, n), 0, f.size);
	const moovBox = top.find((x) => x.type === "moov");
	if (!moovBox || moovBox.end - moovBox.body > 256 * 1024 * 1024) return null;
	const buf = f.read(moovBox.body, moovBox.end - moovBox.body);
	const read = (p, n) => buf.subarray(p, Math.min(buf.length, p + n));
	const kids = (box) => (box ? mp4Boxes(read, box.body, box.end) : []);
	const kid = (box, type) => kids(box).find((x) => x.type === type);
	let hasVideo = false;
	const sound = [];
	for (const trak of kids({ body: 0, end: buf.length })) {
		if (trak.type !== "trak") continue;
		const mdia = kid(trak, "mdia");
		const hdlr = kid(mdia, "hdlr");
		if (!hdlr || hdlr.body + 12 > hdlr.end) continue;
		const handler = buf.toString("latin1", hdlr.body + 8, hdlr.body + 12);
		if (handler === "vide") hasVideo = true;
		const tkhd = kid(trak, "tkhd");
		if (handler === "soun") sound.push({ mdia, on: !tkhd || !!(buf[tkhd.body + 3] & 1) });
	}
	if (!sound.length) return { kind: "mp4", hasVideo, silent: true, duration: 0 };
	// The first sound track that's switched on (or, if none says it is, simply the first).
	const track = (sound.find((x) => x.on) || sound[0]).mdia;
	const mdhd = kid(track, "mdhd");
	const stbl = kid(kid(track, "minf"), "stbl");
	if (!mdhd || !stbl) return null;
	const scale = buf.readUInt32BE(mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12));
	const t = {};
	for (const x of kids(stbl)) t[x.type] = x;
	const stsz = t.stsz || t.stz2;
	const stco = t.stco || t.co64;
	if (!scale || !t.stsd || !t.stts || !t.stsc || !stsz || !stco) return null;
	const codec = mp4Codec(buf, read, t.stsd);
	const total = buf.readUInt32BE(stsz.body + 8);
	// Sound that can't be cut here (or, as plain PCM in a .mov, has millions of tiny samples): only its
	// length is wanted, which the track says itself.
	if (!(codec.adts || codec.raw) || total > 4e6) {
		const v1 = buf[mdhd.body] === 1;
		const ticks = v1
			? Number(buf.readBigUInt64BE(mdhd.body + 24))
			: buf.readUInt32BE(mdhd.body + 16);
		const known = ticks > 0 && ticks < (v1 ? 2 ** 53 : 0xffffffff);
		return {
			kind: "mp4",
			hasVideo,
			codec: { name: codec.name },
			duration: known ? ticks / scale : 0,
		};
	}
	// Sizes. None listed means the samples are described piece by piece elsewhere (a "fragmented" file).
	if (!total) return null;
	const sizes = new Uint32Array(total);
	if (stsz === t.stsz) {
		const fixed = buf.readUInt32BE(stsz.body + 4);
		if (!fixed && stsz.body + 12 + 4 * total > stsz.end) return null;
		for (let k = 0; k < total; k++)
			sizes[k] = fixed || buf.readUInt32BE(stsz.body + 12 + 4 * k);
	} else {
		const bits = buf[stsz.body + 7];
		const at = stsz.body + 12;
		if (![4, 8, 16].includes(bits) || at + Math.ceil((bits * total) / 8) > stsz.end)
			return null;
		for (let k = 0; k < total; k++)
			sizes[k] =
				bits === 16
					? buf.readUInt16BE(at + 2 * k)
					: bits === 8
						? buf[at + k]
						: (buf[at + (k >> 1)] >> (k & 1 ? 0 : 4)) & 15;
	}
	// Where each sample is: samples sit in chunks, and the file lists where each chunk starts.
	const wide = stco === t.co64;
	const chunks = buf.readUInt32BE(stco.body + 4);
	if (stco.body + 8 + chunks * (wide ? 8 : 4) > stco.end) return null;
	const chunkAt = (c) =>
		wide
			? Number(buf.readBigUInt64BE(stco.body + 8 + 8 * c))
			: buf.readUInt32BE(stco.body + 8 + 4 * c);
	const runs = buf.readUInt32BE(t.stsc.body + 4);
	if (!runs || t.stsc.body + 8 + 12 * runs > t.stsc.end) return null;
	const offs = new Float64Array(total);
	let s = 0;
	for (let r = 0; r < runs && s < total; r++) {
		const first = buf.readUInt32BE(t.stsc.body + 8 + 12 * r);
		const per = buf.readUInt32BE(t.stsc.body + 12 + 12 * r);
		const last = r + 1 < runs ? buf.readUInt32BE(t.stsc.body + 8 + 12 * (r + 1)) - 1 : chunks;
		for (let c = Math.max(1, first); c <= Math.min(last, chunks) && s < total; c++) {
			let at = chunkAt(c - 1);
			for (let k = 0; k < per && s < total; k++) {
				offs[s] = at;
				at += sizes[s++];
			}
		}
	}
	if (s < total) return null;
	// When each sample starts.
	const entries = buf.readUInt32BE(t.stts.body + 4);
	if (t.stts.body + 8 + 8 * entries > t.stts.end) return null;
	const times = new Float64Array(total + 1);
	let tick = 0;
	let delta = 0;
	s = 0;
	for (let r = 0; r < entries && s < total; r++) {
		const n = buf.readUInt32BE(t.stts.body + 8 + 8 * r);
		delta = buf.readUInt32BE(t.stts.body + 12 + 8 * r);
		for (let k = 0; k < n && s < total; k++) {
			times[s++] = tick / scale;
			tick += delta;
		}
	}
	while (s < total) {
		times[s++] = tick / scale;
		tick += delta;
	}
	times[total] = tick / scale;
	// A file that was cut short: only the samples that are really there.
	let count = total;
	while (count > 0 && offs[count - 1] + sizes[count - 1] > f.size) count--;
	if (!count) return null;
	let biggest = 0;
	for (let k = 0; k < count; k++) if (sizes[k] > biggest) biggest = sizes[k];
	if (codec.adts && biggest > 8184) codec.adts = null; // more than an ADTS frame can hold
	return { kind: "mp4", hasVideo, codec, sizes, offs, times, count, duration: times[count] };
}
// What kind of recording a file is, how long it lasts, and the makings of cutting it.
async function probeRecording(file, ext) {
	const f = openFile(file);
	try {
		const h = f.read(0, 12);
		if (h.length < 12) return null;
		if (h.toString("latin1", 0, 4) === "RIFF") return wavInfo(f);
		if (MP4_TOP.has(h.toString("latin1", 4, 8))) return mp4Info(f);
		const first = f.read(id3End(f), 16);
		if (adtsHead(first, 0)) return { kind: "aac", ...(await scanFrames(f, adtsHead, false)) };
		if (!mp3Head(first, 0) && ext !== "mp3") return null;
		const mp3 = await scanFrames(f, mp3Head, true);
		return mp3.count >= 8 ? { kind: "mp3", ...mp3 } : null;
	} finally {
		f.close();
	}
}

/* Cutting it into the parts Soniox gets. */
// The parts for a recording this long, in seconds, none longer than `most`: one, or several that overlap.
function partRanges(duration, most) {
	if (duration <= most) return [[0, duration]];
	const out = [];
	for (let s = 0; ; s += most - OVERLAP) {
		const e = Math.min(duration, s + most);
		out.push([s, e]);
		if (e >= duration) return out;
	}
}
// The frames (or samples) that cover a stretch of time: from the one playing at s up to the one at e.
function span(times, count, s, e) {
	let a = lowerBound(times, s, count);
	if (a >= count || times[a] > s) a = Math.max(0, a - 1);
	return [a, Math.min(count, Math.max(a + 1, lowerBound(times, e, count)))];
}
async function cutFrames(src, info, s, e, dest) {
	const [a, b] = span(info.times, info.count, s, e);
	const from = info.offs[a];
	const to = b < info.count ? info.offs[b] : info.end;
	if (!(to > from)) return null;
	await pipeline(
		fs.createReadStream(src, { start: from, end: to - 1 }),
		fs.createWriteStream(dest, { mode: 0o600 }),
	);
	return { start: info.times[a], end: b < info.count ? info.times[b] : info.duration };
}
async function cutWav(src, w, s, e, dest) {
	const a = Math.floor((s * w.byteRate) / w.align) * w.align;
	const b = Math.min(w.dataLen, Math.ceil((e * w.byteRate) / w.align) * w.align);
	const len = b - a;
	if (!(len > 0)) return null;
	const head = Buffer.alloc(12);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(4 + w.fmt.length + 8 + len + (len & 1), 4);
	head.write("WAVE", 8, "latin1");
	const data = Buffer.alloc(8);
	data.write("data", 0, "latin1");
	data.writeUInt32LE(len, 4);
	fs.writeFileSync(dest, Buffer.concat([head, w.fmt, data]), { mode: 0o600 });
	await pipeline(
		fs.createReadStream(src, { start: w.dataAt + a, end: w.dataAt + b - 1 }),
		fs.createWriteStream(dest, { flags: "a" }),
	);
	if (len & 1) fs.appendFileSync(dest, Buffer.alloc(1));
	return { start: a / w.byteRate, end: b / w.byteRate };
}
// The sound of an MP4 between two times, written out as a plain AAC (ADTS) or MP3 file.
async function cutSamples(f, info, s, e, dest) {
	const [a, b] = span(info.times, info.count, s, e);
	const fd = fs.openSync(dest, "w", 0o600);
	try {
		const out = [];
		let held = 0;
		let i = a;
		while (i < b) {
			// Samples that sit side by side in the file come in one read.
			let end = info.offs[i] + info.sizes[i];
			let j = i + 1;
			while (j < b && info.offs[j] === end && end - info.offs[i] < 1 << 22)
				end += info.sizes[j++];
			const data = f.read(info.offs[i], end - info.offs[i]);
			let p = 0;
			for (let k = i; k < j; k++) {
				const size = info.sizes[k];
				if (info.codec.adts) out.push(adtsHeader(info.codec.adts, size));
				out.push(data.subarray(p, p + size));
				p += size;
				held += size + 7;
			}
			i = j;
			if (held > 1 << 20) {
				writeAll(fd, Buffer.concat(out));
				out.length = 0;
				held = 0;
				await breathe();
			}
		}
		if (out.length) writeAll(fd, Buffer.concat(out));
	} finally {
		fs.closeSync(fd);
	}
	return { start: info.times[a], end: info.times[b] };
}
async function cutParts(src, info, ranges, dir) {
	const raw = info.kind === "mp3" || (info.kind === "mp4" && info.codec.raw);
	const ext = info.kind === "wav" ? ".wav" : raw ? ".mp3" : ".aac";
	const parts = [];
	const f = openFile(src);
	try {
		for (const [s, e] of ranges) {
			const file = `part-${parts.length + 1}${ext}`;
			const dest = path.join(dir, file);
			const got =
				info.kind === "wav"
					? await cutWav(src, info, s, e, dest)
					: info.kind === "mp4"
						? await cutSamples(f, info, s, e, dest)
						: await cutFrames(src, info, s, e, dest);
			if (got) parts.push({ file, start: got.start, end: got.end });
		}
	} finally {
		f.close();
	}
	return parts;
}
function findTool(name) {
	const dirs = String(process.env.PATH || "")
		.split(path.delimiter)
		.concat(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]);
	for (const dir of dirs) {
		if (!dir) continue;
		const p = path.join(dir, name);
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return p;
		} catch {
			/* not here */
		}
	}
	return "";
}
// What can turn other kinds of recording into WAV here: ffmpeg if it's installed, else macOS's afconvert.
function converter() {
	const e = process.env;
	const ffmpeg = e.AK_HUB_FFMPEG !== undefined ? e.AK_HUB_FFMPEG : findTool("ffmpeg");
	if (ffmpeg) return { kind: "ffmpeg", bin: ffmpeg };
	const mac = process.platform === "darwin";
	const af =
		e.AK_HUB_AFCONVERT !== undefined ? e.AK_HUB_AFCONVERT : mac ? findTool("afconvert") : "";
	if (!af) return null;
	return { kind: "afconvert", bin: af, info: e.AK_HUB_AFINFO || findTool("afinfo") };
}
function run(bin, args, timeoutMs) {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let p;
		try {
			p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			resolve({ code: -1, out, err: e.message });
			return;
		}
		const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
		p.stdout.on("data", (d) => {
			if (out.length < 65536) out += d;
		});
		p.stderr.on("data", (d) => {
			if (err.length < 65536) err += d;
		});
		p.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: -1, out, err: e.message });
		});
		p.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err });
		});
	});
}
async function toolSeconds(tool, file) {
	if (tool.kind === "ffmpeg") {
		const r = await run(tool.bin, ["-hide_banner", "-nostdin", "-i", file], 60000);
		const m = r.err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
		return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
	}
	if (!tool.info) return 0;
	const r = await run(tool.info, [file], 60000);
	const m = r.out.match(/estimated duration:\s*([\d.]+)/i);
	return m ? Number(m[1]) : 0;
}
// Speech only needs one channel at 16 kHz, which keeps the WAV small.
async function toWav(tool, src, dest) {
	const args =
		tool.kind === "ffmpeg"
			? [
					"-hide_banner",
					"-nostdin",
					"-loglevel",
					"error",
					"-y",
					"-i",
					src,
					"-vn",
					"-ac",
					"1",
					"-ar",
					"16000",
					"-c:a",
					"pcm_s16le",
					"-f",
					"wav",
					dest,
				]
			: ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, dest];
	const r = await run(tool.bin, args, 3 * 3600000);
	let size = 0;
	try {
		size = fs.statSync(dest).size;
	} catch {
		/* nothing was written */
	}
	if (r.code !== 0 || size <= 44) {
		log(`${tool.kind} couldn't read a recording: ${(r.err || r.out).trim().slice(-300)}`);
		throw userError(CANT_READ);
	}
}
// The files Soniox gets for a recording, none longer than `most` seconds: [{ file, start, end }], in
// seconds into the recording.
async function makeParts(job, most) {
	const dir = jobDir(job.id);
	const src = path.join(dir, job.audio);
	let info = null;
	try {
		info = await probeRecording(src, job.ext);
	} catch (e) {
		log(`Couldn't read a recording here (${job.ext}): ${e.message}`);
	}
	if (info && info.silent) throw userError("There's no sound in this file.");
	const whole = (seconds) => [{ file: job.audio, start: 0, end: seconds || 0 }];
	if (info && info.duration > 0) {
		job.duration = info.duration;
		// A WAV is big: its parts also have to stay under the size Soniox takes.
		const fits =
			info.kind === "wav" ? Math.max(60, Math.floor(MAX_FILE / info.byteRate)) : most;
		const ranges = partRanges(info.duration, Math.min(most, fits));
		const canCut = info.kind !== "mp4" || !!(info.codec.adts || info.codec.raw);
		// Sound that fits goes as it is. A video goes as its sound only, a fraction of the size.
		if (ranges.length === 1 && !(info.kind === "mp4" && info.hasVideo && canCut))
			return whole(info.duration);
		if (canCut) return cutParts(src, info, ranges, dir);
		if (ranges.length === 1) return whole(info.duration);
	}
	// A kind of file that can't be read or cut here: a converter makes a WAV of it, which can.
	const tool = converter();
	if (!tool) {
		if (info && info.duration > most) throw userError(TOO_LONG);
		return whole(info ? info.duration : 0);
	}
	if (!info || !info.duration) {
		const seconds = await toolSeconds(tool, src);
		if (seconds > 0 && seconds <= most) {
			job.duration = seconds;
			return whole(seconds);
		}
	}
	const wav = path.join(dir, "converted.wav");
	await toWav(tool, src, wav);
	const f = openFile(wav);
	let w = null;
	try {
		w = wavInfo(f);
	} finally {
		f.close();
	}
	if (!w || !w.duration) throw userError(CANT_READ);
	job.duration = w.duration;
	return cutParts(wav, w, partRanges(w.duration, most), dir);
}

/* Soniox. */
function sonioxFail(status, j) {
	const said = String(
		(j && (j.message || j.error_message || (j.error && j.error.message))) || "",
	).slice(0, 300);
	const user =
		status === 401 || status === 403
			? "Soniox turned down the speech key saved on the Mac mini. Check it under Home → Mac mini."
			: status === 402
				? "Soniox says the account needs credit. Top it up at console.soniox.com, then try again."
				: /duration|too long|exceed/i.test(said)
					? TOO_LONG
					: status === 429 || status >= 500
						? `Soniox is busy or having trouble (${status}). Try again in a while.`
						: `Soniox couldn't take this recording (${status}${said ? `: ${said}` : ""}).`;
	return Object.assign(new Error(`Soniox answered ${status}${said ? `: ${said}` : ""}`), {
		user,
		status,
		retry: status === 429 || status >= 500,
		// Said no to this file as it is (not to the key, the account or the moment).
		refused: status === 400 || status === 413 || status === 422,
	});
}
// Not reached: worth another try, and what Soniox already has is worth keeping for it.
const unreachable = () =>
	userError(
		"The Mac mini couldn't reach Soniox. Check its internet connection, then try again.",
		{ retry: true, keep: true },
	);
// One call to Soniox, with the key that stays on this Mac.
async function soniox(method, route, body, signal) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), 120000);
	const stop = () => ctl.abort();
	if (signal) signal.addEventListener("abort", stop, { once: true });
	let r;
	let text = "";
	try {
		r = await fetch(`${SONIOX}${route}`, {
			method,
			headers: {
				authorization: `Bearer ${cfg.speechKey}`,
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: ctl.signal,
		});
		text = await r.text();
	} catch {
		throw unreachable();
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", stop);
	}
	let j = {};
	try {
		j = text ? JSON.parse(text) : {};
	} catch {
		/* not JSON */
	}
	if (!r.ok) throw sonioxFail(r.status, j);
	return j;
}
// Sends one file to Soniox (POST /v1/files, as a form), straight from the disk.
function sonioxUpload(file, name, signal) {
	return new Promise((resolve, reject) => {
		const lost = () =>
			userError("The Mac mini no longer has this recording's audio. Import it again.");
		let size = 0;
		try {
			size = fs.statSync(file).size;
		} catch {
			reject(lost());
			return;
		}
		const boundary = `allknowing-${crypto.randomBytes(12).toString("hex")}`;
		const head = Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
		);
		const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
		const url = new URL(`${SONIOX}/v1/files`);
		let unread = false;
		const req = (url.protocol === "https:" ? https : http).request(
			url,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${cfg.speechKey}`,
					"content-type": `multipart/form-data; boundary=${boundary}`,
					"content-length": head.length + size + tail.length,
				},
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (c) => {
					if (text.length < 1e6) text += c;
				});
				res.on("end", () => {
					let j = {};
					try {
						j = text ? JSON.parse(text) : {};
					} catch {
						/* not JSON */
					}
					if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
					else reject(sonioxFail(res.statusCode, j));
				});
				res.on("error", () => reject(unreachable()));
			},
		);
		const stop = () => req.destroy();
		if (signal) signal.addEventListener("abort", stop, { once: true });
		req.setTimeout(5 * 60000, () => req.destroy());
		req.on("error", () => reject(unread ? lost() : unreachable()));
		req.on("close", () => {
			if (signal) signal.removeEventListener("abort", stop);
		});
		req.write(head);
		const from = fs.createReadStream(file);
		from.on("error", () => {
			unread = true;
			req.destroy();
		});
		from.on("end", () => req.end(tail));
		from.pipe(req, { end: false });
	});
}
let modelChoice = { at: 0, model: "" };
// The model for recordings: Soniox's newest that isn't a preview, or failing that the one its SDK names.
async function fileModel(signal) {
	if (cfg.fileModel) return cfg.fileModel;
	if (modelChoice.model && Date.now() - modelChoice.at < 864e5) return modelChoice.model;
	let model = FILE_MODEL;
	try {
		const j = await soniox("GET", "/v1/models", null, signal);
		const list = (Array.isArray(j.models) ? j.models : []).filter(
			(x) => x && x.transcription_mode === "async" && typeof x.id === "string",
		);
		// The main line is named stt-async-v<number>: the highest of those. Only if there is none, and the
		// one the SDK names has gone too, anything else that isn't a preview or another name for one.
		const version = (id) => Number((id.match(/-v(\d+)/) || [])[1]) || 0;
		const newest = (items) => items.sort((a, b) => version(b.id) - version(a.id))[0];
		const main = newest(list.filter((x) => /^stt-async-v\d+$/.test(x.id)));
		const other = newest(
			list.filter((x) => !x.aliased_model_id && !/preview|beta|exp/i.test(x.id)),
		);
		if (main) model = main.id;
		else if (other && !list.some((x) => x.id === model)) model = other.id;
	} catch (e) {
		if (e.status === 401 || e.status === 403 || e.status === 402) throw e;
		log(`Couldn't ask Soniox which models it has (${e.message}); using ${model}.`);
		return model;
	}
	modelChoice = { at: Date.now(), model };
	return model;
}
async function startTranscription(job, part, model, signal) {
	const body = { model, file_id: part.fileId, enable_speaker_diarization: true };
	if (job.hints.length) body.language_hints = job.hints;
	const context = {};
	if (job.topic) context.general = [{ key: "topic", value: job.topic }];
	if (job.terms.length) context.terms = job.terms;
	const extras = { client_reference_id: `allknowing-${job.id}-${part.i + 1}` };
	if (Object.keys(context).length) extras.context = context;
	try {
		return await soniox("POST", "/v1/transcriptions", { ...body, ...extras }, signal);
	} catch (e) {
		// A model that doesn't take the extras: once more with only what it must have.
		if (e.status !== 400 && e.status !== 422) throw e;
		return soniox("POST", "/v1/transcriptions", body, signal);
	}
}
// Tries again when Soniox is busy or can't be reached: after 2, 4, 8… seconds, six times in all.
async function patiently(job, fn) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (e) {
			if (stopped(job) || !e.retry || attempt >= 5) throw e;
			log(`Soniox: ${e.message} Trying again.`);
			await sleep((Number(process.env.AK_HUB_RETRY_MS) || 2000) * 2 ** attempt);
		}
	}
}
// Waits for Soniox to finish one part, then fetches its words: [start ms, end ms, voice, text].
// Soniox also says how long the audio was, which is the only word on that for a file not read here.
async function waitForWords(job, part, signal) {
	const since = Date.now();
	let ms = 0;
	for (;;) {
		if (stopped(job)) throw userError("Stopped.");
		const st = await patiently(job, () =>
			soniox("GET", `/v1/transcriptions/${part.txId}`, null, signal),
		);
		ms = Number(st.audio_duration_ms) || ms;
		if (st.status === "completed") break;
		if (st.status === "error") {
			const said = String(st.error_message || "").slice(0, 200);
			throw Object.assign(
				userError(
					/duration|too long|exceed/i.test(said)
						? TOO_LONG
						: `Soniox couldn't turn this recording into text${said ? `: ${said}` : "."}`,
					{ refused: true },
				),
				{ message: `Soniox couldn't transcribe it: ${said || "no reason given"}` },
			);
		}
		if (Date.now() - since > 6 * 3600000)
			throw userError("Soniox is taking too long with this recording. Try again later.");
		await sleep(Date.now() - since < 120000 ? POLL_MS : POLL_MS * 3);
	}
	const got = await patiently(job, () =>
		soniox("GET", `/v1/transcriptions/${part.txId}/transcript`, null, signal),
	);
	const words = [];
	for (const t of Array.isArray(got.tokens) ? got.tokens : []) {
		if (!t || typeof t.text !== "string" || !t.text) continue;
		if (t.is_audio_event || t.translation_status === "translation") continue;
		const start = Number(t.start_ms) || 0;
		words.push([
			start,
			Number(t.end_ms) || start,
			t.speaker === null || t.speaker === undefined ? "" : String(t.speaker),
			t.text,
		]);
	}
	if (!(part.end > part.start)) {
		const last = words.length ? words[words.length - 1][1] : 0;
		part.end = part.start + Math.max(ms, last) / 1000;
	}
	return words;
}
// Soniox keeps a file and its transcription until told otherwise: this tells it.
async function forgetAtSoniox(part) {
	for (const [kind, id] of [
		["transcriptions", part.txId],
		["files", part.fileId],
	]) {
		if (!id) continue;
		try {
			await soniox("DELETE", `/v1/${kind}/${id}`);
		} catch (e) {
			if (e.status !== 404) log(`Couldn't delete ${kind}/${id} at Soniox: ${e.message}`);
		}
	}
	part.txId = "";
	part.fileId = "";
}

/* Putting the parts' words back together. */
// The word being said at a moment (give or take a quarter of a second), from a list in time order.
function wordAt(list, ms) {
	let lo = 0;
	let hi = list.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (list[mid].s <= ms) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	if (found >= 0 && list[found].e + 250 >= ms) return list[found];
	const after = list[found + 1];
	return after && after.s - 250 <= ms ? after : null;
}
// Where to change from one part to the next: the longest pause in the middle half of their overlap.
function quietCut(words, lo, hi) {
	const from = lo + (hi - lo) / 4;
	const to = hi - (hi - lo) / 4;
	let cut = (lo + hi) / 2;
	let longest = -1;
	for (let k = 1; k < words.length; k++) {
		const a = words[k - 1].e;
		const b = words[k].s;
		if (b < from || a > to || b - a <= longest) continue;
		longest = b - a;
		cut = Math.min(to, Math.max(from, (a + b) / 2));
	}
	return cut;
}
// Every part's words as one transcript, with each voice numbered for the whole recording.
function stitch(parts) {
	const all = [];
	const joins = [];
	let voices = 0;
	let before = null;
	for (const part of parts) {
		const off = part.start * 1000;
		const words = part.words
			.map(([s, e, voice, text]) => ({
				s: off + s,
				e: off + Math.max(s, e),
				voice,
				text,
				v: 0,
			}))
			.sort((a, b) => a.s - b.s);
		const ids = new Map();
		let cut = Number.NEGATIVE_INFINITY;
		if (before) {
			const lo = off;
			const hi = before.end;
			cut = quietCut(before.words, lo, hi);
			joins.push(Math.round(cut / 1000));
			// The same words were heard by both parts here, so they say whose voice is whose.
			const pairs = new Map();
			for (const w of words) {
				if (w.s >= hi) break;
				if (w.s < lo || !w.voice) continue;
				const same = wordAt(before.words, (w.s + w.e) / 2);
				if (!same || !same.v) continue;
				const k = `${w.voice}|${same.v}`;
				pairs.set(k, (pairs.get(k) || 0) + 1);
			}
			const taken = new Set();
			for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1])) {
				const [voice, v] = k.split("|");
				if (n < 3 || ids.has(voice) || taken.has(v)) continue;
				ids.set(voice, Number(v));
				taken.add(v);
			}
			while (all.length && all[all.length - 1].s >= cut) all.pop();
		}
		const kept = [];
		for (const w of words) {
			if (w.s < cut) continue;
			if (w.voice) {
				if (!ids.has(w.voice)) ids.set(w.voice, ++voices);
				w.v = ids.get(w.voice);
			}
			kept.push(w);
			all.push(w);
		}
		before = { words: kept, end: part.end * 1000 };
	}
	// Lines: a new one when the voice changes, after a pause, or once a long one reaches a full stop.
	const lines = [];
	let cur = null;
	for (const w of all) {
		const full = cur && cur.text.length > 280 && /[.!?。！？]\s*$/.test(cur.text);
		if (!cur || w.v !== cur.v || w.s - cur.e > 1500 || cur.text.length > 700 || full) {
			cur = { s: w.s, e: w.e, v: w.v, text: "" };
			lines.push(cur);
		}
		cur.text += w.text;
		cur.e = Math.max(cur.e, w.e);
	}
	return {
		lines: lines
			.map((l) => ({
				t: Math.round(l.s / 100) / 10,
				v: l.v,
				text: l.text.replace(/\s+/g, " ").trim(),
			}))
			.filter((l) => l.text),
		duration: parts.length ? parts[parts.length - 1].end : 0,
		voices,
		joins,
	};
}

/* ---------- recordings, turned into text on this Mac for free ----------
   The other way to turn a recording into text, and the one used when it's ready: free speech models
   that run on this Mac and check each other, so nothing is paid for and no audio leaves the computer.
   speech.cjs (next to this file) says which models, where they come from, and does the listening; its
   opening comment explains how. Here: fetching the engine and the models once into ~/AllKnowing/speech
   (about 1.8 GB, each download checked against the SHA-256 written in speech.cjs), checking that they
   work on this Mac, and running a recording through them.

   It is slower than Soniox: where it was tried, an hour of recording took about 40 minutes, and the
   Mac measures its own speed so the page can say how long. Soniox stays available for recordings
   when a speech key is saved, as the faster, paid way; live listening still needs it. */
const SPEECH = path.join(HOME, "speech");
const SPEECH_FILE = path.join(__dirname, "speech.cjs");
const SPEECH_OFF = process.env.AK_HUB_SPEECH === "off";
const SPEECH_SOURCE = (process.env.AK_HUB_SPEECH_SOURCE || "").replace(/\/+$/, "");
// none: not fetched yet. getting: downloading. checking: trying them out. ready. error. off.
const local = { state: SPEECH_OFF ? "off" : "none", item: "", got: 0, of: 0, error: "", detail: "", at: 0 };
let speechLib = null;
function speech() {
	if (speechLib || SPEECH_OFF) return speechLib;
	try {
		speechLib = require(SPEECH_FILE);
	} catch (e) {
		if (fs.existsSync(SPEECH_FILE)) log(`speech.cjs couldn't be read: ${e.message}`);
	}
	return speechLib;
}
// What the page is told about it.
function speechInfo() {
	const lib = local.state === "ready" ? speech() : null;
	return {
		state: local.state,
		progress: local.of ? Math.min(1, local.got / local.of) : 0,
		item: local.item,
		bytes: local.of,
		error: local.error,
		// what the engine itself said when it wouldn't run: for whoever looks into it
		detail: local.detail,
		// seconds of work for an hour of recording, as measured on this Mac
		perHour: lib ? lib.estimate(SPEECH, 3600) : 0,
		models: lib ? Object.values(lib.MODELS).map((m) => m.name) : [],
	};
}
// Tests point the downloads at a stand-in.
function speechUrl(url) {
	if (!SPEECH_SOURCE) return url;
	return url
		.replace("https://github.com/k2-fsa/sherpa-onnx/releases/download", `${SPEECH_SOURCE}/gh`)
		.replace("https://registry.npmjs.org", `${SPEECH_SOURCE}/npm`);
}
function hashFile(file) {
	return new Promise((resolve, reject) => {
		const h = crypto.createHash("sha256");
		fs.createReadStream(file)
			.on("data", (d) => h.update(d))
			.on("error", reject)
			.on("end", () => resolve(h.digest("hex")));
	});
}
// A big file, fetched so that a dropped connection carries on from where it stopped, and only kept
// if it is exactly the file that was expected.
async function download(url, dest, item, onBytes) {
	const name = path.basename(dest);
	for (let tries = 0, bad = 0; ; ) {
		let have = 0;
		try {
			have = fs.statSync(dest).size;
		} catch {
			/* not started */
		}
		if (have > item.bytes) {
			fs.rmSync(dest, { force: true });
			have = 0;
		}
		if (have < item.bytes) {
			const stop = new AbortController();
			let quiet = setTimeout(() => stop.abort(), 90000);
			try {
				const r = await fetch(url, {
					headers: have ? { range: `bytes=${have}-` } : {},
					signal: stop.signal,
				});
				if (r.status === 200) have = 0;
				else if (r.status !== 206) throw new Error(`the server answered ${r.status}`);
				const out = fs.createWriteStream(dest, { flags: have ? "a" : "w", mode: 0o600 });
				try {
					for await (const chunk of r.body) {
						clearTimeout(quiet);
						quiet = setTimeout(() => stop.abort(), 90000);
						if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
						have += chunk.length;
						onBytes(Math.min(have, item.bytes));
					}
				} finally {
					await new Promise((res) => out.end(res));
				}
				tries = 0;
			} catch (e) {
				if (++tries > 6)
					throw userError(
						`The download of ${name} keeps stopping (${e.name === "AbortError" ? "no data for a while" : e.message}). Check the Mac mini's internet connection, then try again.`,
					);
				await sleep(Math.min(30000, 1500 * tries) * (process.env.AK_HUB_RETRY_MS ? 0.01 : 1));
				continue;
			} finally {
				clearTimeout(quiet);
			}
			continue;
		}
		if ((await hashFile(dest)) === item.sha256) return;
		fs.rmSync(dest, { force: true });
		if (++bad > 1)
			throw userError(
				`The download of ${name} wasn't the file that was expected, so it wasn't used. Try again later.`,
			);
	}
}
async function unpack(args, into) {
	const tar = findTool("tar");
	if (!tar) throw userError("This computer has no tar to unpack the speech models with.");
	fs.mkdirSync(into, { recursive: true, mode: 0o700 });
	const r = await run(tar, [...args, "-C", into], 30 * 60000);
	if (r.code !== 0) throw new Error(`tar: ${(r.err || r.out).trim().slice(-300)}`);
}
async function fetchPiece(item, onBytes) {
	const downloads = path.join(SPEECH, "downloads");
	fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
	const got = path.join(downloads, path.basename(new URL(item.url).pathname));
	await download(speechUrl(item.url), got, item, onBytes);
	if (item.file) {
		fs.mkdirSync(path.join(SPEECH, "models"), { recursive: true, mode: 0o700 });
		fs.renameSync(got, path.join(SPEECH, "models", item.file));
		return;
	}
	const dest = item.dir
		? path.join(SPEECH, "models", item.dir)
		: path.join(SPEECH, "engine", "node_modules", item.into);
	const tmp = `${dest}.unpacking`;
	fs.rmSync(tmp, { recursive: true, force: true });
	if (item.dir) await unpack(["-xjf", got], tmp);
	else await unpack(["-xzf", got, "--strip-components=1"], tmp);
	const made = item.dir ? path.join(tmp, item.dir) : tmp;
	if (!fs.existsSync(made)) throw new Error(`${path.basename(got)} didn't hold what was expected`);
	fs.rmSync(dest, { recursive: true, force: true });
	fs.renameSync(made, dest);
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.rmSync(got, { force: true });
}
function speechWorker(args, onLine) {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [SPEECH_FILE, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		// The Mac has other things to do too.
		try {
			os.setPriority(p.pid, 10);
		} catch {
			/* it runs at the usual priority */
		}
		let rest = "";
		let err = "";
		p.stdout.on("data", (d) => {
			rest += d;
			for (;;) {
				const nl = rest.indexOf("\n");
				if (nl < 0) break;
				const line = rest.slice(0, nl);
				rest = rest.slice(nl + 1);
				try {
					onLine(JSON.parse(line));
				} catch {
					/* not ours */
				}
			}
		});
		p.stderr.on("data", (d) => {
			err = (err + d).slice(-4000);
		});
		p.on("error", (e) => resolve({ code: -1, err: e.message, p }));
		p.on("close", (code) => resolve({ code, err, p }));
		onLine({ worker: p });
	});
}
let settingUp = null;
// Fetch whatever isn't here yet, then try everything out. Safe to call again: it carries on.
function setupSpeech() {
	if (SPEECH_OFF) return Promise.resolve(local);
	if (settingUp) return settingUp;
	settingUp = (async () => {
		try {
			local.error = "";
			local.detail = "";
			local.item = "";
			if (!fs.existsSync(SPEECH_FILE)) {
				local.state = "getting";
				const r = await update({ withHub: false, speechFile: true });
				if (!fs.existsSync(SPEECH_FILE))
					throw userError(
						`The Mac mini couldn't fetch its speech file (${r.message || "no answer"}). Press Get the latest version, then try again.`,
					);
			}
			const lib = speech();
			if (!lib)
				throw userError(
					"The Mac mini's speech file can't be read. Press Get the latest version, then try again.",
				);
			const kind = lib.platformKey();
			if (!lib.ENGINE[kind])
				throw userError(
					`There is no speech engine for this kind of computer (${kind}), so recordings need Soniox here.`,
				);
			const gone = lib.missing(SPEECH);
			const want = [];
			if (gone.includes("engine")) want.push(lib.ENGINE.node, lib.ENGINE[kind]);
			for (const k of gone) if (k !== "engine") want.push(lib.MODELS[k]);
			if (want.length) {
				local.state = "getting";
				local.of = want.reduce((a, x) => a + x.bytes, 0);
				local.got = 0;
				let free = Number.POSITIVE_INFINITY;
				try {
					fs.mkdirSync(SPEECH, { recursive: true, mode: 0o700 });
					const s = fs.statfsSync(SPEECH);
					free = Number(s.bavail) * Number(s.bsize);
				} catch {
					/* an older Node can't say; the download will */
				}
				const need = local.of * 2.4 + 300e6;
				if (free < need)
					throw userError(
						`There isn't enough room on the Mac mini for the speech models: they need about ${(need / 1e9).toFixed(1)} GB free while they're set up, and ${(free / 1e9).toFixed(1)} GB is free.`,
					);
				log(
					`Fetching the free speech models: ${want.length} downloads, ${(local.of / 1e6).toFixed(0)} MB.`,
				);
				let before = 0;
				for (const item of want) {
					local.item = item.name || "the speech engine";
					await fetchPiece(item, (n) => {
						local.got = before + n;
					});
					before += item.bytes;
					local.got = before;
				}
			}
			local.state = "checking";
			local.item = "";
			let answer = null;
			const r = await speechWorker(["check", SPEECH], (m) => {
				if (typeof m.ok === "boolean") answer = m;
			});
			if (!answer || !answer.ok) {
				const said = (answer && answer.error) || r.err.trim().slice(-600) || `exit ${r.code}`;
				local.detail = `${process.platform} ${os.release()} ${process.arch}, Node ${process.versions.node}: ${said}`.slice(0, 700);
				log(`The speech models didn't pass their check: ${said}`);
				throw userError(
					`The speech models are on the Mac mini but didn't work when tried${answer && answer.failed ? ` (${answer.failed})` : ""}. Recordings can still go through Soniox with a speech key.`,
				);
			}
			writeAtomic(
				path.join(SPEECH, "ready.json"),
				JSON.stringify({ engine: lib.ENGINE_VERSION, at: Date.now(), speeds: answer.speeds }),
				0o600,
			);
			local.state = "ready";
			local.at = Date.now();
			log(
				`The free speech models are ready (an hour of recording takes about ${Math.round(lib.estimate(SPEECH, 3600) / 60)} minutes here).`,
			);
			setImmediate(nextJob);
		} catch (e) {
			local.state = "error";
			local.error =
				e.user || "Something went wrong while setting up the speech models. Try again.";
			log(`Speech models: ${e.user ? e.message : e.stack || e.message}`);
		} finally {
			settingUp = null;
		}
		return local;
	})();
	return settingUp;
}
// At start-up: ready at once if they were set up before, else start fetching.
function startSpeech() {
	if (SPEECH_OFF) return;
	const lib = speech();
	let was = null;
	try {
		was = JSON.parse(fs.readFileSync(path.join(SPEECH, "ready.json"), "utf8"));
	} catch {
		/* never set up */
	}
	if (lib && was && was.engine === lib.ENGINE_VERSION && !lib.missing(SPEECH).length) {
		local.state = "ready";
		local.at = was.at || 0;
		return;
	}
	if (cfg.localSpeech !== false) setupSpeech();
}
// The recording as the models want it: one channel, 16 kHz, 16-bit, in sound.wav.
async function makeSound(job) {
	const dir = jobDir(job.id);
	const wav = path.join(dir, "sound.wav");
	const mark = path.join(dir, "sound.ok");
	if (fs.existsSync(mark) && fs.existsSync(wav)) return;
	let src = path.join(dir, job.audio);
	let info = null;
	try {
		info = await probeRecording(src, job.ext);
	} catch (e) {
		log(`Couldn't read a recording here (${job.ext}): ${e.message}`);
	}
	if (info && info.silent) throw userError("There's no sound in this file.");
	// A video goes to the converter as its sound only.
	if (info && info.kind === "mp4" && info.hasVideo && (info.codec.adts || info.codec.raw)) {
		const parts = await cutParts(src, info, [[0, info.duration]], dir);
		if (parts.length) src = path.join(dir, parts[0].file);
	}
	const f = info && info.kind === "wav" ? info.fmt : null;
	const fit =
		!!f &&
		f.readUInt16LE(8) === 1 &&
		f.readUInt16LE(10) === 1 &&
		f.readUInt32LE(12) === 16000 &&
		f.readUInt16LE(22) === 16;
	const tool = converter();
	if (fit && !tool) fs.copyFileSync(src, wav);
	else if (!tool)
		throw userError(
			"This computer has nothing to read this kind of recording with. Install ffmpeg, or save the recording as a 16 kHz WAV.",
		);
	else await toWav(tool, src, wav);
	fs.writeFileSync(mark, "");
	if (src !== path.join(dir, job.audio)) fs.rmSync(src, { force: true });
}
async function localJob(job) {
	const live = liveOf(job);
	const dir = jobDir(job.id);
	const lib = speech();
	if (local.state !== "ready" || !lib)
		throw userError(
			"The Mac mini's speech models aren't ready. Look at Home → Mac mini, then try again.",
		);
	job.error = "";
	job.progress = 0;
	job.left = 0;
	job.stage = "";
	setState(job, "preparing");
	await makeSound(job);
	if (stopped(job)) return;
	writeAtomic(
		path.join(dir, "ask.json"),
		JSON.stringify({ hints: job.hints, terms: job.terms, topic: job.topic }),
		0o600,
	);
	setState(job, "transcribing");
	let saved = Date.now();
	let last = null;
	const stop = () => last && last.kill("SIGTERM");
	live.abort.signal.addEventListener("abort", stop);
	let done = null;
	let failed = "";
	const r = await speechWorker(["run", dir, SPEECH], (m) => {
		if (m.worker) {
			last = m.worker;
			if (live.stopped) stop();
			return;
		}
		if (m.done) done = m;
		if (m.error) failed = String(m.error);
		if (typeof m.progress === "number") {
			job.progress = m.progress;
			job.left = m.left || 0;
			job.stage = m.step || job.stage;
			if (Date.now() - saved > 15000) {
				saved = Date.now();
				saveJob(job);
			}
		}
	});
	live.abort.signal.removeEventListener("abort", stop);
	if (stopped(job)) return;
	let result = null;
	try {
		result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
	} catch {
		/* it didn't get that far */
	}
	if (r.code !== 0 || !done || !result) {
		log(`A recording stopped in the speech models: ${failed || r.err.trim().slice(-800) || `exit ${r.code}`}`);
		if (/no sound/i.test(failed)) throw userError("There's no sound in this recording.");
		throw userError(
			cfg.speechKey
				? "The Mac mini's own speech models couldn't finish this recording. Try again, or use Soniox for this one."
				: "The Mac mini's own speech models couldn't finish this recording. Try again.",
		);
	}
	job.model = (result.models || []).join(" + ");
	job.lines = result.lines.length;
	job.voices = result.voices;
	job.duration = result.duration || job.duration;
	job.progress = 1;
	job.left = 0;
	job.doneAt = Date.now();
	setState(job, "done");
	dropAudio(job);
	log(
		`A recording is now text, made on this Mac: ${Math.round(job.duration / 60)} min, ${result.lines.length} lines, ${result.voices} voice(s), ${result.stats ? result.stats.doubts : 0} place(s) in doubt.`,
	);
}
// Which way a recording goes: the way that was asked for, else this Mac's own models when they're
// ready, else Soniox when there's a key.
function engineFor(asked) {
	const key = !!cfg.speechKey;
	if (asked === "soniox") return key ? { engine: "soniox" } : { error: NO_SPEECH_KEY, type: "no_key" };
	if (local.state === "ready") return { engine: "local" };
	if (asked !== "local" && key) return { engine: "soniox" };
	if (local.state === "getting" || local.state === "checking" || local.state === "none")
		return {
			type: "not_ready",
			error:
				local.state === "getting" && local.of
					? `The Mac mini is still fetching its speech models (${Math.round((100 * local.got) / local.of)}%). Try again in a few minutes.`
					: "The Mac mini is still getting its speech models ready. Try again in a few minutes.",
		};
	if (local.state === "error")
		return { type: "no_engine", error: `${local.error} (Home → Mac mini → Try again.)` };
	// Its own models are switched off: Soniox is the only way.
	return { type: "no_key", error: NO_SPEECH_KEY };
}

/* The recordings being worked on. */
const jobs = new Map(); // id → the job, as saved in recordings/<id>/job.json
const running = new Map(); // id → what isn't saved: { abort, stopped, writing }
const queue = [];
let working = "";
const JOB_ID = /^[a-f0-9]{24}$/;
const jobDir = (id) => path.join(RECORDINGS, id);
function liveOf(job) {
	let l = running.get(job.id);
	if (!l) {
		l = { abort: new AbortController(), stopped: false, writing: false };
		running.set(job.id, l);
	}
	return l;
}
const stopped = (job) => !jobs.has(job.id) || liveOf(job).stopped;
function saveJob(job) {
	if (!jobs.has(job.id)) return;
	job.updatedAt = Date.now();
	writeAtomic(path.join(jobDir(job.id), "job.json"), JSON.stringify(job), 0o600);
}
function setState(job, state) {
	job.state = state;
	saveJob(job);
}
function jobStatus(job) {
	return {
		id: job.id,
		state: job.state,
		name: job.name,
		size: job.size,
		received: job.received,
		duration: Math.round(job.duration || 0),
		parts: job.parts.length,
		part: job.part,
		waiting: job.state === "queued" ? queue.indexOf(job.id) + (working ? 1 : 0) : 0,
		error: job.error,
		lines: job.lines || 0,
		voices: job.voices || 0,
		// "local": this Mac's own models, with how far along they are and about how long is left
		engine: job.engine || "soniox",
		stage: job.stage || "",
		progress: job.state === "done" ? 1 : job.progress || 0,
		left: job.left || 0,
	};
}
// Everything but the record and the text: the audio isn't kept a moment longer than it's needed.
function dropAudio(job) {
	const dir = jobDir(job.id);
	let names = [];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names)
		if (name !== "job.json" && name !== "result.json")
			fs.rmSync(path.join(dir, name), { force: true });
}
function dropJob(job) {
	const l = liveOf(job);
	l.stopped = true;
	l.abort.abort();
	jobs.delete(job.id);
	running.delete(job.id);
	const at = queue.indexOf(job.id);
	if (at >= 0) queue.splice(at, 1);
	fs.rmSync(jobDir(job.id), { recursive: true, force: true });
	// What Soniox still holds of it goes too, in its own time.
	(async () => {
		for (const p of job.parts) if (p.fileId || p.txId) await forgetAtSoniox(p);
	})().catch(() => null);
}
// What has been found out about long files is kept for the next recording.
function rememberLongFiles(taken) {
	if (cfg.longFiles === taken) return;
	cfg.longFiles = taken;
	saveConfig();
	log(
		taken
			? "Soniox takes recordings of over an hour whole. From now on they go that way."
			: "Soniox takes an hour of audio at most. Longer recordings go in parts from now on.",
	);
}
async function runJob(job) {
	for (;;) {
		try {
			await transcribeJob(job);
			return;
		} catch (e) {
			if (stopped(job)) return;
			const part = job.parts[job.part];
			if (part && !part.done && !e.keep) await forgetAtSoniox(part);
			// A long file Soniox wouldn't take: once more, in parts of under an hour.
			if (e.refused && part && !job.short && part.end - part.start > SHORT_PART + 1) {
				if (/duration|too long|exceed|limit|minute|hour/i.test(e.message))
					rememberLongFiles(false);
				log(
					`Soniox wouldn't take a long recording whole (${e.message}); sending it in parts.`,
				);
				job.short = true;
				job.parts = [];
				job.part = 0;
				saveJob(job);
				continue;
			}
			job.error =
				e.user || "Something went wrong on the Mac mini with this recording. Try again.";
			log(`A recording stopped: ${e.user ? e.message : e.stack || e.message}`);
			setState(job, "error");
			return;
		}
	}
}
async function transcribeJob(job) {
	if (job.engine === "local") return localJob(job);
	const signal = liveOf(job).abort.signal;
	const dir = jobDir(job.id);
	if (!cfg.speechKey) throw userError(NO_SPEECH_KEY);
	job.error = "";
	if (!job.parts.length) {
		setState(job, "preparing");
		const most = job.short || cfg.longFiles === false ? SHORT_PART : LONG_PART;
		const parts = await makeParts(job, most);
		if (stopped(job)) return;
		if (!parts.length) throw userError(CANT_READ);
		job.parts = parts.map((p, i) => ({ ...p, i, fileId: "", txId: "", done: false }));
		saveJob(job);
	}
	job.model = await patiently(job, () => fileModel(signal));
	for (const part of job.parts) {
		if (part.done) continue;
		job.part = part.i;
		for (let tries = 0; !part.txId; tries++) {
			if (!part.fileId) {
				setState(job, "sending");
				const name = `part-${part.i + 1}${path.extname(part.file) || ".bin"}`;
				const sent = await patiently(job, () =>
					sonioxUpload(path.join(dir, part.file), name, signal),
				);
				part.fileId = String(sent.id || "");
				// Stopped while it was going up: what just arrived at Soniox goes again.
				if (stopped(job)) return forgetAtSoniox(part);
				if (!part.fileId) throw userError("Soniox didn't take the recording. Try again.");
				saveJob(job);
			}
			setState(job, "transcribing");
			try {
				const made = await patiently(job, () =>
					startTranscription(job, part, job.model, signal),
				);
				part.txId = String(made.id || "");
				if (stopped(job)) return forgetAtSoniox(part);
				if (!part.txId) throw userError("Soniox didn't start on the recording. Try again.");
				saveJob(job);
			} catch (e) {
				// The file isn't at Soniox any more (it was sent before a long break): send it again, once.
				if (e.status !== 404 || tries) throw e;
				part.fileId = "";
			}
		}
		setState(job, "transcribing");
		let words;
		try {
			words = await waitForWords(job, part, signal);
		} catch (e) {
			if (e.status === 404) {
				part.txId = "";
				part.fileId = "";
				saveJob(job);
				throw userError("Soniox lost track of this recording. Try again.", { keep: true });
			}
			throw e;
		}
		if (stopped(job)) return;
		writeAtomic(path.join(dir, `words-${part.i}.json`), JSON.stringify(words), 0o600);
		part.done = true;
		saveJob(job);
		await forgetAtSoniox(part);
		saveJob(job);
	}
	if (stopped(job)) return;
	const result = stitch(
		job.parts.map((p) => ({
			start: p.start,
			end: p.end,
			words: JSON.parse(fs.readFileSync(path.join(dir, `words-${p.i}.json`), "utf8")),
		})),
	);
	result.model = job.model;
	result.duration = Math.round((job.duration || result.duration || 0) * 1000) / 1000;
	writeAtomic(path.join(dir, "result.json"), JSON.stringify(result), 0o600);
	job.lines = result.lines.length;
	job.voices = result.voices;
	job.duration = job.duration || result.duration;
	job.doneAt = Date.now();
	setState(job, "done");
	dropAudio(job);
	// A file of well over an hour went through: Soniox takes them.
	if (job.parts.some((p) => p.end - p.start > SHORT_PART * 1.06)) rememberLongFiles(true);
	log(
		`A recording is now text: ${Math.round(job.duration / 60)} min, ${job.parts.length} part(s), ${result.lines.length} lines, ${result.voices} voice(s).`,
	);
}
async function nextJob() {
	if (working || !queue.length) return;
	const job = jobs.get(queue.shift());
	if (!job) {
		setImmediate(nextJob);
		return;
	}
	working = job.id;
	try {
		await runJob(job);
	} finally {
		working = "";
		setImmediate(nextJob);
	}
}
function enqueue(job) {
	if (working !== job.id && !queue.includes(job.id)) queue.push(job.id);
	setImmediate(nextJob);
}
// At start-up: the recordings that were under way carry on from where they were.
function loadJobs() {
	let names = [];
	try {
		names = fs.readdirSync(RECORDINGS);
	} catch {
		return;
	}
	for (const id of names) {
		if (!JOB_ID.test(id)) continue;
		try {
			const job = JSON.parse(fs.readFileSync(path.join(jobDir(id), "job.json"), "utf8"));
			if (!job || job.id !== id || !Array.isArray(job.parts)) throw new Error("not a job");
			jobs.set(id, job);
		} catch {
			// A folder without its record is what's left of one that was being deleted.
			fs.rmSync(jobDir(id), { recursive: true, force: true });
		}
	}
	const going = [...jobs.values()]
		.filter((j) => ["queued", "preparing", "sending", "transcribing"].includes(j.state))
		.sort((a, b) => a.createdAt - b.createdAt);
	for (const job of going) enqueue(job);
	if (going.length) log(`Carrying on with ${going.length} recording(s).`);
}
function tidyRecordings() {
	const now = Date.now();
	for (const job of [...jobs.values()]) {
		const idle = now - (job.updatedAt || job.createdAt || 0);
		const stale =
			(job.state === "receiving" && idle > 864e5) ||
			((job.state === "done" || job.state === "error") && idle > KEEP_MS);
		if (!stale) continue;
		log(`Cleared away an old recording (${job.state}).`);
		dropJob(job);
	}
}
const shortList = (v, max, len) =>
	(Array.isArray(v) ? v : [])
		.filter((x) => typeof x === "string")
		.map((x) => x.replace(/\s+/g, " ").trim().slice(0, len))
		.filter(Boolean)
		.slice(0, max);
async function newRecording(req, res) {
	const b = await readJson(req, 256 * 1024);
	const size = Number(b.size);
	const no = (status, type, message) => sendJson(res, status, { error: { type, message } });
	if (!Number.isSafeInteger(size) || size <= 0)
		return no(400, "invalid_request_error", "Say how big the recording is.");
	if (size > MAX_RECORDING)
		return no(
			413,
			"too_big",
			"That recording is over 2 GB. Save just its sound, as MP3 or M4A, and import that.",
		);
	const way = engineFor(["local", "soniox"].includes(b.engine) ? b.engine : "");
	if (way.error) return no(400, way.type, way.error);
	if ([...jobs.values()].filter((j) => j.state === "receiving").length >= 4)
		return no(
			429,
			"busy",
			"Other recordings are still on their way to the Mac mini. Let them finish first.",
		);
	const name =
		Array.from(String(b.name || ""))
			.filter((c) => c >= " " && c !== "\u007f")
			.join("")
			.trim()
			.slice(0, 200) || "recording";
	const said = path.extname(name).slice(1).toLowerCase();
	const ext = AUDIO_EXT.has(said) ? said : "bin";
	const now = Date.now();
	const job = {
		id: crypto.randomBytes(12).toString("hex"),
		name,
		ext,
		audio: `audio.${ext}`,
		size,
		received: 0,
		engine: way.engine,
		state: "receiving",
		createdAt: now,
		updatedAt: now,
		hints: shortList(b.hints, 4, 3).filter((x) => /^[a-z]{2,3}$/.test(x)),
		terms: shortList(b.terms, 200, 80),
		topic: String(b.topic || "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 400),
		duration: 0,
		parts: [],
		part: 0,
		short: false,
		model: "",
		error: "",
		doneAt: 0,
		claimedAt: 0,
	};
	fs.mkdirSync(jobDir(job.id), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(jobDir(job.id), job.audio), "", { mode: 0o600 });
	jobs.set(job.id, job);
	saveJob(job);
	log(
		`A recording is on its way here: ${(size / 1e6).toFixed(1)} MB, for ${way.engine === "local" ? "this Mac's own speech models" : "Soniox"}.`,
	);
	sendJson(res, 200, { ...jobStatus(job), chunk: CHUNK });
}
// The next piece of a recording. It has to start where the last one ended; if it doesn't, the answer
// says how much is here, and the device carries on from there.
async function receivePiece(req, res, job, at) {
	const l = liveOf(job);
	const file = path.join(jobDir(job.id), job.audio);
	const sizeNow = () => {
		try {
			return fs.statSync(file).size;
		} catch {
			return 0;
		}
	};
	const have = sizeNow();
	job.received = have;
	const no = (status, type, message) => {
		req.resume();
		sendJson(res, status, { error: { type, message }, received: have });
	};
	if (job.state !== "receiving")
		return no(409, "not_receiving", "The Mac mini already has all of this recording.");
	if (l.writing) return no(409, "busy", "The Mac mini is still saving the last piece.");
	if (at !== have)
		return no(409, "offset", "The Mac mini has a different amount of this recording.");
	const room = Math.min(MAX_CHUNK, job.size - have);
	const said = Number(req.headers["content-length"]);
	if (room <= 0 || (Number.isFinite(said) && said > room))
		return no(413, "too_big", "That's more than the recording, or too much at once.");
	l.writing = true;
	let n = 0;
	req.on("data", (c) => {
		n += c.length;
		if (n > room) req.destroy();
	});
	try {
		await pipeline(req, fs.createWriteStream(file, { flags: "a" }));
	} catch {
		/* cut off part way: the device sends the rest again */
	} finally {
		l.writing = false;
	}
	job.received = sizeNow();
	if (job.received > job.size) {
		// More than was said: not the recording it claims to be.
		dropJob(job);
		return sendJson(res, 413, {
			error: { type: "too_big", message: "That's more than the recording." },
		});
	}
	saveJob(job);
	sendJson(res, 200, { received: job.received });
}
async function startRecording(req, res, job) {
	const b = await readJson(req, 4096).catch(() => ({}));
	if (job.state === "receiving" && job.received !== job.size)
		return sendJson(res, 409, {
			...jobStatus(job),
			error: {
				type: "incomplete",
				message: "Not all of the recording has reached the Mac mini yet.",
			},
		});
	if (job.state === "receiving" || job.state === "error") {
		// The same way as before unless another is asked for ("use Soniox for this one").
		const asked = ["local", "soniox"].includes(b.engine) ? b.engine : job.engine || "soniox";
		const way = engineFor(asked);
		if (way.error) return sendJson(res, 400, { error: { type: way.type, message: way.error } });
		if (way.engine !== (job.engine || "soniox")) {
			// Changing the way starts the recording afresh: only the recording itself is kept.
			for (const name of fs.readdirSync(jobDir(job.id)))
				if (name !== "job.json" && name !== job.audio)
					fs.rmSync(path.join(jobDir(job.id), name), { force: true });
			job.parts = [];
			job.part = 0;
			job.engine = way.engine;
		}
		// Trying again with nothing yet done: work out the parts afresh (a converter may be here now).
		if (!job.parts.some((p) => p.done)) {
			job.parts = [];
			job.part = 0;
		}
		job.error = "";
		job.progress = 0;
		setState(job, "queued");
		enqueue(job);
	}
	sendJson(res, 200, jobStatus(job));
}
// The text, for the one device that saves it into the meeting. Another that asks in the next ten
// minutes is told to wait for that copy; after that the text can be taken again.
async function claimRecording(req, res, job) {
	const by = String((await readJson(req, 4096)).by || "").slice(0, 80);
	if (job.state !== "done")
		return sendJson(res, 409, {
			...jobStatus(job),
			error: { type: "not_ready", message: "It isn't finished yet." },
		});
	const taken = job.claimedAt && Date.now() - job.claimedAt < CLAIM_MS;
	if (taken && !(by && by === job.claimedBy))
		return sendJson(res, 409, {
			error: { type: "claimed", message: "Another device is saving this transcript." },
			claimed: true,
		});
	let result;
	try {
		result = JSON.parse(fs.readFileSync(path.join(jobDir(job.id), "result.json"), "utf8"));
	} catch {
		return sendJson(res, 410, {
			error: {
				type: "gone",
				message: "The text is missing on the Mac mini. Import the recording again.",
			},
		});
	}
	job.claimedAt = Date.now();
	job.claimedBy = by;
	saveJob(job);
	sendJson(res, 200, result);
}
async function recordingsApi(req, res, url) {
	const m = url.pathname.match(/^\/api\/transcribe(?:\/([^/]+)(?:\/([a-z]+))?)?$/);
	if (!m) return notFound(res);
	const [, id, action] = m;
	if (!id) return req.method === "POST" ? newRecording(req, res) : notFound(res);
	const job = JOB_ID.test(id) ? jobs.get(id) : null;
	if (!job) {
		req.resume();
		return sendJson(res, 404, {
			error: {
				type: "not_found",
				message: "Your Mac mini doesn't have this recording any more.",
			},
		});
	}
	if (!action && req.method === "GET") return sendJson(res, 200, jobStatus(job));
	if (!action && req.method === "DELETE") {
		dropJob(job);
		return sendJson(res, 200, { ok: true });
	}
	if (action === "data" && req.method === "PUT")
		return receivePiece(req, res, job, Number(url.searchParams.get("at")));
	if (action === "start" && req.method === "POST") return startRecording(req, res, job);
	if (action === "claim" && req.method === "POST") return claimRecording(req, res, job);
	req.resume();
	return notFound(res);
}

/* ---------- keeping the page up to date ----------
   version.json on the gh-pages branch lists each file with its SHA-256. The page's files are swapped in
   by themselves once a day, when nothing has been saved for a while (so not during a meeting). This file
   is only replaced when someone presses Update, after which the hub restarts (its LaunchAgent starts it). */
let lastCheck = { at: 0, latest: "", hubApi: HUB_API, files: {}, error: "", raw: null };
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
async function fetchBuf(url) {
	const r = await fetch(url, {
		signal: AbortSignal.timeout(30000),
		headers: { "cache-control": "no-cache" },
	});
	if (!r.ok) throw new Error(`${url} answered ${r.status}`);
	return Buffer.from(await r.arrayBuffer());
}
async function checkUpdate() {
	try {
		const raw = await fetchBuf(`${SOURCE}/version.json?t=${Date.now()}`);
		const v = JSON.parse(String(raw));
		lastCheck = {
			at: Date.now(),
			latest: String(v.version || ""),
			hubApi: Number(v.hubApi) || 1,
			files: v.files || {},
			error: "",
			raw,
		};
	} catch (e) {
		lastCheck = { ...lastCheck, at: Date.now(), error: e.message };
	}
	return lastCheck;
}
const localSha = (file) => {
	try {
		return sha256(fs.readFileSync(file));
	} catch {
		return "";
	}
};
// The server is two files: this one, and speech.cjs for the free speech models.
const HUB_FILES = ["hub/hub.cjs", "hub/speech.cjs"];
const hubFile = (name) => path.join(__dirname, path.basename(name));
const hubFileChanged = (name) => {
	const want = lastCheck.files[name];
	return !!want && want !== localSha(hubFile(name));
};
const hubChanged = () => HUB_FILES.some(hubFileChanged);
let updating = null;
async function update({ withHub, speechFile }) {
	if (updating) return updating;
	updating = (async () => {
		const v = await checkUpdate();
		if (v.error) return { ok: false, message: `Couldn't check for updates: ${v.error}` };
		const needHub = v.hubApi > HUB_API || hubChanged();
		if (v.hubApi > HUB_API && !withHub)
			return {
				ok: true,
				waiting: true,
				message:
					"A new version needs the Mac mini itself updated. Press Update on the Mac mini card.",
			};
		// Download and check everything first, then swap; a half-finished update changes nothing.
		const staged = [];
		for (const [name, want] of Object.entries(v.files)) {
			const isHub = HUB_FILES.includes(name);
			if (name.includes("..") || (!isHub && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)))
				continue;
			if (!isHub && !TYPES[path.extname(name).toLowerCase()]) continue;
			// speech.cjs is also fetched by itself when it isn't here at all (a server from before it).
			const lone = speechFile && name === "hub/speech.cjs" && !fs.existsSync(hubFile(name));
			if (isHub ? !(lone || (withHub && needHub && hubFileChanged(name))) : localSha(path.join(APP, name)) === want)
				continue;
			const buf = await fetchBuf(`${SOURCE}/${name}`);
			if (sha256(buf) !== want)
				return {
					ok: false,
					message: `The download of ${name} didn't match, so nothing was changed. Try again later.`,
				};
			staged.push({ name, buf, isHub });
		}
		const hub = staged.filter((x) => x.isHub);
		for (const x of hub) {
			// Named .cjs so Node checks it as what it is.
			x.next = `${hubFile(x.name)}.next.cjs`;
			fs.writeFileSync(x.next, x.buf);
			const check = spawnSync(process.execPath, ["--check", x.next], { encoding: "utf8" });
			if (check.status !== 0) {
				for (const y of hub) if (y.next) fs.rmSync(y.next, { force: true });
				return {
					ok: false,
					message:
						"The new version of the Mac mini's server didn't pass its check, so nothing was changed.",
				};
			}
		}
		fs.mkdirSync(APP, { recursive: true });
		for (const x of staged) if (!x.isHub) writeAtomic(path.join(APP, x.name), x.buf);
		const pageChanged = staged.some((x) => !x.isHub) || appVersion() !== v.latest;
		// version.json goes in last, so the version the hub reports only changes once every file is there.
		if (pageChanged && v.raw) writeAtomic(path.join(APP, "version.json"), v.raw);
		if (pageChanged) {
			log(`The web app is now ${appVersion() || v.latest}.`);
			announce({ app: appVersion() || v.latest });
		}
		if (hub.length) {
			for (const x of hub) {
				const file = hubFile(x.name);
				if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.previous`);
				fs.renameSync(x.next, file);
			}
			// speech.cjs arriving for the first time is simply used; anything else needs a fresh start.
			if (hub.some((x) => x.name === "hub/hub.cjs") || speechLib) {
				log("Updated the Mac mini's server; restarting.");
				return {
					ok: true,
					restart: true,
					message:
						"Updated. The Mac mini restarts AllKnowing now; the page reconnects in a few seconds.",
				};
			}
		}
		return {
			ok: true,
			message: pageChanged ? "Updated to the latest version." : "Already up to date.",
		};
	})();
	try {
		return await updating;
	} finally {
		updating = null;
	}
}
let ensuring = false;
function ensureApp() {
	if (ensuring || fs.existsSync(path.join(APP, "index.html"))) return;
	ensuring = true;
	update({ withHub: false })
		.then((r) => log("Fetched the web app:", r.message))
		.catch((e) => log("Couldn't fetch the web app:", e.message))
		.finally(() => {
			ensuring = false;
		});
}
async function dailyUpdate() {
	if (!cfg.autoUpdate || Date.now() - lastWriteAt < 15 * 60000) return;
	try {
		const r = await update({ withHub: false });
		if (r.message && !/up to date/i.test(r.message)) log("Daily update:", r.message);
	} catch (e) {
		log("Daily update failed:", e.message);
	}
}

/* ---------- the links each device can use ---------- */
function lanAddresses() {
	const out = [];
	for (const list of Object.values(os.networkInterfaces()))
		for (const a of list || [])
			if (a.family === "IPv4" && !a.internal && !a.address.startsWith("100."))
				out.push(a.address);
	return out;
}
function links() {
	const name =
		cfg.lanName ||
		os
			.hostname()
			.toLowerCase()
			.replace(/\.local\.?$/, "");
	const lan = cfg.host === "127.0.0.1" ? "" : `http://${name}.local:${cfg.port}`;
	return {
		mac: `http://localhost:${cfg.port}`,
		lan,
		lanIp:
			cfg.host === "127.0.0.1" || !lanAddresses().length
				? ""
				: `http://${lanAddresses()[0]}:${cfg.port}`,
		ts: cfg.tsName
			? `https://${cfg.tsName.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
			: "",
	};
}
function status() {
	const meetings = listDocs(`${BASE}/index`, {}).filter(
		(x) => x.data && x.data.mode !== "werewolf",
	).length;
	const backups = backupList();
	return {
		hub: VERSION,
		api: HUB_API,
		app: appVersion(),
		claude: !!cfg.claudeKey,
		speech: !!cfg.speechKey,
		local: speechInfo(),
		code: cfg.code,
		links: links(),
		meetings,
		backup: {
			last: backups.length ? backups[backups.length - 1].match(BACKUP_RE)[1] : "",
			folder: BACKUPS,
		},
		update: {
			checkedAt: lastCheck.at,
			latest: lastCheck.latest,
			error: lastCheck.error,
			page: !!lastCheck.latest && lastCheck.latest !== appVersion(),
			hub: hubChanged() || lastCheck.hubApi > HUB_API,
			auto: cfg.autoUpdate,
		},
	};
}
function cleanKey(v) {
	if (v === undefined) return undefined;
	const k = String(v).trim();
	if (k.length > 400 || /\s/.test(k))
		throw Object.assign(new Error("That doesn't look like a key."), { status: 400 });
	return k;
}

/* ---------- the requests ---------- */
async function api(req, res, url) {
	const route = url.pathname;
	if (route === "/api/hello")
		return sendJson(res, 200, { hub: true, api: HUB_API, version: VERSION, app: appVersion() });
	if (route === "/api/pair/local") {
		if (!fromThisMac(req))
			return sendJson(res, 403, {
				error: { type: "permission_error", message: "Only this Mac can do that." },
			});
		return sendJson(res, 200, { code: cfg.code });
	}
	if (!authorised(req)) {
		const slow = tooManyMisses(clientOf(req));
		return sendJson(
			res,
			slow ? 429 : 401,
			hubError(
				slow ? "rate_limit_error" : "authentication_error",
				slow
					? "Too many wrong codes. Wait 10 minutes, then try again."
					: "This device isn't connected to the Mac mini yet: enter the Mac mini's code on the Home screen.",
			),
		);
	}
	if (route === "/v1/messages" && req.method === "POST") return claudeMessages(req, res);
	if (route === "/api/speech-key" && req.method === "POST") return speechKey(res);
	if (route.startsWith("/api/transcribe")) return recordingsApi(req, res, url);
	if (route === "/api/speech" && req.method === "GET") return sendJson(res, 200, speechInfo());
	if (route === "/api/speech/setup" && req.method === "POST") {
		if (local.state !== "ready") setupSpeech();
		return sendJson(res, 200, speechInfo());
	}
	if (route === "/api/status" && req.method === "GET") {
		if (Date.now() - lastCheck.at > 6 * 3600000) checkUpdate().catch(() => null);
		return sendJson(res, 200, status());
	}
	if (route === "/api/keys" && req.method === "PUT") {
		const body = await readJson(req, 64 * 1024);
		const claude = cleanKey(body.claudeKey);
		const speech = cleanKey(body.speechKey);
		if (claude !== undefined) cfg.claudeKey = claude;
		if (speech !== undefined) cfg.speechKey = speech;
		saveConfig();
		log(
			`Keys changed (Claude ${cfg.claudeKey ? "set" : "empty"}, speech ${cfg.speechKey ? "set" : "empty"}).`,
		);
		return sendJson(res, 200, { claude: !!cfg.claudeKey, speech: !!cfg.speechKey });
	}
	if (route === "/api/update") {
		if (req.method === "GET")
			return sendJson(res, 200, { ...(await checkUpdate()), status: status().update });
		if (req.method === "POST") {
			const r = await update({ withHub: true });
			sendJson(res, r.ok ? 200 : 502, r);
			if (r.restart) setTimeout(() => process.exit(0), 500);
			return;
		}
	}
	if (route === "/api/backup" && req.method === "POST") {
		const name = backupNow();
		return sendJson(res, 200, { name: name || "" });
	}
	if (route === "/api/db/watch" && req.method === "GET") {
		res.writeHead(200, {
			...SECURITY,
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		res.write(`data: ${JSON.stringify({ hello: true, app: appVersion() })}\n\n`);
		watchers.add(res);
		const ping = setInterval(() => res.write(": ping\n\n"), 20000);
		res.on("close", () => {
			clearInterval(ping);
			watchers.delete(res);
		});
		return;
	}
	if (route === "/api/db/doc") {
		const p = checkPath(url.searchParams.get("p"), "doc");
		if (req.method === "GET") {
			const d = docs.get(p);
			return sendJson(
				res,
				200,
				d ? { exists: true, data: d.data, at: d.at } : { exists: false },
			);
		}
		if (req.method === "PUT") {
			const body = await readJson(req);
			if (
				!body ||
				typeof body.data !== "object" ||
				body.data === null ||
				Array.isArray(body.data)
			)
				return sendJson(res, 400, {
					error: { type: "invalid_request_error", message: "A document is an object." },
				});
			putDoc(p, body.data);
			return sendJson(res, 200, { ok: true });
		}
		if (req.method === "DELETE") {
			deleteDoc(p);
			return sendJson(res, 200, { ok: true });
		}
	}
	if (route === "/api/db/col" && req.method === "GET") {
		const p = checkPath(url.searchParams.get("p"), "col");
		const order = url.searchParams.get("order") || "";
		if (order && !/^[A-Za-z0-9_]{1,40}$/.test(order)) throw badPath("That isn't a field name.");
		const list = listDocs(p, {
			order,
			dir: url.searchParams.get("dir") === "desc" ? "desc" : "asc",
			limit: Math.min(5000, Number(url.searchParams.get("limit")) || 0),
		});
		return sendJson(res, 200, { docs: list });
	}
	return notFound(res);
}
const server = http.createServer(async (req, res) => {
	let url;
	try {
		url = new URL(req.url, "http://hub");
	} catch {
		return notFound(res);
	}
	try {
		if (url.pathname.startsWith("/api/") || url.pathname === "/v1/messages")
			return await api(req, res, url);
		if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
		let name = "index.html";
		if (url.pathname !== "/") {
			try {
				name = decodeURIComponent(url.pathname.slice(1));
			} catch {
				return notFound(res);
			}
		}
		return serveApp(req, res, name);
	} catch (e) {
		if (!e.status) log("Error:", e.stack || e.message);
		sendJson(res, e.status || 500, {
			error: {
				type: e.type || (e.status ? "invalid_request_error" : "api_error"),
				message: e.status ? e.message : "Something went wrong on the Mac mini.",
			},
		});
	}
});

function main() {
	const count = loadNotes();
	server.listen(cfg.port, cfg.host, () => {
		log(
			`AllKnowing ${VERSION} on port ${cfg.port} (${cfg.host === "127.0.0.1" ? "this Mac only" : "this Mac and your home network"}), ${count} stored documents, app ${appVersion() || "missing"}.`,
		);
		ensureApp();
		backupIfDue();
		startSpeech();
		loadJobs();
		tidyRecordings();
		if (cfg.keepAwake && process.platform === "darwin") {
			try {
				spawn("/usr/bin/caffeinate", ["-is", "-w", String(process.pid)], {
					stdio: "ignore",
				}).on("error", () => null);
			} catch {
				/* the Mac's own sleep settings decide */
			}
		}
		setTimeout(() => checkUpdate().catch(() => null), 5000);
	});
	server.on("error", (e) => {
		log(
			e.code === "EADDRINUSE"
				? `Port ${cfg.port} is already in use by something else.`
				: `Couldn't start: ${e.message}`,
		);
		process.exit(1);
	});
	setInterval(backupIfDue, 3600000).unref();
	setInterval(tidyRecordings, 3600000).unref();
	setInterval(dailyUpdate, 6 * 3600000).unref();
	for (const sig of ["SIGTERM", "SIGINT"])
		process.on(sig, () => {
			for (const res of watchers) res.end();
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 2000).unref();
		});
}
// Run as the server; or, loaded by a check, hand over the parts that read, cut and stitch recordings.
if (require.main === module) main();
else
	module.exports = {
		probeRecording,
		partRanges,
		cutParts,
		stitch,
		adtsConfig,
		SHORT_PART,
		LONG_PART,
		OVERLAP,
	};
