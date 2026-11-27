#!/usr/bin/env node
// AllKnowing relay: lets the AllKnowing web app on your phone use Claude through Claude Code on this Mac,
// signed in with your Claude plan, instead of an API key.
//
// It answers a small part of the Anthropic Messages API (POST /v1/messages, streamed), so the web app talks
// to it as it would to the API. Each request runs `claude -p` once: no tools, no MCP servers, nothing saved.
// Only a request carrying the pairing code is answered. It listens on this Mac only (127.0.0.1); Tailscale
// Serve makes it reachable from your own devices over HTTPS.
//
//   node relay.cjs            settings in config.json next to this file: port, code, claude, origins, keepAwake
//
// Installed and started by install.sh in this folder. Uses only Node's own modules.
"use strict";
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = "1.0";
const DIR = process.env.AK_RELAY_DIR || __dirname;
const WORK = path.join(DIR, "work");
const DEFAULT_SYSTEM =
	"You are Claude, answering inside AllKnowing, a meeting assistant. Do exactly what the user's message asks, in the format it asks for.";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function loadConfig() {
	let file = {};
	try {
		file = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
	} catch {
		/* not written yet: environment only */
	}
	const env = process.env;
	const list = (v) =>
		String(v)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	return {
		port: Number(env.AK_RELAY_PORT || file.port || 47823),
		code: String(env.AK_RELAY_CODE || file.code || ""),
		claude: String(env.AK_RELAY_CLAUDE || file.claude || "claude"),
		origins: env.AK_RELAY_ORIGINS
			? list(env.AK_RELAY_ORIGINS)
			: file.origins || ["https://godraymond.github.io"],
		keepAwake: file.keepAwake !== false && env.AK_RELAY_KEEP_AWAKE !== "0",
		maxJobs: Number(env.AK_RELAY_MAX_JOBS || file.maxJobs || 3),
		timeoutMs: Number(env.AK_RELAY_TIMEOUT_MS || file.timeoutMs || 300000),
		// How long to wait for an early failure (not signed in, out of usage) before starting the answer anyway.
		holdMs: Number(env.AK_RELAY_HOLD_MS || 8000),
	};
}
const cfg = loadConfig();
// Codes are compared without spaces, dashes or case, so a typed code works as well as a pasted one.
const plain = (code) =>
	String(code || "")
		.replace(/[^A-Za-z0-9]/g, "")
		.toUpperCase();
if (plain(cfg.code).length < 12) {
	console.error("No pairing code is set. Run the installer again.");
	process.exit(1);
}
const sha = (s) => crypto.createHash("sha256").update(s).digest();
const CODE_HASH = sha(plain(cfg.code));
fs.mkdirSync(WORK, { recursive: true });

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const short = (s, n = 240) =>
	String(s || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, n);
// What Claude Code gets to see of this Mac's environment: everything but an API key, so it uses the plan's sign-in.
function childEnv() {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !/^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/.test(k)),
	);
	env.PATH = [
		path.dirname(cfg.claude),
		env.PATH || "",
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	]
		.filter(Boolean)
		.join(":");
	return env;
}
function run(args, timeout = 20000) {
	return new Promise((resolve) => {
		execFile(
			cfg.claude,
			args,
			{ timeout, env: childEnv(), cwd: WORK, maxBuffer: 1 << 20 },
			(err, stdout, stderr) =>
				resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }),
		);
	});
}

// Which of the flags this relay uses the installed Claude Code knows. Unknown ones are left out.
let flags = null;
async function knownFlags() {
	if (!flags) {
		const help = await run(["--help"]);
		flags = new Set(help.stdout.match(/--[a-z][a-z-]+/g) || []);
	}
	return flags;
}
async function claudeArgs(job) {
	const f = await knownFlags();
	const has = (flag) => f.has(flag) && !job.dropped.has(flag);
	const args = [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
	];
	if (has("--include-partial-messages")) args.push("--include-partial-messages");
	// Nothing to do but answer: no tools, no MCP servers, no slash commands, nothing kept afterwards.
	if (has("--tools")) args.push("--tools", "");
	if (has("--strict-mcp-config")) args.push("--strict-mcp-config");
	if (has("--disable-slash-commands")) args.push("--disable-slash-commands");
	if (has("--no-session-persistence")) args.push("--no-session-persistence");
	if (has("--permission-prompts")) args.push("--permission-prompts", "none");
	args.push("--model", job.model);
	if (job.effort && has("--effort")) args.push("--effort", job.effort);
	args.push("--system-prompt", job.system);
	return args;
}

