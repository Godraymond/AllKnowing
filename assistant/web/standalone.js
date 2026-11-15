/* AllKnowing as a web app, outside claude.ai.

   Inside claude.ai the page gets `window.claude` from the artifact runtime: Claude, dictation, storage,
   Outlook. Anywhere else this file stands in for the parts the page uses, on the user's own accounts:

   - sample      Claude: through Claude Code on the user's own Mac, signed in with their Claude plan
                 (relay/relay.cjs, reached over Tailscale), or through the Anthropic API with their own key
   - dictation   the microphone, streamed to a speech-to-text service that also says which voice spoke
                 (Soniox real-time API). That is what the claude.ai listener can't give: it hands the page
                 words only.
   - downloads   a file handed to the share sheet (iPhone) or saved by the browser

   There is no `db` or `mcp` here, so the page keeps meetings in this browser and hides the Outlook buttons.
   Keys are kept in this browser's storage on this device and sent only to the service they belong to.
   The build (assistant/build-web.cjs) adds this file to the page; the artifact never loads it. */
(() => {
	if (window.claude) return;

	const VERSION = "__AK_VERSION__";
	const STORE = "allknowing:keys:v1";
	const CLAUDE_API = "https://api.anthropic.com/v1";
	const SPEECH_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
	const RATE = 16000;
	const WHERE = "under “This device” on the Home screen";
	const DEFAULTS = {
		claudeVia: "",
		macLink: "",
		claudeKey: "",
		speechKey: "",
		quick: "claude-haiku-5-5",
		thorough: "claude-sonnet-5-5",
		speechModel: "stt-rt-v6",
	};
	const MODELS = [
		["claude-haiku-5-5", "Claude Haiku 5.5 (fastest, cheapest)"],
		["claude-sonnet-5-5", "Claude Sonnet 5.5"],
		["claude-opus-5-5", "Claude Opus 5.5 (best, dearest)"],
	];

	/* ---------- small helpers ---------- */
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const fail = (code, userMessage, extra) =>
		Object.assign(new Error(userMessage || code), { code, userMessage }, extra);
	function el(tag, props, ...kids) {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(props || {})) {
			if (v == null || v === false) continue;
			if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
			else if (k === "class") node.className = v;
			else node.setAttribute(k, v === true ? "" : String(v));
		}
		for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
		return node;
	}
	const isIOS = () =>
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
	const isInstalled = () =>
		window.navigator.standalone === true ||
		(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

	/* ---------- keys and choices, kept on this device ---------- */
	const cfg = { ...DEFAULTS };
	try {
		Object.assign(cfg, JSON.parse(localStorage.getItem(STORE) || "{}"));
	} catch {
		/* first run, or storage is off */
	}
	for (const k of Object.keys(DEFAULTS))
		if (typeof cfg[k] !== "string" || (!cfg[k] && DEFAULTS[k])) cfg[k] = DEFAULTS[k];
	// Where Claude runs: "mac" (the relay on the user's Mac, their Claude plan) or "key" (an API key).
	if (cfg.claudeVia !== "mac" && cfg.claudeVia !== "key")
		cfg.claudeVia = cfg.claudeKey ? "key" : "mac";
	const viaMac = () => cfg.claudeVia === "mac";
	// The Mac link the installer prints: https://<mac>.<tailnet>.ts.net:8443/#<pairing code>
	function macTarget() {
		const raw = String(cfg.macLink || "").trim();
		const url = raw.match(/https?:\/\/[^\s/#?]+/i);
		const code = raw.match(/#\s*([A-Za-z0-9][A-Za-z0-9 -]{10,}?)\s*$/);
		return url && code ? { base: url[0], code: code[1] } : null;
	}
	const claudeReady = () => (viaMac() ? !!macTarget() : !!cfg.claudeKey.trim());
	function saveCfg() {
		try {
			localStorage.setItem(STORE, JSON.stringify(cfg));
		} catch {
			/* private mode: the keys last until the page closes */
		}
		tell(missing());
	}
	// What the page should say at the top while something is missing.
	function missing() {
		if (!claudeReady() && !cfg.speechKey)
			return "To get going, open the “This device” box on the Home screen: connect Claude and add your speech key.";
		if (!cfg.speechKey)
			return "Add a speech key in the “This device” box on the Home screen to switch on listening.";
		if (!claudeReady())
			return viaMac()
				? "Paste the Mac link in the “This device” box on the Home screen to switch on summaries and “what to say”."
				: "Add a Claude API key in the “This device” box on the Home screen to switch on summaries and “what to say”.";
		return "";
	}
	let lastTold = null;
	function tell(text) {
		if (text === lastTold) return;
		lastTold = text;
		window.dispatchEvent(new CustomEvent("allknowing:notice", { detail: text }));
	}

	/* ---------- Claude (Anthropic Messages API) ---------- */
	// The relay on the Mac answers like the API, so both go the same way; the Mac takes its pairing code as the key.
	const claudeBase = () => (viaMac() ? `${macTarget().base}/v1` : CLAUDE_API);
	const claudeHeaders = () => ({
		"content-type": "application/json",
		"x-api-key": viaMac() ? macTarget().code : cfg.claudeKey.trim(),
		"anthropic-version": "2023-06-01",
		// The API only answers a browser directly when the page says it knows it is sending the user's own key.
		"anthropic-dangerous-direct-browser-access": "true",
	});
	function imageBlock(blob) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(fail("bad_image", "Couldn't read one of the pictures."));
			reader.onload = () =>
				resolve({
					type: "image",
					source: {
						type: "base64",
						media_type: blob.type || "image/png",
						data: String(reader.result).split(",")[1] || "",
					},
				});
			reader.readAsDataURL(blob);
		});
	}
	function relayCode(status, type) {
		if (status === 401 || type === "authentication_error") return "bad_key";
		if (status === 429 || status === 529 || /rate_limit|overloaded/.test(type))
			return "rate_limited";
		if (status === 402) return "no_credit";
		if (status === 404) return "bad_model";
		if (status === 400) return "bad_request";
		return "upstream_error";
	}
	async function claudeError(res, model) {
		let info = {};
		try {
			info = await res.json();
		} catch {
			/* no body */
		}
		const type = (info.error && info.error.type) || "";
		const said = String((info.error && info.error.message) || "").slice(0, 200);
		// The relay on the Mac writes its errors for the user.
		if (info.error && info.error.relay && said) return fail(relayCode(res.status, type), said);
		if (res.status === 401)
			return fail("bad_key", `Claude didn't accept that API key. Check it ${WHERE}.`);
		if (/credit balance/i.test(said))
			return fail(
				"no_credit",
				"The Claude API account is out of credit. Top it up at console.anthropic.com, then try again.",
			);
		if (res.status === 403)
			return fail("not_allowed", `That API key isn't allowed to do this. ${said}`);
		if (res.status === 404)
			return fail(
				"bad_model",
				`Claude doesn't have a model called “${model}”. Pick another ${WHERE}.`,
			);
		if (res.status === 400 && /max_tokens/i.test(said)) {
			// "max_tokens: 12000 > 8192, which is the maximum allowed…": this model answers in fewer tokens than asked for.
			const cap = said.match(/>\s*(\d+)/);
			return fail("max_tokens", `Claude turned the request down: ${said}`, {
				limit: cap ? Number(cap[1]) : 4096,
			});
		}
		if (res.status === 400 && /output_config|effort/i.test(said))
			return fail("no_effort", `Claude turned the request down: ${said}`);
		if (res.status === 413 || /too long|too large|maximum/i.test(said))
			return fail("prompt_too_large");
		if (res.status === 429)
			return fail(
				"rate_limited",
				"Claude's API is rate-limiting this key. Auto-updates pause for 2 minutes.",
			);
		if (res.status === 529 || type === "overloaded_error")
			return fail(
				"rate_limited",
				"Claude is overloaded right now. Auto-updates pause for 2 minutes.",
			);
		if (res.status === 400)
			return fail("bad_request", `Claude turned the request down: ${said}`);
		return fail("upstream_error");
	}
	// Reads a streamed answer: lines of `data: {json}` separated by blank lines.
	async function readEvents(res, onEvent) {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl).replace(/\r$/, "");
				buf = buf.slice(nl + 1);
				if (line.startsWith("data:")) {
					const raw = line.slice(5).trim();
					if (raw && raw !== "[DONE]") {
						let ev = null;
						try {
							ev = JSON.parse(raw);
						} catch {
							/* a partial or odd line: skip it */
						}
						if (ev) onEvent(ev);
					}
				}
				nl = buf.indexOf("\n");
			}
		}
	}
	async function ask(prompt, opts = {}, json = false) {
		if (!claudeReady())
			throw fail(
				"no_key",
				viaMac()
					? `Paste the Mac link ${WHERE} first.`
					: `Add your Claude API key ${WHERE} first.`,
			);
		const model = (opts.modelTier === "quick" ? cfg.quick : cfg.thorough).trim();
		const content = [];
		for (const img of opts.images || []) content.push(await imageBlock(img));
		content.push({ type: "text", text: String(prompt) });
		const body = {
			model,
			max_tokens: json ? 12000 : 2048,
			stream: true,
			messages: [{ role: "user", content }],
			// Less thinking than the models' default: answers arrive sooner and cost less, which matters
			// more for a live coach than the last bit of depth. Thinking counts as output and toward max_tokens.
			output_config: { effort: opts.modelTier === "quick" ? "low" : "medium" },
		};
		if (json)
			body.system =
				"Reply with one JSON object and nothing else: no words before or after it, and no code fences.";
		let text = "";
		let stop = "";
		try {
			const send = () =>
				fetch(`${claudeBase()}/messages`, {
					method: "POST",
					headers: claudeHeaders(),
					body: JSON.stringify(body),
					signal: opts.signal,
				});
			let res = await send();
			// Two things a model may turn down and that are worth one more try without: the answer limit, and the effort setting.
			for (let tries = 0; !res.ok && tries < 2; tries++) {
				const err = await claudeError(res, model);
				if (err.code === "max_tokens" && err.limit < body.max_tokens)
					body.max_tokens = err.limit;
				else if (err.code === "no_effort" && body.output_config)
					body.output_config = undefined;
				else throw err;
				res = await send();
			}
			if (!res.ok) throw await claudeError(res, model);
			await readEvents(res, (ev) => {
				if (
					ev.type === "content_block_delta" &&
					ev.delta &&
					ev.delta.type === "text_delta"
				) {
					text += ev.delta.text;
					if (opts.onText) opts.onText({ text });
				} else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason)
					stop = ev.delta.stop_reason;
				else if (ev.type === "error") {
					const kind = (ev.error && ev.error.type) || "";
					if (ev.error && ev.error.relay && ev.error.message)
						throw fail(relayCode(0, kind), ev.error.message);
					throw kind === "overloaded_error"
						? fail(
								"rate_limited",
								"Claude is overloaded right now. Auto-updates pause for 2 minutes.",
							)
						: fail("upstream_error");
				}
			});
		} catch (e) {
			if (e && e.code) throw Object.assign(e, { text });
			if (e && e.name === "AbortError") throw fail("cancelled", "", { text });
			throw fail(
				"upstream_error",
				viaMac()
					? "Couldn't reach your Mac. Check that it's on, and that Tailscale is connected on this phone."
					: "Couldn't reach Claude. Check the internet connection and try again.",
				{ text },
			);
		}
		if (stop === "refusal") throw fail("refused", "", { text });
		if (!text.trim()) throw fail("empty_completion");
		return { text, cut: stop === "max_tokens" };
	}
	function parseJson(text) {
		const t = String(text)
			.replace(/^\s*```(?:json)?/i, "")
			.replace(/```\s*$/, "");
		const a = t.indexOf("{");
		const b = t.lastIndexOf("}");
		if (a < 0 || b <= a) return undefined;
		try {
			return JSON.parse(t.slice(a, b + 1));
		} catch {
			return undefined;
		}
	}
	const sample = async (prompt, opts) => ({ text: (await ask(prompt, opts, false)).text });
	sample.json = async (prompt, opts) => {
		const got = await ask(prompt, opts, true);
		const data = parseJson(got.text);
		if (data === undefined) throw fail("invalid_json");
		return data;
	};
	sample.limits = async () => ({ images: true });

	/* ---------- listening: microphone → 16 kHz PCM → speech service ---------- */
	const heard = { partial: [], final: [], state: [] };
	const emit = (kind, payload) => {
		for (const fn of heard[kind]) {
			try {
				fn(payload);
			} catch (e) {
				console.error(e);
			}
		}
	};
	let phase = "idle";
	let run = null; // everything belonging to one Start…Stop
	// `userMessage` is said to the user as it is; without it the page uses its own words for `reason`.
	const setPhase = (s, reason, userMessage) => {
		phase = s;
		emit("state", { state: s, reason, userMessage });
	};

	// Runs on the audio thread: averages the microphone down to 16 kHz and posts 100 ms of 16-bit samples at a time.
	const WORKLET = `class AkPcm extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.ratio = sampleRate / o.processorOptions.rate;
    this.pos = 0; this.sum = 0; this.n = 0;
    this.out = new Int16Array(Math.round(o.processorOptions.rate / 10));
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.n++; this.pos++;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.sum / this.n));
        this.out[this.len++] = s < 0 ? s * 32768 : s * 32767;
        this.sum = 0; this.n = 0;
        if (this.len === this.out.length) { this.port.postMessage(this.out.buffer.slice(0)); this.len = 0; }
      }
    }
    return true;
  }
}
registerProcessor("ak-pcm", AkPcm);`;
	// The same averaging for browsers without audio worklets.
	function downsample(input, ratio, carry) {
		const out = new Int16Array(Math.ceil(input.length / ratio) + 1);
		let len = 0;
		for (let i = 0; i < input.length; i++) {
			carry.sum += input[i];
			carry.n++;
			carry.pos++;
			if (carry.pos >= ratio) {
				carry.pos -= ratio;
				const s = Math.max(-1, Math.min(1, carry.sum / carry.n));
				out[len++] = s < 0 ? s * 32768 : s * 32767;
				carry.sum = 0;
				carry.n = 0;
			}
		}
		return out.buffer.slice(0, len * 2);
	}
	function micError(e) {
		const name = (e && e.name) || "";
		if (name === "NotAllowedError" || name === "SecurityError")
			return fail(
				"not_granted",
				isIOS()
					? "The microphone is blocked for AllKnowing. Allow it when asked, or in Settings → Apps → Safari → Microphone, then tap Start."
					: "The microphone is blocked for this page. Allow it from the padlock in the address bar, then tap Start.",
			);
		if (name === "NotFoundError" || name === "OverconstrainedError")
			return fail("unavailable", "No microphone was found on this device.");
		if (name === "NotReadableError" || name === "AbortError")
			return fail(
				"upstream_error",
				"Another app is using the microphone. Close it (or end the call), then tap Start.",
			);
		return fail("upstream_error", "Couldn't open the microphone. Tap Start to try again.");
	}
	function speechConfig(r) {
		const lang = String(r.opts.language || "").toLowerCase();
		const hints = r.opts.hints || {};
		const context = {};
		if (hints.topic)
			context.general = [{ key: "topic", value: String(hints.topic).slice(0, 400) }];
		const terms = Array.isArray(hints.terms)
			? hints.terms.map((t) => String(t).trim()).filter(Boolean)
			: [];
		if (terms.length) context.terms = Array.from(new Set(terms)).slice(0, 200);
		const config = {
			model: cfg.speechModel.trim() || DEFAULTS.speechModel,
			audio_format: "pcm_s16le",
			sample_rate: r.rate,
			num_channels: 1,
			enable_speaker_diarization: true,
			enable_language_identification: true,
			enable_endpoint_detection: true,
		};
		// Chinese tables drop English words in all the time, so both are expected.
		if (lang) config.language_hints = lang.startsWith("zh") ? ["zh", "en"] : [lang.slice(0, 2)];
		if (Object.keys(context).length) config.context = context;
		return config;
	}
	// Opens the socket and sends the settings. The key goes in the handshake; if that handshake fails,
	// one more try sends it with the settings instead (the service's older way).
	function openSocket(config, keyInMessage = false) {
		const key = cfg.speechKey.trim();
		return new Promise((resolve, reject) => {
			let ws;
			try {
				ws = keyInMessage
					? new WebSocket(SPEECH_URL)
					: new WebSocket(SPEECH_URL, ["soniox-api-key", key]);
			} catch {
				if (keyInMessage)
					reject(fail("upstream_error", "Couldn't connect to the speech service."));
				else openSocket(config, true).then(resolve, reject);
				return;
			}
			ws.binaryType = "arraybuffer";
			let open = false;
			const timer = setTimeout(() => {
				if (!open) ws.close();
			}, 12000);
			ws.onopen = () => {
				open = true;
				clearTimeout(timer);
				ws.onclose = null;
				ws.send(JSON.stringify(keyInMessage ? { api_key: key, ...config } : config));
				resolve(ws);
			};
			ws.onclose = () => {
				clearTimeout(timer);
				if (open) return;
				if (keyInMessage)
					reject(
						fail(
							"upstream_error",
							"Couldn't connect to the speech service. Check the internet connection, then tap Start.",
						),
					);
				else openSocket(config, true).then(resolve, reject);
			};
		});
	}
	function speechError(msg) {
		const code = Number(msg.error_code) || 0;
		const said = String(msg.error_message || "").slice(0, 200);
		if (code === 401)
			return {
				fatal: true,
				reason: "bad_key",
				message: `The speech service didn't accept that key. Check it ${WHERE}.`,
			};
		if (code === 402)
			return {
				fatal: true,
				reason: "no_credit",
				message:
					"The speech account is out of credit. Top it up at console.soniox.com, then tap Resume.",
			};
		if (code === 429)
			return {
				fatal: true,
				reason: "rate_limited",
				message: `The speech service is at this account's limit. ${said}`,
			};
		if (code === 400)
			return {
				fatal: true,
				reason: "bad_request",
				message: `The speech service turned the request down: ${said}`,
			};
		return { fatal: false, reason: "upstream_error", message: said };
	}

	// The service labels speakers "1", "2"… per connection. The label is only a name, so each new one gets
	// the next number here (1-19), whatever it looks like.
	function speakerId(r, label) {
		if (label == null || label === "") return 0;
		const key = String(label);
		if (!r.speakers.has(key)) r.speakers.set(key, Math.min(19, r.speakers.size + 1));
		return r.speakers.get(key);
	}
	// Tokens from the service → phrases for the page. Final tokens are grouped into runs of one voice.
	// A run goes out when another voice starts, at the end of an utterance, at the end of a sentence, or when it gets long.
	function onTokens(r, msg) {
		let ended = msg.finished === true;
		const tail = [];
		for (const t of Array.isArray(msg.tokens) ? msg.tokens : []) {
			if (!t || typeof t.text !== "string") continue;
			if (t.text === "<end>" || t.text === "<fin>") {
				ended = true;
				continue;
			}
			const tok = {
				text: t.text,
				sp: speakerId(r, t.speaker),
				start: t.start_ms,
				end: t.end_ms,
			};
			if (t.is_final) r.pend.push(tok);
			else tail.push(tok);
		}
		r.tail = tail;
		drain(r, ended);
		const text = r.pend.map((t) => t.text).join("") + tail.map((t) => t.text).join("");
		const last = tail[tail.length - 1] || r.pend[r.pend.length - 1];
		emit("partial", { text, voice: last && last.sp ? r.voiceBase + last.sp : 0 });
		clearTimeout(r.idle);
		if (r.pend.length)
			r.idle = setTimeout(() => {
				if (run === r) {
					drain(r, true);
					emit("partial", { text: r.tail.map((t) => t.text).join("") });
				}
			}, 2500);
	}
	function drain(r, all) {
		while (r.pend.length) {
			const sp = r.pend[0].sp;
			let n = 1;
			while (n < r.pend.length && r.pend[n].sp === sp) n++;
			if (n === r.pend.length && !all) {
				const text = r.pend.map((t) => t.text).join("");
				const sentence =
					/[。！？…]["”’」』）)]?\s*$/.test(text) ||
					(/[.!?]["”’)]?\s*$/.test(text) && text.trim().length >= 12);
				if (!sentence && text.length < 140) break;
			}
			const toks = r.pend.splice(0, n);
			const text = toks.map((t) => t.text).join("");
			if (!text.trim()) continue;
			const first = toks.find((t) => typeof t.start === "number");
			const final = [...toks].reverse().find((t) => typeof t.end === "number");
			const gap =
				first && r.lastEnd != null
					? Math.max(0, (first.start - r.lastEnd) / 1000)
					: undefined;
			if (final) r.lastEnd = final.end;
			emit("final", { text, voice: sp ? r.voiceBase + sp : 0, gap });
		}
	}
	function wire(r, ws) {
		r.ws = ws;
		r.pend = [];
		r.tail = [];
		r.lastEnd = null;
		r.speakers = new Map();
		let answered = false;
		ws.onmessage = (e) => {
			if (r.ws !== ws || typeof e.data !== "string") return;
			let msg;
			try {
				msg = JSON.parse(e.data);
			} catch {
				return;
			}
			if (msg.error_code !== undefined || msg.error_message !== undefined) {
				const err = speechError(msg);
				r.lastSaid = err.message;
				if (err.fatal) halt(r, err.reason, err.message);
				else ws.close();
				return;
			}
			answered = true;
			r.flaps = 0;
			onTokens(r, msg);
			if (msg.finished === true && r.done) r.done();
		};
		ws.onclose = () => {
			if (r.ws !== ws) return;
			r.ws = null;
			if (r.done) r.done();
			if (run !== r || r.stopping) return;
			// A connection that keeps dying before it says anything useful isn't going to get better by itself.
			if (!answered) r.flaps = (r.flaps || 0) + 1;
			if (r.flaps >= 4) halt(r, "upstream_error", lostMessage(r));
			else reconnect(r);
		};
		// Sound that arrived while the socket was down goes first.
		for (const chunk of r.queue.splice(0)) ws.send(chunk);
	}
	async function reconnect(r) {
		if (r.reconnecting) return;
		r.reconnecting = true;
		drain(r, true);
		emit("partial", { text: "" });
		for (let attempt = 0; attempt < 6 && run === r && !r.stopping; attempt++) {
			tell("Reconnecting to the speech service…");
			await sleep(Math.min(8000, 500 * 2 ** attempt));
			if (run !== r || r.stopping) break;
			try {
				const ws = await openSocket(speechConfig(r));
				if (run !== r || r.stopping) {
					ws.close();
					break;
				}
				r.voiceBase += 20; // the service numbers voices afresh on every connection
				wire(r, ws);
				r.reconnecting = false;
				tell(missing());
				return;
			} catch {
				/* try again */
			}
		}
		r.reconnecting = false;
		if (run === r && !r.stopping) halt(r, "upstream_error", lostMessage(r));
	}
	const lostMessage = (r) =>
		`Lost the connection to the speech service${r.lastSaid ? ` (it said: ${r.lastSaid})` : ""}. Tap Resume to carry on.`;
	function onPcm(r, buffer) {
		if (run !== r || r.stopping) return;
		r.lastAudioAt = Date.now();
		if (!r.loud) {
			const pcm = new Int16Array(buffer);
			for (let i = 0; i < pcm.length; i += 16) {
				if (pcm[i] > 60 || pcm[i] < -60) {
					r.loud = true;
					break;
				}
			}
		}
		if (r.ws && r.ws.readyState === 1) r.ws.send(buffer);
		else {
			r.queue.push(buffer);
			if (r.queue.length > 80) r.queue.shift(); // keep the last 8 seconds
		}
	}
	function closeAudio(r) {
		clearInterval(r.watch);
		clearTimeout(r.idle);
		try {
			if (r.node) {
				r.node.disconnect();
				if (r.node.port) r.node.port.onmessage = null;
				r.node.onaudioprocess = null;
			}
			if (r.source) r.source.disconnect();
		} catch {
			/* already gone */
		}
		if (r.stream) for (const t of r.stream.getTracks()) t.stop();
		if (r.ctx && r.ctx.state !== "closed") r.ctx.close().catch(() => null);
		if (r.blobUrl) URL.revokeObjectURL(r.blobUrl);
	}
	// Stops everything and tells the page why (it shows `message`, or its own words for `reason`).
	function halt(r, reason, message) {
		if (run !== r) return;
		r.stopping = true;
		drain(r, true);
		closeAudio(r);
		if (r.ws) {
			try {
				r.ws.close();
			} catch {
				/* already closed */
			}
		}
		run = null;
		keepAwake(false);
		tell(missing());
		setPhase("idle", reason, message);
	}
	async function openAudio(r) {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		r.ctx = new Ctx({ latencyHint: "interactive" });
		// resume() can stay pending for ever when the browser wants a tap first, so it is never awaited without a limit.
		r.ctx.resume().catch(() => null);
		for (let i = 0; i < 8 && r.ctx.state !== "running"; i++) await sleep(100);
		if (r.ctx.state !== "running") throw fail("no_gesture");
		// Bluetooth headsets can run slower than 16 kHz: then send what the microphone gives.
		r.rate = Math.min(RATE, r.ctx.sampleRate);
		r.source = r.ctx.createMediaStreamSource(r.stream);
		if (r.ctx.audioWorklet && window.AudioWorkletNode) {
			try {
				r.blobUrl = URL.createObjectURL(
					new Blob([WORKLET], { type: "application/javascript" }),
				);
				await r.ctx.audioWorklet.addModule(r.blobUrl);
				r.node = new AudioWorkletNode(r.ctx, "ak-pcm", {
					numberOfInputs: 1,
					numberOfOutputs: 1,
					channelCount: 1,
					processorOptions: { rate: r.rate },
				});
				r.node.port.onmessage = (e) => onPcm(r, e.data);
			} catch (e) {
				console.warn("Audio worklet unavailable, using the older audio path", e);
				r.node = null;
			}
		}
		if (!r.node) {
			const carry = { sum: 0, n: 0, pos: 0 };
			const ratio = r.ctx.sampleRate / r.rate;
			r.node = r.ctx.createScriptProcessor(4096, 1, 1);
			r.node.onaudioprocess = (e) =>
				onPcm(r, downsample(e.inputBuffer.getChannelData(0), ratio, carry));
		}
		// The graph has to end at the speakers to keep running; the gain of 0 keeps it silent.
		const mute = r.ctx.createGain();
		mute.gain.value = 0;
		r.source.connect(r.node);
		r.node.connect(mute);
		mute.connect(r.ctx.destination);
		const track = r.stream.getAudioTracks()[0];
		if (track)
			track.addEventListener("ended", () =>
				halt(
					r,
					"upstream_error",
					"The microphone was taken by something else (a call, or another app). Tap Resume to carry on.",
				),
			);
	}
	async function start(opts = {}) {
		if (phase !== "idle") throw fail("busy", "Already listening.");
		if (!cfg.speechKey.trim()) throw fail("no_key", `To listen, add your speech key ${WHERE}.`);
		if (
			!navigator.mediaDevices ||
			!navigator.mediaDevices.getUserMedia ||
			!(window.AudioContext || window.webkitAudioContext) ||
			!window.WebSocket
		)
			throw fail(
				"unavailable",
				isIOS()
					? "This browser can't use the microphone here. Open AllKnowing in Safari, or from its Home Screen icon."
					: "This browser can't use the microphone here. Try Chrome, Edge or Safari.",
			);
		const r = {
			opts,
			queue: [],
			pend: [],
			tail: [],
			speakers: new Map(),
			voiceBase: 0,
			lastAudioAt: 0,
			startedAt: Date.now(),
			loud: false,
			stopping: false,
		};
		run = r;
		setPhase("starting");
		keepAwake(true); // asked for now, while the tap still counts
		try {
			try {
				// A phone lying on a table: no echo cancelling or noise gate (they favour one near voice and thin out the rest).
				r.stream = await navigator.mediaDevices.getUserMedia({
					audio: {
						channelCount: 1,
						echoCancellation: false,
						noiseSuppression: false,
						autoGainControl: true,
					},
				});
			} catch (e) {
				throw micError(e);
			}
			if (run !== r) throw fail("stopped");
			await openAudio(r);
			const ws = await openSocket(speechConfig(r));
			if (run !== r) {
				ws.close();
				throw fail("stopped");
			}
			wire(r, ws);
		} catch (e) {
			closeAudio(r);
			if (run === r) {
				run = null;
				keepAwake(false);
				setPhase("idle");
			}
			throw e && e.code
				? e
				: fail("upstream_error", "Couldn't start listening. Tap Start to try again.");
		}
		r.startedAt = Date.now();
		// If the microphone goes quiet on us (not just a silent room), say so instead of sitting there.
		r.watch = setInterval(() => {
			if (run !== r || document.visibilityState !== "visible") return;
			if (Date.now() - (r.lastAudioAt || r.startedAt) > 6000)
				halt(
					r,
					"upstream_error",
					"The microphone stopped sending sound. Tap Resume to carry on.",
				);
			else if (!r.loud && Date.now() - r.startedAt > 12000)
				tell(
					"The microphone is on but hearing nothing at all. Check it isn't muted or covered, and that no call is using it.",
				);
			else if (r.loud && lastTold && lastTold.startsWith("The microphone is on"))
				tell(missing());
		}, 3000);
		setPhase("listening");
	}
	async function stop() {
		const r = run;
		if (!r || phase === "idle" || r.stopping) return;
		r.stopping = true;
		setPhase("finishing");
		closeAudio(r);
		const ws = r.ws;
		if (ws && ws.readyState === 1) {
			// An empty message asks the service for the last words; it answers with `finished` and closes.
			const finished = new Promise((resolve) => {
				r.done = resolve;
			});
			try {
				ws.send("");
			} catch {
				/* closed under us */
			}
			await Promise.race([finished, sleep(2500)]);
			try {
				ws.close();
			} catch {
				/* already closed */
			}
		}
		drain(r, true);
		emit("partial", { text: "" });
		if (run === r) run = null;
		keepAwake(false);
		tell(missing());
		setPhase("idle", "stopped");
	}

	/* ---------- keep the screen on while listening; notice when the page was put away ---------- */
	let lock = null;
	async function keepAwake(on) {
		try {
			if (on && !lock && navigator.wakeLock) {
				lock = await navigator.wakeLock.request("screen");
				lock.addEventListener("release", () => {
					lock = null;
				});
			} else if (!on && lock) {
				const l = lock;
				lock = null;
				await l.release();
			}
		} catch {
			/* not allowed right now, or not supported: the phone's own Auto-Lock setting decides */
		}
	}
	document.addEventListener("visibilitychange", async () => {
		const r = run;
		if (document.visibilityState !== "visible" || !r || phase !== "listening") return;
		// Back in front. Phones stop the microphone while a page is hidden; computers usually don't.
		keepAwake(true);
		if (r.ctx.state !== "running") r.ctx.resume().catch(() => null);
		const before = r.lastAudioAt;
		const silentFor = Date.now() - before;
		await sleep(1200);
		if (run !== r || r.stopping) return;
		const track = r.stream.getAudioTracks()[0];
		if (
			!track ||
			track.readyState !== "live" ||
			r.ctx.state !== "running" ||
			r.lastAudioAt === before
		)
			halt(r, "hidden");
		else if ((silentFor > 10000 || !r.ws) && !r.reconnecting) {
			// The sound stopped for a while, so the service has given up on the old connection: start a new one.
			const old = r.ws;
			r.ws = null;
			if (old) {
				try {
					old.close();
				} catch {
					/* already closed */
				}
			}
			reconnect(r);
		}
	});

	const dictation = {
		voices: true,
		onPartial: (fn) => heard.partial.push(fn),
		onFinal: (fn) => heard.final.push(fn),
		onState: (fn) => heard.state.push(fn),
		start,
		stop,
	};

	/* ---------- saving a file ---------- */
	const MIME = {
		md: "text/markdown",
		txt: "text/plain",
		csv: "text/csv",
		json: "application/json",
		srt: "text/plain",
		ics: "text/calendar",
	};
	const downloads = {
		async save({ filename, data }) {
			const name = String(filename || "allknowing.txt");
			const type = MIME[name.split(".").pop().toLowerCase()] || "text/plain";
			const blob =
				data instanceof Blob
					? data
					: new Blob([String(data)], { type: `${type};charset=utf-8` });
			// On iPhone a web app can't drop a file into Downloads, so hand it to the share sheet (Files, AirDrop, Mail).
			if (isIOS() && navigator.canShare) {
				const file = new File([blob], name, { type });
				if (navigator.canShare({ files: [file] })) {
					try {
						await navigator.share({ files: [file] });
						return;
					} catch (e) {
						if (e && e.name === "AbortError") throw fail("cancelled");
					}
				}
			}
			const url = URL.createObjectURL(blob);
			const a = el("a", { href: url, download: name, style: "display:none" });
			document.body.append(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 30000);
		},
	};

	/* ---------- the “This device” box on the Home screen ---------- */
	async function testClaude() {
		if (viaMac()) {
			const mac = macTarget();
			if (!mac)
				return "Paste the Mac link first (it starts with https:// and ends with # and the code).";
			let info = {};
			try {
				const res = await fetch(`${mac.base}/health`, {
					headers: { "x-api-key": mac.code },
				});
				info = await res.json().catch(() => ({}));
				if (!res.ok)
					return (
						(info.error && info.error.message) || `Your Mac said no (${res.status}).`
					);
			} catch {
				return "Couldn't reach your Mac. Check that it's on, that the relay is installed, and that Tailscale is connected on this phone.";
			}
			const cc = info.claude || {};
			if (!cc.found)
				return "Reached your Mac, but Claude Code isn't installed there. Run the installer on the Mac again.";
			if (!cc.loggedIn)
				return "Reached your Mac, but Claude Code there isn't signed in. On the Mac, run: claude auth login";
		} else if (!cfg.claudeKey.trim()) return "Paste a key first.";
		try {
			await ask("Reply with the single word OK.", { modelTier: "quick" });
			return viaMac() ? "Works. Claude answers through your Mac, on your plan." : "Works.";
		} catch (e) {
			return (e && e.userMessage) || `Didn't work (${(e && e.code) || "error"}).`;
		}
	}
	function testSpeech() {
		if (!cfg.speechKey.trim()) return Promise.resolve("Paste a key first.");
		return new Promise((resolve) => {
			let settled = false;
			const done = (text, ws) => {
				if (settled) return;
				settled = true;
				try {
					if (ws) ws.close();
				} catch {
					/* closed */
				}
				resolve(text);
			};
			openSocket(speechConfig({ opts: {}, rate: RATE })).then(
				(ws) => {
					ws.onmessage = (e) => {
						let msg = {};
						try {
							msg = JSON.parse(e.data);
						} catch {
							/* not json */
						}
						if (msg.error_code !== undefined || msg.error_message !== undefined)
							done(speechError(msg).message || "The speech service said no.", ws);
						else done("Works.", ws);
					};
					ws.onclose = () =>
						done("The speech service hung up without saying why. Check the key.", null);
					ws.send(""); // no audio: just ask it to finish, which it only does for a key it accepts
					setTimeout(
						() => done("No answer from the speech service. Try again.", ws),
						8000,
					);
				},
				(e) => done((e && e.userMessage) || "Couldn't connect.", null),
			);
		});
	}
	function keyField(id, label, key, hint, test, placeholder = "Paste it here") {
		const status = el("span", { class: "small-text muted", role: "status" });
		const input = el("input", {
			id,
			type: "password",
			value: cfg[key],
			autocomplete: "off",
			autocapitalize: "off",
			spellcheck: "false",
			placeholder,
			oninput: (e) => {
				cfg[key] = e.target.value.trim();
				saveCfg();
				status.textContent = cfg[key] ? "Saved on this device." : "";
			},
		});
		const show = el(
			"button",
			{
				type: "button",
				class: "btn small ghost",
				onclick: () => {
					input.type = input.type === "password" ? "text" : "password";
					show.textContent = input.type === "password" ? "Show" : "Hide";
				},
			},
			"Show",
		);
		const check = el(
			"button",
			{
				type: "button",
				class: "btn small",
				onclick: async () => {
					check.disabled = true;
					status.textContent = "Checking…";
					status.textContent = await test();
					check.disabled = false;
				},
			},
			"Check",
		);
		return el(
			"div",
			{ class: "field" },
			el("label", { for: id }, label),
			input,
			el("div", { class: "row" }, check, show, status),
			el("span", { class: "hint" }, hint),
		);
	}
	function modelField(id, label, key) {
		const options = MODELS.some(([v]) => v === cfg[key])
			? MODELS
			: [[cfg[key], cfg[key]], ...MODELS];
		const select = el(
			"select",
			{
				id,
				onchange: (e) => {
					cfg[key] = e.target.value;
					saveCfg();
				},
			},
			options.map(([v, text]) => el("option", { value: v }, text)),
		);
		select.value = cfg[key];
		return el("div", { class: "field" }, el("label", { for: id }, label), select);
	}
	const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener" }, text);
	// Where Claude runs: the user's Mac (their Claude plan, through the relay) or an API key.
	function claudeSection() {
		const box = el("div", { class: "stack", style: "gap:10px" });
		const draw = () => {
			const choice = (value, label) =>
				el(
					"label",
					{ class: "check" },
					el("input", {
						type: "radio",
						name: "akClaudeVia",
						style: "width:auto;margin:0",
						value,
						checked: cfg.claudeVia === value,
						onchange: () => {
							cfg.claudeVia = value;
							saveCfg();
							draw();
						},
					}),
					label,
				);
			const field = viaMac()
				? keyField(
						"akMacLink",
						"Mac link",
						"macLink",
						el(
							"span",
							null,
							"The installer on your Mac prints it and copies it for you. Claude Code on the Mac answers, on your Claude plan, so keep the Mac on and Tailscale connected on this phone. Setup: ",
							link(
								"https://github.com/Godraymond/AllKnowing/blob/main/assistant/relay/README.md",
								"Claude on your Mac",
							),
							".",
						),
						testClaude,
						"https://your-mac….ts.net:8443/#XXXX-XXXX-XXXX-XXXX",
					)
				: keyField(
						"akClaudeKey",
						"Claude API key",
						"claudeKey",
						el(
							"span",
							null,
							"Writes the summaries, reads and “what to say”. From ",
							link(
								"https://console.anthropic.com/settings/keys",
								"console.anthropic.com",
							),
							", pay as you go (Max, Ultra and Team plans include monthly API credits). It sees what was said and your notes.",
						),
						testClaude,
					);
			box.replaceChildren(
				el(
					"div",
					{ class: "stack", style: "gap:6px" },
					el("span", { class: "small-text", style: "font-weight:600" }, "Claude runs on"),
					el(
						"div",
						{ class: "row", style: "gap:18px" },
						choice("mac", "My Mac, on my Claude plan"),
						choice("key", "An API key"),
					),
				),
				field,
			);
		};
		draw();
		return box;
	}
	function homeCard() {
		const tips = [];
		if (isIOS() && !isInstalled())
			tips.push(
				"To install on iPhone: tap Share, then Add to Home Screen. The installed app keeps its own keys and meetings, so add the keys there.",
			);
		tips.push(
			"While it listens, keep AllKnowing on screen. A phone stops the microphone when the screen locks or you switch apps.",
		);
		tips.push("Listening sends about 115 MB of sound an hour, so use Wi-Fi where you can.");
		return el(
			"div",
			{ class: "card" },
			el(
				"div",
				{ class: "card-head" },
				el("h2", null, "This device"),
				el(
					"span",
					{ class: "muted small-text" },
					`Web app${VERSION.startsWith("__") ? "" : ` · ${VERSION}`}`,
				),
			),
			el(
				"div",
				{ class: "form" },
				el(
					"p",
					{ class: "small-text muted" },
					"Outside claude.ai, AllKnowing needs Claude and a speech service of your own. What you enter here stays on this device, and each is sent only to its own service.",
				),
				claudeSection(),
				keyField(
					"akSpeechKey",
					"Speech key (Soniox)",
					"speechKey",
					el(
						"span",
						null,
						"Turns sound into words and tells the voices apart. From ",
						link("https://console.soniox.com", "console.soniox.com"),
						". It hears the audio.",
					),
					testSpeech,
				),
				el(
					"div",
					{ class: "two" },
					modelField("akQuick", "Model for “Fast” and “What should I say?”", "quick"),
					modelField("akThorough", "Model for “Thorough”, plans and minutes", "thorough"),
				),
				el(
					"ul",
					{ class: "small-text muted", style: "margin:0;padding-left:18px" },
					tips.map((t) => el("li", null, t)),
				),
				el(
					"p",
					{ class: "small-text muted" },
					"Meetings are saved on this device only. Outlook and Teams are in the claude.ai version.",
				),
				// Only needed if a service retires a model name before this app is updated.
				el(
					"details",
					{ class: "small-text muted" },
					el("summary", null, "Advanced"),
					el(
						"div",
						{ class: "field", style: "margin-top:8px" },
						el("label", { for: "akSpeechModel" }, "Speech model"),
						el("input", {
							id: "akSpeechModel",
							value: cfg.speechModel,
							autocapitalize: "off",
							spellcheck: "false",
							oninput: (e) => {
								cfg.speechModel = e.target.value.trim() || DEFAULTS.speechModel;
								saveCfg();
							},
						}),
					),
				),
			),
		);
	}

	window.claude = {
		standalone: true,
		version: VERSION,
		use: async (name) => ({ sample, dictation, downloads })[name] || null,
		homeCard,
		get notice() {
			return missing();
		},
	};
	lastTold = missing();
})();
