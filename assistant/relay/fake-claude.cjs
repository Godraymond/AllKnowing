#!/usr/bin/env node
// A stand-in for the `claude` command, for testing the relay only. It never calls Claude.
// It writes what Claude Code writes in print mode with --output-format stream-json, as the Agent SDK's
// types describe it (@anthropic-ai/claude-agent-sdk 0.3.325): system, stream_event, assistant,
// rate_limit_event and result messages, one JSON object per line.
//
// The prompt picks the behaviour: it may start with MODE=<name>. Without one, FAKE_CLAUDE_REPLY can name
// a module that turns the prompt into a reply; otherwise it replies "OK".
// FAKE_CLAUDE_LOG names a file where each run appends what it was given, as one JSON line, and
// FAKE_CLAUDE_REJECT_FILE a file of flags to turn down as unknown.
"use strict";
const fs = require("node:fs");

const argv = process.argv.slice(2);
const logRun = (entry) => {
	if (process.env.FAKE_CLAUDE_LOG)
		fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
};
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FLAGS = (
	process.env.FAKE_CLAUDE_FLAGS ||
	"--print --output-format --input-format --verbose --include-partial-messages --tools --strict-mcp-config --disable-slash-commands --no-session-persistence --permission-prompts --model --effort --system-prompt"
).split(/\s+/);

if (argv[0] === "--help") {
	process.stdout.write(
		`Usage: claude [options]\n${FLAGS.map((f) => `  ${f}  something`).join("\n")}\n`,
	);
	process.exit(0);
}
if (argv[0] === "--version") {
	process.stdout.write("2.1.325 (Claude Code)\n");
	process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
	const loggedIn = process.env.FAKE_CLAUDE_LOGGED_IN !== "0";
	process.stdout.write(
		`${JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }, null, 2)}\n`,
	);
	process.exit(loggedIn ? 0 : 1);
}

const flagValue = (flag) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
// Flags this run turns down although --help lists them, as an older Claude Code would (one per line in the file).
let reject = [];
try {
	reject = fs
		.readFileSync(process.env.FAKE_CLAUDE_REJECT_FILE || "", "utf8")
		.split(/\s+/)
		.filter(Boolean);
} catch {
	/* nothing to turn down */
}
for (const a of argv) {
	if (a.startsWith("--") && (!FLAGS.includes(a) || reject.includes(a))) {
		process.stderr.write(`error: unknown option '${a}'\n`);
		process.exit(1);
	}
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
	input += c;
});
process.stdin.on("end", async () => {
	let message = {};
	try {
		message = JSON.parse(input.trim().split("\n")[0]);
	} catch {
		/* checked below */
	}
	const content = (message.message && message.message.content) || [];
	const prompt = (Array.isArray(content) ? content : [{ type: "text", text: String(content) }])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	logRun({
		pid: process.pid,
		argv,
		model: flagValue("--model"),
		effort: flagValue("--effort"),
		system: flagValue("--system-prompt"),
		types: (Array.isArray(content) ? content : []).map((b) => b.type),
		hasApiKey: !!process.env.ANTHROPIC_API_KEY,
		cwd: process.cwd(),
		prompt: prompt.slice(0, 200),
		lineType: message.type,
	});
	const mode =
		(prompt.match(/^MODE=(\w+)/) || [])[1] || process.env.FAKE_CLAUDE_MODE || "partial";
	let reply = "OK";
	if (process.env.FAKE_CLAUDE_REPLY)
		reply = String(
			require(process.env.FAKE_CLAUDE_REPLY)(prompt, { model: flagValue("--model") }),
		);
	else if (mode !== "partial" || prompt.startsWith("MODE="))
		reply = prompt.replace(/^MODE=\w+\s*/, "") || "OK";
	const session = "fake-session";
	const base = { parent_tool_use_id: null, session_id: session };
	out({
		type: "system",
		subtype: "init",
		model: flagValue("--model"),
		tools: [],
		session_id: session,
	});

	const assistant = (text, extra = {}) =>
		out({
			type: "assistant",
			message: {
				id: "msg_fake",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text }],
				stop_reason: "end_turn",
			},
			...base,
			...extra,
		});
	const result = (ok, text, extra = {}) =>
		out({
			type: "result",
			subtype: ok ? "success" : "error_during_execution",
			is_error: !ok,
			result: text,
			duration_ms: 10,
			num_turns: 1,
			stop_reason: ok ? "end_turn" : null,
			...base,
			...extra,
		});
	const stream = async (text) => {
		out({
			type: "stream_event",
			event: { type: "message_start", message: { id: "msg_fake", content: [] } },
			...base,
		});
		out({
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			},
			...base,
		});
		out({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "Let me think." },
			},
			...base,
		});
		out({
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "" },
			},
			...base,
		});
		for (let i = 0; i < text.length; i += 7) {
			out({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 1,
					delta: { type: "text_delta", text: text.slice(i, i + 7) },
				},
				...base,
			});
			await sleep(5);
		}
		out({
			type: "stream_event",
			event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
			...base,
		});
		out({ type: "stream_event", event: { type: "message_stop" }, ...base });
	};

	switch (mode) {
		case "whole": // Claude Code without partial messages: the text comes in the assistant message only
			assistant(reply);
			result(true, reply);
			break;
		case "resultonly":
			result(true, reply);
			break;
		case "notloggedin":
			assistant("Not logged in · Please run /login", { error: "authentication_failed" });
			result(false, "Not logged in · Please run /login");
			process.exitCode = 1;
			break;
		case "limit":
			out({
				type: "rate_limit_event",
				rate_limit_info: {
					status: "rejected",
					resetsAt: Math.floor(Date.now() / 1000) + 5400,
					rateLimitType: "five_hour",
				},
				...base,
			});
			assistant("You've hit your limit", { error: "rate_limit" });
			result(false, "You've hit your limit");
			process.exitCode = 1;
			break;
		case "lateerror":
			out({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Half an ans" },
				},
				...base,
			});
			await sleep(50);
			result(false, "API Error: 500 Internal server error");
			process.exitCode = 1;
			break;
		case "slow":
			await sleep(30000);
			await stream(reply);
			result(true, reply);
			break;
		case "late":
			await sleep(Number(process.env.FAKE_CLAUDE_LATE_MS || 600));
			await stream(reply);
			assistant(reply);
			result(true, reply);
			break;
		case "crash":
			process.stderr.write("Something broke inside Claude Code\n");
			process.exitCode = 3;
			break;
		default:
			await stream(reply);
			assistant(reply);
			result(true, reply);
	}
});