/* ---------- HTTP plumbing ---------- */
function allowedOrigin(origin) {
	if (!origin) return "";
	if (cfg.origins.includes(origin)) return origin;
	return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : "";
}
function cors(req) {
	const origin = allowedOrigin(req.headers.origin);
	if (!origin) return { vary: "Origin" };
	return {
		vary: "Origin",
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers":
			"content-type, x-api-key, authorization, anthropic-version, anthropic-dangerous-direct-browser-access",
		"access-control-allow-private-network": "true",
		"access-control-max-age": "600",
	};
}
const ERROR_TYPE = {
	400: "invalid_request_error",
	401: "authentication_error",
	402: "billing_error",
	403: "permission_error",
	404: "not_found_error",
	413: "request_too_large",
	429: "rate_limit_error",
	529: "overloaded_error",
};
// `relay: true` tells the web app the message is written for the user and can be shown as it is.
const errorBody = (status, message) => ({
	type: "error",
	error: { type: ERROR_TYPE[status] || "api_error", message, relay: true },
});
function sendJson(req, res, status, body) {
	if (res.headersSent) return;
	res.writeHead(status, {
		...cors(req),
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
}
function authorised(req) {
	const given =
		req.headers["x-api-key"] ||
		String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
	return crypto.timingSafeEqual(sha(plain(given)), CODE_HASH);
}
function readBody(req, limit = 30 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) {
				reject(Object.assign(new Error("too large"), { status: 413 }));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/* ---------- what Claude Code's failures mean for the user ---------- */
const SIGN_IN =
	"Claude Code on your Mac isn't signed in. On the Mac, open Terminal and run: claude auth login";
function resetTime(resetsAt) {
	const n = Number(resetsAt);
	if (!n) return "";
	const when = new Date(n < 1e12 ? n * 1000 : n);
	const opts = { hour: "numeric", minute: "2-digit" };
	if (when - Date.now() > 20 * 3600 * 1000) opts.weekday = "long";
	return when.toLocaleString(undefined, opts);
}
const limitMessage = (resetsAt) => {
	const at = resetTime(resetsAt);
	return `You've reached your Claude plan's usage limit${at ? `. It resets ${at}` : ""}. Until then, switch Live updates to Fast in Settings, or wait.`;
};
// Claude Code's own error codes on an assistant message.
const ASSISTANT_ERRORS = {
	authentication_failed: [401, SIGN_IN],
	verification_required: [
		401,
		"Claude needs you to confirm your account. On the Mac, open Terminal and run: claude",
	],
	oauth_org_not_allowed: [
		403,
		"Your Claude organisation doesn't allow Claude Code to sign in this way.",
	],
	account_on_hold: [403, "Your Claude account is on hold. Check claude.ai."],
	billing_error: [
		402,
		"Claude says there's a billing problem with your plan. Check claude.ai → Settings → Billing.",
	],
	rate_limit: [429, ""],
	overloaded: [529, "Claude is overloaded right now. Try again in a minute."],
	invalid_request: [400, ""],
	model_not_found: [
		404,
		"Claude Code on your Mac can't use that model. Pick another model on the phone.",
	],
};
function classify(text, limitReset) {
	const t = String(text || "");
	if (
		/not (logged|signed) in|please run \/login|\/login|invalid api key|oauth|token (has )?expired|credentials?/i.test(
			t,
		)
	)
		return [401, SIGN_IN];
	if (
		limitReset !== undefined ||
		/usage limit|limit reached|hit your .*limit|rate.?limit/i.test(t)
	)
		return [429, limitMessage(limitReset)];
	if (/overloaded/i.test(t))
		return [529, "Claude is overloaded right now. Try again in a minute."];
	if (
		/model/i.test(t) &&
		/not (found|available|supported)|invalid|unknown|does not exist|isn't available/i.test(t)
	)
		return [
			404,
			`Claude Code on your Mac can't use that model (${short(t, 160)}). Pick another model on the phone.`,
		];
	if (/credit|billing|payment/i.test(t)) return [402, `Claude said: ${short(t)}`];
	return [500, `Claude Code on your Mac stopped with an error: ${short(t) || "no details"}.`];
}

/* ---------- one request: run claude -p and stream its answer ---------- */
function contentBlocks(content) {
	if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	return content.filter(
		(b) =>
			b &&
			((b.type === "text" && typeof b.text === "string") ||
				(b.type === "image" &&
					b.source &&
					b.source.type === "base64" &&
					typeof b.source.data === "string")),
	);
}
function systemText(system) {
	if (typeof system === "string") return system.trim();
	if (Array.isArray(system))
		return system
			.map((b) => (b && typeof b.text === "string" ? b.text : ""))
			.join("\n")
			.trim();
	return "";
}

let jobs = 0;
async function messages(req, res) {
	let body;
	try {
		body = JSON.parse(await readBody(req));
	} catch (e) {
		sendJson(
			req,
			res,
			e.status || 400,
			errorBody(
				e.status || 400,
				e.status === 413
					? "That request is too big for the relay."
					: "The relay couldn't read that request.",
			),
		);
		return;
	}
	const turns = Array.isArray(body.messages) ? body.messages : [];
	const last = [...turns].reverse().find((m) => m && m.role === "user");
	const content = last ? contentBlocks(last.content) : [];
	if (!content.length) {
		sendJson(req, res, 400, errorBody(400, "There was nothing to ask Claude."));
		return;
	}
	const model = /^claude-[a-z0-9.-]+$|^(sonnet|haiku|opus|fable)$/i.test(String(body.model || ""))
		? String(body.model)
		: "sonnet";
	const effortAsked = body.output_config && body.output_config.effort;
	const job = {
		model,
		effort: EFFORTS.includes(effortAsked) ? effortAsked : "",
		system: systemText(body.system) || DEFAULT_SYSTEM,
		content,
		dropped: new Set(),
	};
	if (jobs >= cfg.maxJobs) {
		sendJson(
			req,
			res,
			429,
			errorBody(
				429,
				"Your Mac is already answering several requests. Try again in a moment.",
			),
		);
		return;
	}
	jobs++;
	const started = Date.now();
	let outcome = "?";
	try {
		for (let attempt = 0; attempt < 4; attempt++) {
			const result = await answer(req, res, job);
			outcome = result.outcome;
			if (!result.retryWithout) break;
			job.dropped.add(result.retryWithout);
			if (flags) flags.delete(result.retryWithout);
		}
	} finally {
		jobs--;
		log(
			`answer ${model}${job.effort ? `/${job.effort}` : ""} ${outcome} ${Date.now() - started}ms`,
		);
	}
}

// Runs claude once. Resolves with what happened; asks for a retry when Claude Code didn't know one of the flags.
function answer(req, res, job) {
	return new Promise((resolve) => {
		const state = {
			text: false,
			open: false,
			done: false,
			stop: "end_turn",
			limitReset: undefined,
			failure: null,
		};
		let child = null;
		let lineBuf = "";
		let stderr = "";
		let ping = null;
		let hold = null;
		let timer = null;
		const id = `msg_relay_${crypto.randomBytes(8).toString("hex")}`;
		const sse = (event, data) =>
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		// Starts the streamed answer: from here on, errors go out as stream events.
		const open = () => {
			if (state.open || res.writableEnded) return;
			state.open = true;
			clearTimeout(hold);
			res.writeHead(200, {
				...cors(req),
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			});
			sse("message_start", {
				type: "message_start",
				message: {
					id,
					type: "message",
					role: "assistant",
					model: job.model,
					content: [],
					stop_reason: null,
				},
			});
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			});
			ping = setInterval(() => sse("ping", { type: "ping" }), 10000);
		};
		const text = (t) => {
			if (!t || state.done) return;
			open();
			state.text = true;
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: t },
			});
		};
		const kill = () => {
			if (child && child.exitCode === null && !child.killed) {
				child.kill("SIGTERM");
				const c = child;
				setTimeout(() => {
					if (c.exitCode === null) c.kill("SIGKILL");
				}, 3000).unref();
			}
		};
		const finish = (outcome, extra = {}) => {
			if (state.done) return;
			state.done = true;
			clearInterval(ping);
			clearTimeout(hold);
			clearTimeout(timer);
			kill();
			resolve({ outcome, ...extra });
		};
		const fail = (status, message) => {
			if (state.done) return;
			if (!state.open) sendJson(req, res, status, errorBody(status, message));
			else {
				sse("error", errorBody(status, message));
				res.end();
			}
			finish(`error ${status}`);
		};
		const succeed = () => {
			if (state.done) return;
			open();
			sse("content_block_stop", { type: "content_block_stop", index: 0 });
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: state.stop, stop_sequence: null },
				usage: { output_tokens: 0 },
			});
			sse("message_stop", { type: "message_stop" });
			res.end();
			finish("ok");
		};
		const onMessage = (msg) => {
			if (!msg || typeof msg !== "object" || msg.parent_tool_use_id) return;
			if (msg.type === "stream_event") {
				const ev = msg.event || {};
				if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta")
					text(ev.delta.text);
				else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason)
					state.stop = ev.delta.stop_reason;
			} else if (msg.type === "assistant") {
				const m = msg.message || {};
				const said = (Array.isArray(m.content) ? m.content : [])
					.filter((b) => b && b.type === "text")
					.map((b) => b.text)
					.join("");
				if (msg.error && msg.error !== "max_output_tokens") {
					const [status, message] = ASSISTANT_ERRORS[msg.error] || classify(said);
					state.failure = [
						status,
						message ||
							(status === 429 ? limitMessage(state.limitReset) : classify(said)[1]),
					];
					return;
				}
				if (msg.error === "max_output_tokens") state.stop = "max_tokens";
				// Without partial messages the text arrives here, whole. With them it has already been sent.
				if (!state.text && said) text(said);
				if (m.stop_reason) state.stop = m.stop_reason;
			} else if (msg.type === "rate_limit_event") {
				const info = msg.rate_limit_info || {};
				if (info.status === "rejected" && info.overageStatus !== "allowed")
					state.limitReset = info.resetsAt || 0;
			} else if (msg.type === "result") {
				if (msg.is_error || msg.subtype !== "success") {
					const said =
						msg.result || (Array.isArray(msg.errors) ? msg.errors.join("; ") : "");
					const [status, message] = state.failure || classify(said, state.limitReset);
					fail(status, message);
				} else {
					if (!state.text && typeof msg.result === "string") text(msg.result);
					if (msg.stop_reason === "max_tokens") state.stop = "max_tokens";
					succeed();
				}
			}
		};

		claudeArgs(job).then((args) => {
			// The phone may have gone while the flags were checked (the close handler below has finished the job).
			if (state.done) return;
			try {
				child = spawn(cfg.claude, args, {
					cwd: WORK,
					env: childEnv(),
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (e) {
				fail(
					500,
					`Couldn't start Claude Code on your Mac (${e.code || e.message}). Run the installer again.`,
				);
				return;
			}
			child.on("error", (e) => {
				fail(
					500,
					e.code === "ENOENT"
						? "Claude Code wasn't found on your Mac. Run the installer again."
						: `Couldn't start Claude Code on your Mac (${e.code || e.message}).`,
				);
			});
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				lineBuf += chunk;
				let nl = lineBuf.indexOf("\n");
				while (nl >= 0) {
					const line = lineBuf.slice(0, nl).trim();
					lineBuf = lineBuf.slice(nl + 1);
					if (line.startsWith("{")) {
						let msg = null;
						try {
							msg = JSON.parse(line);
						} catch {
							/* not a whole message: skip it */
						}
						if (msg) onMessage(msg);
					}
					nl = lineBuf.indexOf("\n");
				}
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => {
				if (stderr.length < 20000) stderr += chunk;
			});
			child.on("close", (code) => {
				if (state.done) return;
				const unknown = stderr.match(/unknown option '?(--[a-z-]+)/i);
				if (unknown && !state.open && unknown[1] !== "--print" && unknown[1] !== "-p") {
					finish("retry", { retryWithout: unknown[1] });
					return;
				}
				if (state.failure) fail(state.failure[0], state.failure[1]);
				else if (state.text && code === 0) succeed();
				else {
					const [status, message] = classify(
						stderr || `exit code ${code}`,
						state.limitReset,
					);
					fail(status, message);
				}
			});
			child.stdin.on("error", () => {
				/* Claude Code exited before reading everything: the close handler says why */
			});
			child.stdin.end(
				`${JSON.stringify({ type: "user", message: { role: "user", content: job.content } })}\n`,
			);
			// An early failure (not signed in, out of usage) is told apart before anything is sent; after that, start the answer.
			hold = setTimeout(open, cfg.holdMs);
			timer = setTimeout(
				() => fail(500, "Claude Code on your Mac took too long to answer."),
				cfg.timeoutMs,
			);
		});
		// The phone gave up or went away: stop Claude Code too.
		res.on("close", () => {
			if (!state.done) finish("cancelled");
		});
	});
}

