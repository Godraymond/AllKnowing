// Checks the Mac relay (relay/relay.cjs) against a stand-in for Claude Code (relay/fake-claude.cjs).
// Run: node assistant/check-relay.cjs
// It starts the relay on a spare port, sends it requests the way the web app does, and checks what comes back,
// what Claude Code was asked to run, and that a request the phone gives up on stops Claude Code too.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RELAY = path.join(__dirname, "relay", "relay.cjs");
const FAKE = path.join(__dirname, "relay", "fake-claude.cjs");
fs.chmodSync(FAKE, 0o755);
const CODE = "TEST-CODE-ABCD-2345";
const ORIGIN = "https://godraymond.github.io";
let fails = 0;
const ok = (name, pass, detail = "") => {
	if (!pass) fails++;
	console.log(
		`${pass ? "PASS" : "FAIL"} ${name}${pass || !detail ? "" : `\n   ${String(detail).slice(0, 500)}`}`,
	);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startRelay(extraEnv = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-relay-"));
	const port = 40000 + Math.floor(Math.random() * 20000);
	const env = {
		...process.env,
		AK_RELAY_DIR: dir,
		AK_RELAY_PORT: String(port),
		AK_RELAY_CODE: CODE,
		AK_RELAY_CLAUDE: FAKE,
		// Long enough for a slow test machine to start the stand-in and report an early failure.
		AK_RELAY_HOLD_MS: "1500",
		FAKE_CLAUDE_LATE_MS: "2600",
		AK_RELAY_KEEP_AWAKE: "0",
		AK_RELAY_MAX_JOBS: "2",
		ANTHROPIC_API_KEY: "sk-ant-must-not-reach-claude-code",
		FAKE_CLAUDE_LOG: path.join(dir, "runs.jsonl"),
		FAKE_CLAUDE_REJECT_FILE: path.join(dir, "reject.txt"),
		...extraEnv,
	};
	const child = spawn(process.execPath, [RELAY], { env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (c) => {
		output += c;
	});
	child.stderr.on("data", (c) => {
		output += c;
	});
	const base = `http://127.0.0.1:${port}`;
	const runs = () =>
		fs.existsSync(env.FAKE_CLAUDE_LOG)
			? fs
					.readFileSync(env.FAKE_CLAUDE_LOG, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	return {
		dir,
		base,
		child,
		runs,
		output: () => output,
		ready: async () => {
			for (let i = 0; i < 50; i++) {
				try {
					if ((await fetch(base)).ok) return true;
				} catch {
					/* not listening yet */
				}
				await sleep(100);
			}
			return false;
		},
		stop: () => child.kill(),
	};
}
// A request as the web app sends it.
const ask = (relay, prompt, opts = {}) =>
	fetch(`${relay.base}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: ORIGIN,
			"x-api-key": opts.key === undefined ? CODE : opts.key,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		body: JSON.stringify({
			model: opts.model || "claude-haiku-5-5",
			max_tokens: 2048,
			stream: true,
			system: opts.system,
			messages: [{ role: "user", content: opts.content || [{ type: "text", text: prompt }] }],
			output_config: opts.effort === null ? undefined : { effort: opts.effort || "low" },
		}),
		signal: opts.signal,
	});
// An error answer, whether it came as JSON (before the answer started) or as an event in the stream.
async function errorOf(res) {
	const raw = await res.text();
	try {
		return JSON.parse(raw).error || {};
	} catch {
		const ev = readSse(raw).error;
		return Object.assign({ cameAsStream: true }, ev ? ev.error : {});
	}
}
// The streamed answer: its text, how it stopped, and any error event.
function readSse(raw) {
	const events = raw
		.split("\n\n")
		.map((block) => block.split("\n").find((l) => l.startsWith("data:")))
		.filter(Boolean)
		.map((l) => JSON.parse(l.slice(5)));
	return {
		text: events
			.filter((e) => e.type === "content_block_delta")
			.map((e) => e.delta.text)
			.join(""),
		stop: (events.find((e) => e.type === "message_delta") || { delta: {} }).delta.stop_reason,
		ended: events.some((e) => e.type === "message_stop"),
		error: events.find((e) => e.type === "error"),
		types: events.map((e) => e.type),
	};
}
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

(async () => {
	const relay = startRelay();
	ok("the relay starts and listens", await relay.ready(), relay.output());

	// ---- reaching it ----
	const home = await fetch(relay.base);
	ok(
		"its front page says it's running, without the code",
		home.status === 200 && /relay is running/.test(await home.text()),
	);
	const pre = await fetch(`${relay.base}/v1/messages`, {
		method: "OPTIONS",
		headers: {
			origin: ORIGIN,
			"access-control-request-method": "POST",
			"access-control-request-headers": "content-type,x-api-key,anthropic-version",
			"access-control-request-private-network": "true",
		},
	});
	ok(
		"the phone's preflight is answered for the web app's address",
		pre.status === 204 &&
			pre.headers.get("access-control-allow-origin") === ORIGIN &&
			/x-api-key/.test(pre.headers.get("access-control-allow-headers")) &&
			pre.headers.get("access-control-allow-private-network") === "true",
	);
	const evil = await fetch(`${relay.base}/v1/messages`, {
		method: "OPTIONS",
		headers: { origin: "https://example.com", "access-control-request-method": "POST" },
	});
	ok("another website's preflight is not", !evil.headers.get("access-control-allow-origin"));
	const noKey = await ask(relay, "Hello", { key: "" });
	const noKeyBody = { error: await errorOf(noKey) };
	ok(
		"without the pairing code: refused, with words for the user",
		noKey.status === 401 &&
			noKeyBody.error.relay === true &&
			/pairing code/.test(noKeyBody.error.message) &&
			noKey.headers.get("access-control-allow-origin") === ORIGIN,
	);
	const wrongKey = await ask(relay, "Hello", { key: "TEST-CODE-ABCD-2346" });
	ok("a wrong code: refused", wrongKey.status === 401);
	ok("nothing ran for refused requests", relay.runs().length === 0);

	// ---- answers ----
	const IMG = {
		type: "image",
		source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
	};
	const r1 = await ask(relay, "", {
		key: "test code abcd 2345",
		content: [IMG, { type: "text", text: "MODE=partial Hello from the table。你好" }],
		system: "Reply with JSON only.",
	});
	const s1 = readSse(await r1.text());
	ok("a typed code works too (spaces, lower case)", r1.status === 200);
	ok(
		"a streamed answer comes back whole, Chinese included",
		s1.text === "Hello from the table。你好" && s1.stop === "end_turn" && s1.ended,
		JSON.stringify(s1),
	);
	ok(
		"it is a stream the web app reads like the API's",
		r1.headers.get("content-type").startsWith("text/event-stream") &&
			s1.types[0] === "message_start" &&
			r1.headers.get("access-control-allow-origin") === ORIGIN,
	);
	const run1 = relay.runs()[0] || {};
	const has = (flag, value) => {
		const i = run1.argv.indexOf(flag);
		return i >= 0 && (value === undefined || run1.argv[i + 1] === value);
	};
	ok(
		"Claude Code runs in print mode with streamed JSON in and out",
		has("-p") &&
			has("--input-format", "stream-json") &&
			has("--output-format", "stream-json") &&
			has("--verbose") &&
			has("--include-partial-messages"),
		JSON.stringify(run1.argv),
	);
	ok(
		"with no tools, no MCP servers, no slash commands, nothing kept",
		has("--tools", "") &&
			has("--strict-mcp-config") &&
			has("--disable-slash-commands") &&
			has("--no-session-persistence") &&
			has("--permission-prompts", "none"),
	);
	ok(
		"with the model, effort and instructions asked for",
		run1.model === "claude-haiku-5-5" &&
			run1.effort === "low" &&
			run1.system === "Reply with JSON only.",
	);
	ok(
		"the picture and the text reach Claude Code as one user message",
		run1.lineType === "user" && JSON.stringify(run1.types) === '["image","text"]',
	);
	ok("never with an API key, so the plan's sign-in is used", run1.hasApiKey === false);
	ok("in the relay's own empty folder", run1.cwd === path.join(relay.dir, "work"));

	const s2 = readSse(await (await ask(relay, "MODE=whole Said once", { effort: null })).text());
	ok(
		"an older Claude Code without partial messages: the text still comes, once",
		s2.text === "Said once",
		JSON.stringify(s2),
	);
	ok("no effort asked: none passed", relay.runs()[1].effort === undefined);
	ok("no instructions given: the relay's own", /AllKnowing/.test(relay.runs()[1].system));
	const s3 = readSse(await (await ask(relay, "MODE=resultonly Only in the result")).text());
	ok("text only in the final result: still comes", s3.text === "Only in the result");

	// ---- failures ----
	const r4 = await ask(relay, "MODE=notloggedin");
	const b4 = { error: await errorOf(r4) };
	ok(
		"not signed in: 401 that says how to sign in",
		r4.status === 401 &&
			/isn't signed in/.test(b4.error.message) &&
			/claude auth login/.test(b4.error.message),
		JSON.stringify(b4),
	);
	const r5 = await ask(relay, "MODE=limit");
	const b5 = { error: await errorOf(r5) };
	ok(
		"out of plan usage: 429 that says when it resets",
		r5.status === 429 &&
			b5.error.type === "rate_limit_error" &&
			/usage limit\. It resets /.test(b5.error.message),
		JSON.stringify(b5),
	);
	const r6 = await ask(relay, "MODE=crash");
	const b6 = { error: await errorOf(r6) };
	ok(
		"Claude Code crashing: 500 with its words",
		r6.status === 500 && /Something broke inside Claude Code/.test(b6.error.message),
		JSON.stringify(b6),
	);
	const s7 = readSse(await (await ask(relay, "MODE=lateerror")).text());
	ok(
		"an error after the answer started: an error event in the stream",
		s7.text === "Half an ans" && s7.error && s7.error.error.relay === true && !s7.ended,
		JSON.stringify(s7),
	);
	const r8 = await ask(relay, "", { content: [] });
	ok("nothing to ask: 400", r8.status === 400);
	await ask(relay, "MODE=whole x", { model: "claude-x; rm -rf ~" }).then((r) => r.text());
	ok("a strange model name is not passed on", relay.runs().pop().model === "sonnet");

	// ---- a slow start: the answer opens before the first words, so the phone isn't left waiting ----
	const t0 = Date.now();
	const r9 = await ask(relay, "MODE=late Late words");
	const headersAt = Date.now() - t0;
	const s9 = readSse(await r9.text());
	ok(
		"the stream opens before Claude starts writing",
		r9.status === 200 && headersAt < 2400 && s9.text === "Late words",
		`${headersAt}ms`,
	);

	// ---- the phone gives up: Claude Code is stopped ----
	const ctl = new AbortController();
	const slow = ask(relay, "MODE=slow", { signal: ctl.signal }).catch(() => null);
	await sleep(600);
	const slowRun = relay.runs().pop();
	ctl.abort();
	await slow;
	let stopped = false;
	for (let i = 0; i < 40 && !stopped; i++) {
		await sleep(100);
		stopped = !alive(slowRun.pid);
	}
	ok("a request the phone drops stops Claude Code", slowRun.prompt === "MODE=slow" && stopped);

	// ---- a busy Mac ----
	const c1 = new AbortController();
	const c2 = new AbortController();
	const busy1 = ask(relay, "MODE=slow", { signal: c1.signal }).catch(() => null);
	const busy2 = ask(relay, "MODE=slow", { signal: c2.signal }).catch(() => null);
	await sleep(400);
	const r10 = await ask(relay, "MODE=whole third");
	const b10 = { error: await errorOf(r10) };
	ok(
		"more requests at once than allowed: 429 that says so",
		r10.status === 429 && /already answering/.test(b10.error.message),
	);
	c1.abort();
	c2.abort();
	await Promise.all([busy1, busy2]);
	await sleep(300);

	// ---- a Claude Code that doesn't know a flag after all ----
	fs.writeFileSync(path.join(relay.dir, "reject.txt"), "--effort\n");
	const before = relay.runs().length;
	const s11 = readSse(
		await (await ask(relay, "MODE=whole Without effort", { effort: "medium" })).text(),
	);
	const tries = relay.runs().slice(before);
	ok(
		"it asks again without the flag Claude Code turned down",
		s11.text === "Without effort" && tries.length === 1 && !tries[0].argv.includes("--effort"),
		JSON.stringify(tries.map((t) => t.argv.includes("--effort"))),
	);
	readSse(await (await ask(relay, "MODE=whole Again", { effort: "medium" })).text());
	ok("and remembers not to pass it again", !relay.runs().pop().argv.includes("--effort"));

	// ---- health ----
	const h = await (
		await fetch(`${relay.base}/health`, { headers: { "x-api-key": CODE } })
	).json();
	ok(
		"health: Claude Code found, its version, signed in",
		h.ok === true &&
			h.claude.found === true &&
			h.claude.loggedIn === true &&
			/2\.1\.325/.test(h.claude.version),
		JSON.stringify(h),
	);
	ok("health needs the code too", (await fetch(`${relay.base}/health`)).status === 401);
	ok("the log names no prompt text", !/Hello from the table|Said once/.test(relay.output()));
	relay.stop();

	// ---- signed out, and Claude Code missing ----
	const out = startRelay({ FAKE_CLAUDE_LOGGED_IN: "0" });
	await out.ready();
	const h2 = await (await fetch(`${out.base}/health`, { headers: { "x-api-key": CODE } })).json();
	ok("health when signed out: says so", h2.claude.found === true && h2.claude.loggedIn === false);
	out.stop();
	const none = startRelay({ AK_RELAY_CLAUDE: path.join(os.tmpdir(), "no-such-claude") });
	await none.ready();
	const h3 = await (
		await fetch(`${none.base}/health`, { headers: { "x-api-key": CODE } })
	).json();
	const r12 = await ask(none, "Hello");
	const b12 = { error: await errorOf(r12) };
	ok(
		"Claude Code not installed: health and answers say so",
		h3.claude.found === false && r12.status === 500 && /wasn't found/.test(b12.error.message),
		JSON.stringify(b12),
	);
	none.stop();
	const bad = startRelay({ AK_RELAY_CODE: "short" });
	await sleep(500);
	ok(
		"it won't start without a proper pairing code",
		bad.child.exitCode === 1 && /pairing code/.test(bad.output()),
	);

	console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
	process.exit(fails ? 1 : 0);
})();
