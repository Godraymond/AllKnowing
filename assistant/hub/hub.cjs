#!/usr/bin/env node
/* AllKnowing on your Mac mini.

   One small server, with nothing to install but Node.js, that makes the Mac mini the home for AllKnowing:
   - it serves the web app (the same page as https://godraymond.github.io/AllKnowing/) to every device
   - it keeps every meeting, transcript and follow-up in one place, so the desktop, the Mac mini and the
     phones all see the same list, and an open page hears about changes as they happen
   - it keeps your Claude API key and your Soniox speech key on the Mac. Claude is asked through here, and
     a device that wants to listen gets a one-use speech key that lasts a minute, never the real one
   - a device gives the pairing code once before it can see or change anything (the Mac itself needn't)
   - it copies every note into a file once a day, and keeps the page up to date from GitHub

   Everything is in ~/AllKnowing (AK_HUB_HOME):
     config.json   port, pairing code and your keys (only you can read it)
     notes/        one JSON file per stored document
     backups/      "AllKnowing notes YYYY-MM-DD.json", one a day, the last 30 days
     app/          the web app's files
     hub/hub.cjs   this file
     logs/hub.log

   The installer (install.sh) sets this up with a LaunchAgent that starts it at login and keeps it running,
   and shares it on your own devices' Tailscale network over HTTPS. */
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");

const VERSION = "1.0";
// What the page may expect from this hub. A page that needs more waits for the hub to be updated.
const HUB_API = 1;
const HOME = process.env.AK_HUB_HOME || path.join(os.homedir(), "AllKnowing");
const CONFIG = path.join(HOME, "config.json");
const NOTES = path.join(HOME, "notes");
const BACKUPS = path.join(HOME, "backups");
const APP = path.join(HOME, "app");
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
		tsName: typeof c.tsName === "string" ? c.tsName : "",
		lanName:
			typeof c.lanName === "string" && /^[a-z0-9-]{1,63}$/.test(c.lanName) ? c.lanName : "",
		autoUpdate: c.autoUpdate !== false,
		// Phones can only reach a Mac that is awake. The screen may still sleep.
		keepAwake: c.keepAwake !== false,
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
function hubChanged() {
	const want = lastCheck.files["hub/hub.cjs"];
	return !!want && want !== localSha(__filename);
}
let updating = null;
async function update({ withHub }) {
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
			const isHub = name === "hub/hub.cjs";
			if (name.includes("..") || (!isHub && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)))
				continue;
			if (!isHub && !TYPES[path.extname(name).toLowerCase()]) continue;
			if (isHub ? !(withHub && needHub) : localSha(path.join(APP, name)) === want) continue;
			const buf = await fetchBuf(`${SOURCE}/${name}`);
			if (sha256(buf) !== want)
				return {
					ok: false,
					message: `The download of ${name} didn't match, so nothing was changed. Try again later.`,
				};
			staged.push({ name, buf, isHub });
		}
		const hub = staged.find((x) => x.isHub);
		if (hub) {
			// Named .cjs so Node checks it as what it is.
			const next = path.join(path.dirname(__filename), "hub.next.cjs");
			fs.writeFileSync(next, hub.buf);
			const check = spawnSync(process.execPath, ["--check", next], { encoding: "utf8" });
			if (check.status !== 0) {
				fs.rmSync(next, { force: true });
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
		if (hub) {
			fs.copyFileSync(__filename, `${__filename}.previous`);
			fs.renameSync(path.join(path.dirname(__filename), "hub.next.cjs"), __filename);
			log("Updated the Mac mini's server; restarting.");
			return {
				ok: true,
				restart: true,
				message:
					"Updated. The Mac mini restarts AllKnowing now; the page reconnects in a few seconds.",
			};
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

const count = loadNotes();
server.listen(cfg.port, cfg.host, () => {
	log(
		`AllKnowing ${VERSION} on port ${cfg.port} (${cfg.host === "127.0.0.1" ? "this Mac only" : "this Mac and your home network"}), ${count} stored documents, app ${appVersion() || "missing"}.`,
	);
	ensureApp();
	backupIfDue();
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
setInterval(dailyUpdate, 6 * 3600000).unref();
for (const sig of ["SIGTERM", "SIGINT"])
	process.on(sig, () => {
		for (const res of watchers) res.end();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 2000).unref();
	});