async function health(req, res) {
	const [status, version] = await Promise.all([
		run(["auth", "status", "--json"]),
		run(["--version"]),
	]);
	let auth = {};
	try {
		auth = JSON.parse(status.stdout);
	} catch {
		/* older Claude Code, or not installed */
	}
	const found = !(status.err && status.err.code === "ENOENT");
	sendJson(req, res, 200, {
		ok: true,
		relay: VERSION,
		claude: {
			found,
			version: short(version.stdout, 60),
			loggedIn: auth.loggedIn === true,
			authMethod: String(auth.authMethod || ""),
		},
	});
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://relay");
	if (req.method === "OPTIONS") {
		res.writeHead(204, cors(req));
		res.end();
		return;
	}
	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end("The AllKnowing relay is running on this Mac.\n");
		return;
	}
	if (!authorised(req)) {
		sendJson(
			req,
			res,
			401,
			errorBody(
				401,
				"The Mac didn't accept the pairing code. Copy the Mac link again from the installer on the Mac.",
			),
		);
		return;
	}
	if (req.method === "GET" && url.pathname === "/health")
		health(req, res).catch(() =>
			sendJson(req, res, 500, errorBody(500, "The relay couldn't check Claude Code.")),
		);
	else if (req.method === "POST" && url.pathname === "/v1/messages")
		messages(req, res).catch((e) =>
			sendJson(req, res, 500, errorBody(500, `The relay failed: ${short(e && e.message)}`)),
		);
	else sendJson(req, res, 404, errorBody(404, "Not something the relay does."));
});
server.listen(cfg.port, "127.0.0.1", () => {
	log(
		`AllKnowing relay ${VERSION} on http://127.0.0.1:${cfg.port}, Claude Code at ${cfg.claude}`,
	);
	knownFlags().then((f) => log(`Claude Code flags found: ${f.size}`));
	// Keep the Mac awake while the relay runs, so the phone can reach it (macOS only; stops when the relay stops).
	if (cfg.keepAwake && process.platform === "darwin") {
		try {
			spawn("/usr/bin/caffeinate", ["-is", "-w", String(process.pid)], {
				stdio: "ignore",
			}).unref();
		} catch {
			/* no caffeinate: the Mac's own energy settings decide */
		}
	}
});
server.on("error", (e) => {
	console.error(e.code === "EADDRINUSE" ? `Port ${cfg.port} is already in use on this Mac.` : e);
	process.exit(1);
});
// Started by the Mac mini's server (hub.cjs), the relay goes when the server goes, however suddenly, so
// it never sits on its port with a code nobody has any more.
if (process.send) process.on("disconnect", () => process.exit(0));
