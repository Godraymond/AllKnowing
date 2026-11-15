// Checks web/standalone.js, the runtime the web app uses outside claude.ai, without a browser.
// Run: node assistant/check-web-runtime.cjs
// It loads the file with a fake microphone, a fake speech socket and a fake Claude API, then checks what the
// page would be told: phrases with their voice and the pause before them, and Claude's answers and errors.
// The fakes speak the speech service's protocol as its official SDK does (@soniox/client 2.5.0).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const code = fs.readFileSync(path.join(__dirname, "web", "standalone.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => undefined;
let fails = 0;
const ok = (name, pass, detail = "") => {
	if (!pass) fails++;
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass || !detail ? "" : `\n   ${detail}`}`);
};

// ---- the fakes ----
class FakeSocket {
	constructor(url, protocols) {
		this.url = url;
		this.protocols = protocols || [];
		this.sent = [];
		this.readyState = 0;
		FakeSocket.all.push(this);
		setTimeout(() => {
			if (FakeSocket.refuseHandshakeKey && this.protocols.length) return this.drop();
			this.readyState = 1;
			if (this.onopen) this.onopen({});
		}, 2);
	}
	send(data) {
		this.sent.push(data);
		// "" asks for the last words: the service answers `finished` and closes.
		if (data === "")
			setTimeout(() => {
				this.say({ tokens: [], finished: true });
				this.drop();
			}, 2);
	}
	close() {
		this.drop();
	}
	drop() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		setTimeout(() => this.onclose && this.onclose({}), 0);
	}
	say(message) {
		if (this.onmessage) this.onmessage({ data: JSON.stringify(message) });
	}
	get config() {
		return JSON.parse(this.sent[0]);
	}
	get audio() {
		return this.sent.filter((x) => typeof x !== "string");
	}
}
FakeSocket.all = [];
const lastSocket = () => FakeSocket.all[FakeSocket.all.length - 1];
// Text → tokens as the service sends them: pieces whose texts join back into the phrase.
function tokens(text, speaker, startMs, final = true) {
	let t = startMs;
	return (text.match(/ ?[A-Za-z0-9']+|[^A-Za-z0-9' ]| /g) || []).map((piece) => {
		const tok = { text: piece, start_ms: t, end_ms: t + 120, is_final: final, speaker };
		t += 140;
		return tok;
	});
}
const END = { text: "<end>", is_final: true };

let micNode = null;
class FakeAudio {
	constructor() {
		this.state = "running";
		this.sampleRate = 48000;
		this.destination = {};
	}
	resume() {
		return Promise.resolve();
	}
	close() {
		this.state = "closed";
		return Promise.resolve();
	}
	createMediaStreamSource() {
		return { connect: noop, disconnect: noop };
	}
	createGain() {
		return { gain: { value: 1 }, connect: noop };
	}
	createScriptProcessor() {
		micNode = { connect: noop, disconnect: noop, onaudioprocess: null };
		return micNode;
	}
}
const track = {
	readyState: "live",
	stopped: 0,
	stop() {
		this.stopped++;
	},
	addEventListener: noop,
};
const claudeCalls = [];
let claudeReply = () => ({ text: "OK" });
function fakeFetch(url, init) {
	const body = JSON.parse(init.body);
	claudeCalls.push({ url, headers: init.headers, body });
	const r = claudeReply(body);
	if (r.status) {
		return Promise.resolve({
			ok: false,
			status: r.status,
			json: async () => ({
				type: "error",
				error: { type: r.type || "api_error", message: r.message || "" },
			}),
		});
	}
	const ev = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
	let sse = ev({ type: "message_start" }) + ev({ type: "ping" });
	for (let i = 0; i < r.text.length; i += 5)
		sse += ev({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: r.text.slice(i, i + 5) },
		});
	sse +=
		ev({ type: "message_delta", delta: { stop_reason: r.stop || "end_turn" } }) +
		ev({ type: "message_stop" });
	// Hand it over in odd-sized pieces, so characters and lines are split across reads.
	const bytes = Buffer.from(sse, "utf8");
	let at = 0;
	const reader = {
		read: async () => {
			if (at >= bytes.length) return { done: true };
			const value = new Uint8Array(bytes.subarray(at, at + 7));
			at += 7;
			return { done: false, value };
		},
	};
	return Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } });
}
const store = new Map([
	["allknowing:keys:v1", JSON.stringify({ claudeKey: "sk-ant-test", speechKey: "abc123" })],
]);
const notices = [];
const sandbox = {
	console,
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	TextDecoder,
	Blob,
	CustomEvent: class {
		constructor(type, init) {
			this.type = type;
			this.detail = init && init.detail;
		}
	},
	URL: { createObjectURL: () => "blob:fake", revokeObjectURL: noop },
	WebSocket: FakeSocket,
	AudioContext: FakeAudio,
	fetch: fakeFetch,
	localStorage: {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
	},
	navigator: {
		userAgent: "node",
		platform: "test",
		maxTouchPoints: 0,
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
		},
	},
	document: { visibilityState: "visible", addEventListener: noop },
	addEventListener: noop,
	dispatchEvent: (e) => notices.push(e.detail),
};
sandbox.window = sandbox;
vm.runInNewContext(code, sandbox);

(async () => {
	const claude = sandbox.claude;
	ok("provides the runtime when claude.ai's isn't there", !!claude && claude.standalone === true);
	ok(
		"no storage or Outlook here",
		(await claude.use("db")) === null &&
			(await claude.use("mcp")) === null &&
			(await claude.use("user")) === null,
	);
	ok("nothing missing once both keys are stored", claude.notice === "");

	// ---- Claude ----
	const sample = await claude.use("sample");
	let streamed = "";
	claudeReply = () => ({ text: "**Say this:** 我站边5号。" });
	const said = await sample("hello", {
		modelTier: "quick",
		onText: ({ text }) => {
			streamed = text;
		},
	});
	const c0 = claudeCalls[0];
	ok(
		"a streamed answer is put back together, Chinese included",
		said.text === "**Say this:** 我站边5号。" && streamed === said.text,
		said.text,
	);
	ok(
		"request: endpoint and the headers a browser needs",
		c0.url === "https://api.anthropic.com/v1/messages" &&
			c0.headers["x-api-key"] === "sk-ant-test" &&
			c0.headers["anthropic-version"] === "2023-06-01" &&
			c0.headers["anthropic-dangerous-direct-browser-access"] === "true",
	);
	ok(
		"request: little thinking for quick answers",
		c0.body.output_config && c0.body.output_config.effort === "low",
	);
	ok(
		"request: fast model, streaming, the prompt as text",
		c0.body.model === "claude-haiku-5-5" &&
			c0.body.stream === true &&
			c0.body.messages[0].content[0].text === "hello" &&
			!c0.body.system,
	);
	claudeReply = () => ({ text: '```json\n{"a": 1, "b": "好"}\n```' });
	const data = await sample.json("give me json", { modelTier: "default" });
	ok("JSON in a code fence is still read", data.a === 1 && data.b === "好");
	ok(
		"JSON requests use the thorough model and say JSON only",
		claudeCalls[1].body.model === "claude-sonnet-5-5" &&
			/JSON object/.test(claudeCalls[1].body.system),
	);
	const errorOf = async (reply, json = false) => {
		claudeReply = () => reply;
		try {
			await (json ? sample.json("x", {}) : sample("x", {}));
			return { code: "none" };
		} catch (e) {
			return e;
		}
	};
	ok(
		"wrong key → bad_key, with words for the user",
		(await errorOf({ status: 401, message: "invalid x-api-key" })).code === "bad_key",
	);
	ok("rate limit → rate_limited", (await errorOf({ status: 429 })).code === "rate_limited");
	ok("unknown model → bad_model", (await errorOf({ status: 404 })).code === "bad_model");
	ok(
		"out of credit is said plainly",
		/out of credit/.test(
			(
				await errorOf({
					status: 400,
					message: "Your credit balance is too low to access the Anthropic API.",
				})
			).userMessage,
		),
	);
	ok(
		"an answer that isn't JSON → invalid_json",
		(await errorOf({ text: "sorry, no" }, true)).code === "invalid_json",
	);
	ok(
		"an empty answer → empty_completion",
		(await errorOf({ text: "" })).code === "empty_completion",
	);
	ok(
		"a refusal → refused",
		(await errorOf({ text: "I can't help with that.", stop: "refusal" })).code === "refused",
	);
	ok(
		"request: some thinking for the thorough work",
		claudeCalls[1].body.output_config.effort === "medium",
	);
	const before = claudeCalls.length;
	claudeReply = (body) =>
		body.max_tokens > 8192
			? {
					status: 400,
					message: `max_tokens: ${body.max_tokens} > 8192, which is the maximum allowed number of output tokens`,
				}
			: { text: '{"ok":true}' };
	const retried = await sample.json("x", {});
	ok(
		"a smaller answer limit: asked again within it",
		retried.ok === true &&
			claudeCalls.length === before + 2 &&
			claudeCalls[before + 1].body.max_tokens === 8192,
	);
	const before2 = claudeCalls.length;
	claudeReply = (body) =>
		body.output_config
			? { status: 400, message: "output_config: Extra inputs are not permitted" }
			: { text: '{"ok":2}' };
	const noEffort = await sample.json("x", {});
	ok(
		"a model that refuses the effort setting: asked again without it",
		noEffort.ok === 2 &&
			claudeCalls.length === before2 + 2 &&
			!("output_config" in JSON.parse(JSON.stringify(claudeCalls[before2 + 1].body))),
	);
	claudeReply = () => ({ status: 400, message: "messages: at least one message is required" });
	ok(
		"any other refusal is passed on, not retried",
		(await errorOf({ status: 400, message: "messages: at least one message is required" }))
			.code === "bad_request",
	);

	// ---- listening ----
	const dict = await claude.use("dictation");
	const finals = [];
	const states = [];
	let partial = "";
	dict.onFinal((e) => finals.push(e));
	dict.onPartial((e) => {
		partial = e.text;
	});
	dict.onState((e) => states.push(e));
	ok("the listener says it tells voices apart", dict.voices === true);
	await dict.start({
		language: "zh",
		hints: { topic: "狼人杀", terms: ["预言家", "3号", "预言家", " "] },
	});
	const feed = setInterval(() => {
		if (micNode && micNode.onaudioprocess)
			micNode.onaudioprocess({
				inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.25) },
			});
	}, 20);
	const ws = lastSocket();
	ok(
		"states: starting, then listening",
		states.map((s) => s.state).join(",") === "starting,listening",
	);
	ok(
		"the key travels in the handshake",
		ws.url === "wss://stt-rt.soniox.com/transcribe-websocket" &&
			ws.protocols[0] === "soniox-api-key" &&
			ws.protocols[1] === "abc123" &&
			!("api_key" in ws.config),
	);
	ok(
		"settings: model, raw 16 kHz mono, voices, endpoints",
		ws.config.model === "stt-rt-v6" &&
			ws.config.audio_format === "pcm_s16le" &&
			ws.config.sample_rate === 16000 &&
			ws.config.num_channels === 1 &&
			ws.config.enable_speaker_diarization === true &&
			ws.config.enable_endpoint_detection === true,
		JSON.stringify(ws.config),
	);
	ok(
		"settings: Chinese with English expected, and the hints as context",
		JSON.stringify(ws.config.language_hints) === '["zh","en"]' &&
			JSON.stringify(ws.config.context.terms) === '["预言家","3号"]' &&
			ws.config.context.general[0].value === "狼人杀",
	);
	await sleep(80);
	const frame = ws.audio[0];
	ok(
		"sound goes out as 16-bit samples at a third of the microphone's 48 kHz",
		ws.audio.length > 1 &&
			frame.byteLength === 3200 &&
			new Int16Array(frame)[10] === Math.trunc(0.25 * 32767),
		`${ws.audio.length} frames of ${frame && frame.byteLength} bytes`,
	);

	// one voice, words arriving in bits, then an endpoint
	ws.say({ tokens: tokens("请3号", "1", 0, false) });
	ok("a live guess is shown but not kept", partial === "请3号" && finals.length === 0);
	ws.say({ tokens: tokens("请3号发言", "1", 0) });
	ok(
		"final words wait for the end of the sentence",
		finals.length === 0 && partial === "请3号发言",
	);
	ws.say({ tokens: [...tokens("。", "1", 700), END] });
	ok(
		"the phrase goes out whole, with its voice",
		finals.length === 1 &&
			finals[0].text === "请3号发言。" &&
			finals[0].voice === 1 &&
			finals[0].gap === undefined,
		JSON.stringify(finals),
	);
	// two voices in one message; the pause comes from the audio clock
	ws.say({
		tokens: [
			...tokens("我是好人。", "2", 3000),
			...tokens("等一下", "1", 3900),
			...tokens("我", "1", 4400, false),
		],
	});
	ok(
		"a change of voice ends the phrase before it",
		finals.length === 2 && finals[1].text === "我是好人。" && finals[1].voice === 2,
		JSON.stringify(finals.slice(1)),
	);
	ok(
		"the pause before it is measured in the audio",
		Math.abs(finals[1].gap - 2.18) < 0.01,
		String(finals[1].gap),
	);
	ok("what's still being said shows as the live guess", partial === "等一下我");
	// no endpoint and no sentence end: it still lands after a short wait
	await sleep(2700);
	ok(
		"a phrase with no ending still lands",
		finals.length === 3 && finals[2].text === "等一下" && finals[2].voice === 1,
		JSON.stringify(finals.slice(2)),
	);
	// English: a full stop inside a number doesn't split, a real sentence end does
	ws.say({ tokens: tokens(" It costs 3.", "x", 9000) });
	ok("“3.” isn't taken for the end of a sentence", finals.length === 3);
	ws.say({ tokens: tokens("5 million dollars.", "x", 9500) });
	ok(
		"English words keep their spaces, and a label that isn't a number is still a voice",
		finals.length === 4 &&
			finals[3].text === " It costs 3.5 million dollars." &&
			finals[3].voice === 3,
		JSON.stringify(finals.slice(3)),
	);

	// the connection drops: reconnect, and voices get a new block of numbers
	ws.drop();
	await sleep(900);
	const ws2 = lastSocket();
	ok(
		"it reconnects by itself",
		ws2 !== ws && ws2.readyState === 1 && states.length === 2,
		`${FakeSocket.all.length} sockets`,
	);
	ok("sound heard while it was down is sent first", ws2.audio.length > 5);
	ws2.say({ tokens: [...tokens("我回来了。", "1", 0), END] });
	ok(
		"voices are numbered afresh after a reconnect",
		finals.length === 5 && finals[4].voice === 21 && finals[4].gap === undefined,
		JSON.stringify(finals.slice(4)),
	);
	ok(
		"the page was told about the reconnect, then that all is well",
		notices.includes("Reconnecting to the speech service…") &&
			notices[notices.length - 1] === "",
	);

	// stop: ask for the last words, wait for `finished`, release the microphone
	ws2.say({ tokens: tokens("最后一句", "1", 2000) });
	const stopping = dict.stop();
	await stopping;
	clearInterval(feed);
	ok(
		"stopping asks the service to finish and keeps the last words",
		ws2.sent[ws2.sent.length - 1] === "" &&
			finals.length === 6 &&
			finals[5].text === "最后一句",
	);
	ok(
		"states end at idle, and the microphone is released",
		states.map((s) => s.state).join(",") === "starting,listening,finishing,idle" &&
			states[3].reason === "stopped" &&
			track.stopped >= 1,
	);

	// a key the service refuses, found after the socket opens
	const n = FakeSocket.all.length;
	await dict.start({});
	const ws3 = lastSocket();
	ok(
		"no language set: no language hints",
		ws3.config.language_hints === undefined && ws3.config.context === undefined,
	);
	ws3.say({ error_code: 401, error_message: "Invalid API key." });
	await sleep(20);
	const end = states[states.length - 1];
	ok(
		"a refused key stops the listening and says why",
		end.state === "idle" &&
			end.reason === "bad_key" &&
			/didn't accept that key/.test(end.userMessage) &&
			FakeSocket.all.length === n + 1,
		JSON.stringify(end),
	);

	// the handshake with the key fails: one more try with the key in the settings message
	FakeSocket.refuseHandshakeKey = true;
	await dict.start({ language: "en" });
	const ws4 = lastSocket();
	ok(
		"fallback: the key goes with the settings instead",
		ws4.protocols.length === 0 &&
			ws4.config.api_key === "abc123" &&
			JSON.stringify(ws4.config.language_hints) === '["en"]',
	);
	await dict.stop();
	FakeSocket.refuseHandshakeKey = false;

	// no keys at all
	store.set("allknowing:keys:v1", "{}");
	const bare = { ...sandbox, claude: undefined };
	bare.window = bare;
	vm.runInNewContext(code, bare);
	ok(
		"with nothing set up, it says what to add",
		/connect Claude and add your speech key/.test(bare.claude.notice),
	);
	const noKey = async (fn) => {
		try {
			await fn();
			return "";
		} catch (e) {
			return e.code;
		}
	};
	ok(
		"with no keys, nothing is sent anywhere",
		(await noKey(async () => (await bare.claude.use("sample"))("x"))) === "no_key" &&
			(await noKey(async () => (await bare.claude.use("dictation")).start())) === "no_key",
	);

	// ---- Claude through the Mac (the relay), on the user's plan ----
	const macCalls = [];
	let macReply = () => ({ text: "Mac says hi" });
	const macFetch = (url, init = {}) => {
		macCalls.push({
			url,
			headers: init.headers || {},
			body: init.body ? JSON.parse(init.body) : null,
		});
		const r = macReply();
		if (r.offline) return Promise.reject(new TypeError("Load failed"));
		if (r.status)
			return Promise.resolve({ ok: false, status: r.status, json: async () => r.body });
		return fakeFetch(url, init);
	};
	store.set(
		"allknowing:keys:v1",
		JSON.stringify({
			claudeVia: "mac",
			macLink: "  https://mac-mini.tail1234.ts.net:8443/#ABCD-EFGH-JKLM-NPQR ",
			speechKey: "abc123",
		}),
	);
	const onMac = { ...sandbox, claude: undefined, fetch: macFetch };
	onMac.window = onMac;
	vm.runInNewContext(code, onMac);
	ok("with the Mac link and a speech key, nothing is missing", onMac.claude.notice === "");
	const macSample = await onMac.claude.use("sample");
	claudeReply = () => ({ text: "Mac says hi" });
	const viaMac = await macSample("hello", { modelTier: "quick" });
	const m0 = macCalls[0];
	ok(
		"Claude goes to the Mac, with the pairing code as the key",
		viaMac.text === "Mac says hi" &&
			m0.url === "https://mac-mini.tail1234.ts.net:8443/v1/messages" &&
			m0.headers["x-api-key"] === "ABCD-EFGH-JKLM-NPQR" &&
			m0.body.model === "claude-haiku-5-5" &&
			m0.body.output_config.effort === "low",
		JSON.stringify(m0),
	);
	const macError = async (reply) => {
		macReply = () => reply;
		try {
			await macSample.json("x", {});
			return { code: "none" };
		} catch (e) {
			return e;
		}
	};
	const limit = await macError({
		status: 429,
		body: {
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "You've reached your Claude plan's usage limit. It resets 5:30 pm.",
				relay: true,
			},
		},
	});
	ok(
		"the Mac's own words are shown: out of plan usage",
		limit.code === "rate_limited" && /plan's usage limit/.test(limit.userMessage),
	);
	const signedOut = await macError({
		status: 401,
		body: {
			type: "error",
			error: {
				type: "authentication_error",
				message: "Claude Code on your Mac isn't signed in.",
				relay: true,
			},
		},
	});
	ok(
		"and: not signed in",
		signedOut.code === "bad_key" && /isn't signed in/.test(signedOut.userMessage),
	);
	const offline = await macError({ offline: true });
	ok(
		"a Mac that can't be reached is named as such",
		offline.code === "upstream_error" && /Couldn't reach your Mac/.test(offline.userMessage),
	);
	macReply = () => ({});
	claudeReply = () => ({ text: "half" });
	const sseError = await (async () => {
		const original = fakeFetch;
		// A stream that carries the relay's error event part way through.
		const ev = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
		const bytes = Buffer.from(
			ev({ type: "message_start" }) +
				ev({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "half" },
				}) +
				ev({
					type: "error",
					error: {
						type: "api_error",
						message: "Claude Code on your Mac stopped with an error: boom.",
						relay: true,
					},
				}),
		);
		let sent = false;
		const reader = {
			read: async () => {
				if (sent) return { done: true };
				sent = true;
				return { done: false, value: new Uint8Array(bytes) };
			},
		};
		onMac.fetch = () =>
			Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } });
		try {
			await macSample("x", {});
			return { code: "none" };
		} catch (e) {
			return e;
		} finally {
			onMac.fetch = original;
		}
	})();
	ok(
		"an error from the Mac part way through an answer is shown in its words",
		sseError.code === "upstream_error" &&
			/stopped with an error: boom/.test(sseError.userMessage),
		JSON.stringify(sseError),
	);
	store.set("allknowing:keys:v1", JSON.stringify({ claudeVia: "mac", speechKey: "abc123" }));
	const noLink = { ...sandbox, claude: undefined };
	noLink.window = noLink;
	vm.runInNewContext(code, noLink);
	ok(
		"on the Mac option with no link yet: it says to paste it",
		/Paste the Mac link/.test(noLink.claude.notice) &&
			(await noKey(async () => (await noLink.claude.use("sample"))("x"))) === "no_key",
	);
	store.set("allknowing:keys:v1", JSON.stringify({ claudeKey: "sk-ant-x" }));
	const legacy = { ...sandbox, claude: undefined };
	legacy.window = legacy;
	vm.runInNewContext(code, legacy);
	ok(
		"someone who already set an API key stays on it",
		/speech key/.test(legacy.claude.notice) && !/Mac/.test(legacy.claude.notice),
	);

	const inside = { ...sandbox, claude: { real: true } };
	inside.window = inside;
	vm.runInNewContext(code, inside);
	ok("inside claude.ai it leaves the real runtime alone", inside.claude.real === true);

	console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
	process.exit(fails ? 1 : 0);
})();
