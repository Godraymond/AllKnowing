// Checks how the Mac mini turns recordings into text (hub/hub.cjs), against a stand-in for Soniox's file
// API (as its SDK, @soniox/node 2.5.0, calls it) and recordings made up here.
//
// Each made-up recording carries a counter in its sound data, so the stand-in can tell which stretch of
// the recording a file holds, and "hears" the words of a fixed script for exactly that stretch: a word
// every half second, the speaker changing every two seconds. Whatever the Mac mini sends, cut or whole,
// the transcript that comes back has to be the script: every word once, in order, each voice numbered
// the same from start to finish. Parts are 30 seconds here (an hour, less a margin, in real use), and
// the stand-in refuses anything longer, as Soniox's limits page says it does. Whether it really does
// is something the Mac mini finds out for itself, which is checked both ways.
//
//   node assistant/check-recordings.cjs
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const HUB = path.join(__dirname, "hub", "hub.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ak-rec-"));
const home = path.join(tmp, "home");
const PART = 30; // "an hour"
const LONG = 150; // "five hours"
const SHARED = 6;
let failed = 0;
const ok = (name, cond, detail = "") => {
	console.log(
		`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail ? ` — ${String(detail).slice(0, 400)}` : ""}`,
	);
	if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const listen = (handler) =>
	new Promise((resolve) => {
		const s = http.createServer(handler);
		s.listen(0, "127.0.0.1", () => resolve(s));
	});
const readBuf = (req) =>
	new Promise((resolve) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});

/* ---------- the script every recording "says" ---------- */
const VOICES = ["A", "B", "C"];
const voiceAt = (sec) => VOICES[Math.floor(sec / 2) % 3];
const wordsIn = (text) => (text.match(/w\d+/g) || []).map((w) => Number(w.slice(1)));

/* ---------- made-up recordings ---------- */
const u16 = (n) => {
	const b = Buffer.alloc(2);
	b.writeUInt16BE(n);
	return b;
};
const u32 = (n) => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n >>> 0);
	return b;
};
// WAV, 8 kHz stereo: the two channels of a frame spell out its number.
function wav(seconds) {
	const frames = Math.round(seconds * 8000);
	const data = Buffer.alloc(frames * 4);
	for (let i = 0; i < frames; i++) {
		data.writeUInt16LE(i >>> 16, i * 4);
		data.writeUInt16LE(i & 0xffff, i * 4 + 2);
	}
	const head = Buffer.alloc(44);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(36 + data.length, 4);
	head.write("WAVEfmt ", 8, "latin1");
	head.writeUInt32LE(16, 16);
	head.writeUInt16LE(1, 20);
	head.writeUInt16LE(2, 22);
	head.writeUInt32LE(8000, 24);
	head.writeUInt32LE(32000, 28);
	head.writeUInt16LE(4, 32);
	head.writeUInt16LE(16, 34);
	head.write("data", 36, "latin1");
	head.writeUInt32LE(data.length, 40);
	return Buffer.concat([head, data]);
}
// MP3: frames of 384 bytes (128 kbit/s at 48 kHz, 24 ms each), numbered just after the header; with the
// usual wrapping of a tag in front, a table-of-contents frame, and an old-style tag at the end.
const MP3_FRAME = 0.024;
function mp3Frame(i) {
	const b = Buffer.alloc(384);
	b[0] = 0xff;
	b[1] = 0xfb;
	b[2] = 0x94;
	b[3] = 0xc4;
	b.writeUInt32BE(i >>> 0, 4);
	return b;
}
function mp3(seconds, { wrapped = true } = {}) {
	const out = [];
	if (wrapped) {
		out.push(Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 2, 44]), Buffer.alloc(300));
		const toc = mp3Frame(0xffffffff);
		toc.write("Info", 36, "latin1");
		out.push(toc);
	}
	for (let i = 0; i < Math.round(seconds / MP3_FRAME); i++) out.push(mp3Frame(i));
	if (wrapped) out.push(Buffer.concat([Buffer.from("TAG"), Buffer.alloc(125, 0x20)]));
	return Buffer.concat(out);
}
// AAC as a plain stream (ADTS): 1024 samples a frame at 48 kHz, numbered at the start of each payload.
const AAC_FRAME = 1024 / 48000;
function adtsFrame(i, size) {
	const len = size + 7;
	const b = Buffer.alloc(len, 0x11);
	b[0] = 0xff;
	b[1] = 0xf1;
	b[2] = 0x4c;
	b[3] = 0x40 | (len >> 11);
	b[4] = (len >> 3) & 0xff;
	b[5] = ((len & 7) << 5) | 0x1f;
	b[6] = 0xfc;
	b.writeUInt32BE(i, 7);
	return b;
}
const aacSize = (i) => 90 + (i % 21);
function adts(seconds) {
	const out = [];
	for (let i = 0; i < Math.round(seconds / AAC_FRAME); i++) out.push(adtsFrame(i, aacSize(i)));
	return Buffer.concat(out);
}
// MP4/M4A: the same AAC frames as samples in a real box structure, ten to a chunk, optionally with a
// "picture" track in between (a video), the index before or after the sound, 32- or 64-bit offsets.
const box = (type, ...parts) => {
	const body = Buffer.concat(parts);
	return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
const full = (type, flags, ...parts) => box(type, u32(flags), ...parts);
function mp4(seconds, { video = false, indexFirst = false, wide = false, soundOff = false } = {}) {
	const n = Math.round(seconds / AAC_FRAME);
	const pieces = [];
	const chunkAt = [];
	let at = 0;
	for (let c = 0; c * 10 < n; c++) {
		chunkAt.push(at);
		for (let i = c * 10; i < Math.min(n, c * 10 + 10); i++) {
			const s = Buffer.alloc(aacSize(i), 0x11);
			s.writeUInt32BE(i, 0);
			pieces.push(s);
			at += s.length;
		}
		if (video) {
			pieces.push(Buffer.alloc(3000, 0x22));
			at += 3000;
		}
	}
	const sound = Buffer.concat(pieces);
	const ftyp = box("ftyp", Buffer.from("M4A \0\0\0\0isomM4A ", "latin1"));
	const esds = full(
		"esds",
		0,
		// ES descriptor (its length written the long way), decoder config, then AAC-LC, 48 kHz, mono.
		Buffer.from([0x03, 0x80, 0x80, 0x80, 0x19, 0, 1, 0]),
		Buffer.from([0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0, 0xfa, 0, 0, 0, 0xfa, 0]),
		Buffer.from([0x05, 0x02, 0x11, 0x88]),
		Buffer.from([0x06, 0x01, 0x02]),
	);
	const mp4a = box(
		"mp4a",
		Buffer.alloc(6),
		u16(1),
		Buffer.alloc(8),
		u16(1),
		u16(16),
		Buffer.alloc(4),
		u32(48000 * 65536),
		esds,
	);
	const rest = n % 10;
	const fullChunks = Math.floor(n / 10);
	const moov = (base) => {
		const offsets = chunkAt.map((x) =>
			wide ? Buffer.concat([u32(0), u32(base + x)]) : u32(base + x),
		);
		const stbl = box(
			"stbl",
			full("stsd", 0, u32(1), mp4a),
			full("stts", 0, u32(1), u32(n), u32(1024)),
			full(
				"stsc",
				0,
				u32(rest && fullChunks ? 2 : 1),
				...(fullChunks ? [u32(1), u32(10), u32(1)] : []),
				...(rest ? [u32(fullChunks + 1), u32(rest), u32(1)] : []),
			),
			full(
				"stsz",
				0,
				u32(0),
				u32(n),
				...Array.from({ length: n }, (_, i) => u32(aacSize(i))),
			),
			full(wide ? "co64" : "stco", 0, u32(chunkAt.length), ...offsets),
		);
		const track = (handler, flags, ...inside) =>
			box(
				"trak",
				full("tkhd", flags, Buffer.alloc(80)),
				box(
					"mdia",
					full("mdhd", 0, u32(0), u32(0), u32(48000), u32(n * 1024), u32(0)),
					full("hdlr", 0, u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(13)),
					...inside,
				),
			);
		return box(
			"moov",
			full("mvhd", 0, Buffer.alloc(96)),
			...(video ? [track("vide", 3)] : []),
			track("soun", soundOff ? 0 : 3, box("minf", full("smhd", 0, u32(0)), stbl)),
		);
	};
	if (!indexFirst)
		return Buffer.concat([
			ftyp,
			u32(8 + sound.length),
			Buffer.from("mdat"),
			sound,
			moov(ftyp.length + 8),
		]);
	const size = moov(0).length;
	return Buffer.concat([
		ftyp,
		moov(ftyp.length + size + 8),
		u32(8 + sound.length),
		Buffer.from("mdat"),
		sound,
	]);
}
// A video with no sound in it at all.
const silentVideo = () =>
	Buffer.concat([
		box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1")),
		box("mdat", Buffer.alloc(5000, 0x22)),
		box(
			"moov",
			full("mvhd", 0, Buffer.alloc(96)),
			box(
				"trak",
				full("tkhd", 3, Buffer.alloc(80)),
				box(
					"mdia",
					full("mdhd", 0, u32(0), u32(0), u32(600), u32(6000), u32(0)),
					full("hdlr", 0, u32(0), Buffer.from("vide", "latin1"), Buffer.alloc(13)),
				),
			),
		),
	]);
// A kind of recording the Mac mini can't read itself (as .ogg is): only a converter knows how long it is.
const other = (seconds) => Buffer.from(`OggS${JSON.stringify({ seconds })}${"x".repeat(2000)}`);

/* ---------- the stand-in for Soniox ---------- */
// Which stretch of the recording a file holds: from the counter in its first frame, and how many follow.
const known = new Map(); // sha256 of a file that is sent whole and has no counter the stand-in reads → seconds
function stretch(bytes) {
	if (bytes.subarray(0, 4).toString("latin1") === "RIFF") {
		const at = bytes.indexOf("data", 12, "latin1") + 8;
		const len = bytes.readUInt32LE(at - 4);
		const first = bytes.readUInt16LE(at) * 65536 + bytes.readUInt16LE(at + 2);
		return { kind: "wav", start: first / 8000, seconds: len / 32000 };
	}
	let p = 0;
	if (bytes.subarray(0, 3).toString("latin1") === "ID3") p = 10 + ((bytes[8] << 7) | bytes[9]);
	if (bytes[p] === 0xff && bytes[p + 1] === 0xfb) {
		let first = -1;
		let count = 0;
		for (; p + 384 <= bytes.length && bytes[p] === 0xff && bytes[p + 1] === 0xfb; p += 384) {
			if (bytes.subarray(p + 36, p + 40).toString("latin1") === "Info") continue;
			if (first < 0) first = bytes.readUInt32BE(p + 4);
			count++;
		}
		return { kind: "mp3", start: first * MP3_FRAME, seconds: count * MP3_FRAME };
	}
	if (bytes[p] === 0xff && bytes[p + 1] === 0xf1) {
		const first = bytes.readUInt32BE(p + 7);
		let count = 0;
		while (p + 7 <= bytes.length && bytes[p] === 0xff && bytes[p + 1] === 0xf1) {
			p += ((bytes[p + 3] & 3) << 11) | (bytes[p + 4] << 3) | (bytes[p + 5] >> 5);
			count++;
		}
		return {
			kind: "aac",
			start: first * AAC_FRAME,
			seconds: count * AAC_FRAME,
			whole: p === bytes.length,
		};
	}
	const seconds = known.get(sha(bytes));
	return { kind: "other", start: 0, seconds: seconds === undefined ? -1 : seconds };
}
// What Soniox would hear in that stretch: sub-word tokens with times from the start of the file, voices
// numbered in the order they first speak in this file (so not the same from one part to the next).
function heard(bytes) {
	const { start, seconds } = stretch(bytes);
	const order = [];
	const tokens = [
		{ text: "[noise]", start_ms: 0, end_ms: 50, confidence: 0.5, is_audio_event: true },
	];
	for (let k = Math.ceil(start / 0.5 - 1e-6); k * 0.5 < start + seconds - 1e-6; k++) {
		const who = voiceAt(k * 0.5);
		if (!order.includes(who)) order.push(who);
		const speaker = String(order.indexOf(who) + 1);
		const at = Math.round(k * 500 - start * 1000);
		tokens.push({ text: " w", start_ms: at, end_ms: at + 100, confidence: 0.9, speaker });
		tokens.push({
			text: String(k),
			start_ms: at + 100,
			end_ms: at + 300,
			confidence: 0.9,
			speaker,
		});
		if (k % 8 === 7)
			tokens.push({
				text: ".",
				start_ms: at + 300,
				end_ms: at + 300,
				confidence: 0.9,
				speaker,
			});
	}
	return tokens;
}
const sx = {
	files: new Map(),
	txs: new Map(),
	made: [], // every transcription asked for: { config, file }
	uploads: [], // every file taken: { name, bytes }
	deleted: [],
	hold: false,
	limit: PART + 1, // the longest file it takes, in seconds
	refuseUploads: 0,
	uploadStatus: 0,
	txError: "",
	noExtras: false,
	models: [
		{ id: "stt-rt-v4", aliased_model_id: null, transcription_mode: "real_time" },
		{ id: "stt-async-v6", aliased_model_id: null, transcription_mode: "async" },
		{ id: "stt-async-v7", aliased_model_id: null, transcription_mode: "async" },
		{ id: "stt-async-v9-preview", aliased_model_id: null, transcription_mode: "async" },
		{
			id: "stt-async-latest",
			aliased_model_id: "stt-async-v9-preview",
			transcription_mode: "async",
		},
	],
};
function formFile(type, body) {
	const boundary = Buffer.from(`--${/boundary=([^;]+)/.exec(type)[1]}`);
	const headEnd = body.indexOf("\r\n\r\n", boundary.length);
	const head = body.subarray(boundary.length, headEnd).toString("latin1");
	const end = body.indexOf(
		Buffer.concat([Buffer.from("\r\n"), boundary, Buffer.from("--")]),
		headEnd,
	);
	return {
		field: /name="([^"]+)"/.exec(head)[1],
		name: /filename="([^"]+)"/.exec(head)[1],
		bytes: body.subarray(headEnd + 4, end),
	};
}

(async () => {
	const soniox = await listen(async (req, res) => {
		const body = await readBuf(req);
		const send = (status, o) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(o === undefined ? "" : JSON.stringify(o));
		};
		if (req.headers.authorization !== "Bearer sx-good")
			return send(401, {
				status_code: 401,
				error_type: "unauthenticated",
				message: "Invalid API key.",
			});
		if (req.method === "GET" && req.url === "/v1/models")
			return send(200, { models: sx.models });
		if (req.method === "POST" && req.url === "/v1/files") {
			if (sx.refuseUploads > 0) {
				sx.refuseUploads--;
				return send(503, { message: "Try again shortly." });
			}
			if (sx.uploadStatus)
				return send(sx.uploadStatus, {
					message: sx.uploadStatus === 402 ? "Insufficient balance." : "No.",
				});
			if (Number(req.headers["content-length"]) !== body.length)
				return send(400, { message: "Length?" });
			await sleep(60); // a real upload takes a moment
			const f = formFile(req.headers["content-type"], body);
			if (f.field !== "file") return send(400, { message: "A file, please." });
			const id = crypto.randomUUID();
			sx.files.set(id, { id, name: f.name, bytes: f.bytes });
			sx.uploads.push({ id, name: f.name, bytes: f.bytes });
			return send(201, {
				id,
				filename: f.name,
				size: f.bytes.length,
				created_at: new Date().toISOString(),
			});
		}
		if (req.method === "POST" && req.url === "/v1/transcriptions") {
			const config = JSON.parse(body.toString("utf8"));
			if (sx.noExtras && (config.context || config.client_reference_id))
				return send(400, { message: "Unknown field." });
			if (!sx.models.some((m) => m.id === config.model && m.transcription_mode === "async"))
				return send(400, { message: "Unknown model." });
			const file = sx.files.get(config.file_id);
			if (!file) return send(404, { message: "File not found." });
			const id = crypto.randomUUID();
			sx.txs.set(id, { id, file, polls: 0 });
			sx.made.push({ id, config, file });
			return send(201, { id, status: "queued", model: config.model, filename: file.name });
		}
		const tx = /^\/v1\/transcriptions\/([^/]+)(\/transcript)?$/.exec(req.url);
		if (tx) {
			const t = sx.txs.get(tx[1]);
			if (!t) return send(404, { message: "Transcription not found." });
			if (req.method === "DELETE") {
				sx.txs.delete(t.id);
				sx.deleted.push(`transcription ${t.id}`);
				return send(204);
			}
			if (tx[2]) return send(200, { id: t.id, text: "", tokens: heard(t.file.bytes) });
			t.polls++;
			const span = stretch(t.file.bytes);
			// Soniox's own rule, at this check's scale: nothing longer than its limit.
			if (span.seconds < 0 || span.seconds > sx.limit)
				return send(200, {
					id: t.id,
					status: "error",
					error_type: "invalid_audio",
					error_message: "Audio duration exceeds the maximum of 60 minutes.",
				});
			if (sx.txError)
				return send(200, {
					id: t.id,
					status: "error",
					error_type: "x",
					error_message: sx.txError,
				});
			const status =
				t.polls < 2 ? "queued" : t.polls < 3 || sx.hold ? "processing" : "completed";
			return send(200, {
				id: t.id,
				status,
				audio_duration_ms: Math.round(span.seconds * 1000),
			});
		}
		const file = /^\/v1\/files\/([^/]+)$/.exec(req.url);
		if (file && req.method === "DELETE") {
			if (!sx.files.delete(file[1])) return send(404, { message: "File not found." });
			sx.deleted.push(`file ${file[1]}`);
			return send(204);
		}
		send(404, { message: "Nothing here." });
	});
	const nothing = await listen((_req, res) => {
		res.writeHead(404);
		res.end();
	});

	/* ---------- stand-ins for the converters (ffmpeg, and macOS's afconvert and afinfo) ---------- */
	// They "convert" the made-up .ogg above: its length is written in it, and the WAV is the numbered one.
	const tool = (name, code) => {
		const file = path.join(tmp, name);
		fs.writeFileSync(file, `#!${process.execPath}\n${code}`, { mode: 0o755 });
		return file;
	};
	const wavSource = `const fs = require("node:fs");
const secondsOf = (file) => JSON.parse(/\\{[^}]*\\}/.exec(fs.readFileSync(file, "latin1"))[0]).seconds;
const wav = ${wav.toString()};
`;
	const fakeFfmpeg = tool(
		"ffmpeg",
		`${wavSource}const a = process.argv.slice(2);
const src = a[a.indexOf("-i") + 1];
if (!fs.existsSync(src)) { console.error(src + ": No such file"); process.exit(1); }
const s = secondsOf(src);
const out = a[a.length - 1];
if (out === src) {
	const pad = (n) => String(n).padStart(2, "0");
	console.error("Input #0, ogg, from '" + src + "':\\n  Duration: " + pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60) + ".00, start: 0.000000, bitrate: 96 kb/s\\nAt least one output file must be specified");
	process.exit(1);
}
if (!(a.includes("-vn") && a.join(" ").includes("-ac 1 -ar 16000 -c:a pcm_s16le -f wav"))) { console.error("unexpected arguments: " + a.join(" ")); process.exit(2); }
fs.writeFileSync(out, wav(s));
`,
	);
	const fakeAfconvert = tool(
		"afconvert",
		`${wavSource}const a = process.argv.slice(2);
if (a.slice(0, 6).join(" ") !== "-f WAVE -d LEI16@16000 -c 1" || a.length !== 8) { console.error("unexpected arguments: " + a.join(" ")); process.exit(2); }
fs.writeFileSync(a[7], wav(secondsOf(a[6])));
`,
	);
	const fakeAfinfo = tool(
		"afinfo",
		`${wavSource}console.log("File:           " + process.argv[2] + "\\nFile type ID:   Oggf\\nestimated duration: " + secondsOf(process.argv[2]).toFixed(6) + " sec");
`,
	);

	/* ---------- the Mac mini ---------- */
	const port = 40000 + Math.floor(Math.random() * 20000);
	const base = `http://127.0.0.1:${port}`;
	let proc = null;
	let exited = null;
	let hubLog = "";
	const startHub = async (extra = {}) => {
		exited = null;
		proc = spawn(process.execPath, [HUB], {
			env: {
				...process.env,
				AK_HUB_HOME: home,
				AK_HUB_PORT: String(port),
				AK_HUB_BIND: "127.0.0.1",
				AK_HUB_SONIOX: `http://127.0.0.1:${soniox.address().port}`,
				AK_HUB_SOURCE: `http://127.0.0.1:${nothing.address().port}`,
				AK_HUB_PART_SECONDS: String(PART),
				AK_HUB_LONG_PART_SECONDS: String(LONG),
				AK_HUB_OVERLAP_SECONDS: String(SHARED),
				AK_HUB_POLL_MS: "40",
				AK_HUB_RETRY_MS: "20",
				AK_HUB_FFMPEG: "",
				AK_HUB_AFCONVERT: "",
				...extra,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout.on("data", (d) => {
			hubLog += d;
		});
		proc.stderr.on("data", (d) => {
			hubLog += d;
		});
		proc.on("exit", (code) => {
			exited = code;
		});
		for (let i = 0; i < 80; i++) {
			try {
				if ((await fetch(`${base}/api/hello`)).ok) return;
			} catch {
				/* not up yet */
			}
			await sleep(100);
		}
		throw new Error("the hub didn't start");
	};
	const stopHub = async () => {
		if (proc && exited === null) {
			proc.kill("SIGTERM");
			for (let i = 0; i < 60 && exited === null; i++) await sleep(50);
		}
	};
	// Requests as a device sends them, through Tailscale.
	let code = "";
	const asDevice = (extra = {}) => ({
		host: "yans-mac-mini.tail1234.ts.net",
		"x-forwarded-for": "100.101.102.103",
		"x-api-key": code,
		...extra,
	});
	const req = (method, urlPath, { headers = asDevice(), body } = {}) =>
		new Promise((resolve, reject) => {
			const data =
				body === undefined || Buffer.isBuffer(body)
					? body
					: Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
			const r = http.request(`${base}${urlPath}`, { method, headers }, (res) => {
				let b = "";
				res.on("data", (c) => {
					b += c;
				});
				res.on("end", () => {
					let json = null;
					try {
						json = JSON.parse(b);
					} catch {
						/* not json */
					}
					resolve({ status: res.statusCode, text: b, json: json || {} });
				});
			});
			r.on("error", reject);
			r.end(data);
		});
	const T = "/api/transcribe";
	const create = (name, bytes, extra = {}) =>
		req("POST", T, {
			body: {
				name,
				size: bytes.length,
				hints: ["en"],
				terms: ["Priya", "Tom"],
				topic: "Launch timing",
				...extra,
			},
		});
	// Sends a recording the way the page does: in pieces, each from where the Mac mini says it has got to.
	const send = async (name, bytes, { piece = 700000, start = true, extra } = {}) => {
		const made = await create(name, bytes, extra);
		if (made.status !== 200) return { made, id: "" };
		const id = made.json.id;
		for (let at = 0; at < bytes.length; ) {
			const r = await req("PUT", `${T}/${id}/data?at=${at}`, {
				body: bytes.subarray(at, at + piece),
			});
			if (!(r.json.received > at))
				throw new Error(`a piece wasn't taken: ${r.status} ${r.text}`);
			at = r.json.received;
		}
		const started = start ? await req("POST", `${T}/${id}/start`) : null;
		return { id, made, started };
	};
	const status = async (id) => (await req("GET", `${T}/${id}`)).json;
	// Follows a recording until it is done or has stopped, noting each step it reports on the way.
	const follow = async (id, until = ["done", "error"], ms = 20000) => {
		const seen = [];
		const t0 = Date.now();
		for (;;) {
			const st = await status(id);
			const step = `${st.state}${st.parts > 1 ? ` ${st.part + 1}/${st.parts}` : ""}`;
			if (seen[seen.length - 1] !== step) seen.push(step);
			if (until.includes(st.state) || Date.now() - t0 > ms) return { st, seen };
			await sleep(15);
		}
	};
	const claim = (id, by = "page-1") => req("POST", `${T}/${id}/claim`, { body: { by } });
	// Is this the script from 0 to `seconds`: every word once, in order, each voice one number throughout?
	function isScript(result, seconds) {
		const lines = (result && result.lines) || [];
		const all = lines.flatMap((l) => wordsIn(l.text));
		// A recording made of whole frames runs a few milliseconds over, which can be one more word.
		const length = Number(result && result.duration) || 0;
		if (Math.abs(length - seconds) > 0.05) return `said to be ${length}s long, not ${seconds}s`;
		const want = Array.from({ length: Math.ceil(length / 0.5 - 1e-6) }, (_, k) => k);
		if (all.join() !== want.join())
			return `words: got ${all.length}, wanted ${want.length}; first difference at ${all.findIndex((w, i) => w !== want[i])} (…${all.slice(Math.max(0, all.findIndex((w, i) => w !== want[i]) - 3), all.findIndex((w, i) => w !== want[i]) + 4).join(" ")}…)`;
		const numberOf = new Map();
		for (const l of lines) {
			const ws = wordsIn(l.text);
			const who = new Set(ws.map((k) => voiceAt(k * 0.5)));
			if (who.size !== 1) return `a line mixes voices: ${l.text}`;
			const name = [...who][0];
			if (!numberOf.has(name)) numberOf.set(name, l.v);
			if (numberOf.get(name) !== l.v)
				return `voice ${name} is v${numberOf.get(name)} and v${l.v}`;
			if (Math.abs(l.t - ws[0] * 0.5) > 0.11)
				return `a line at ${l.t}s starts with w${ws[0]}`;
		}
		const numbers = [...numberOf.values()].sort();
		if (numbers.join() !== "1,2,3") return `voices are numbered ${numbers.join()}`;
		return "";
	}
	const jobFiles = (id) => {
		try {
			return fs
				.readdirSync(path.join(home, "recordings", id))
				.sort()
				.join();
		} catch {
			return "(gone)";
		}
	};
	// One recording all the way: sent, followed, taken. Returns what was learned on the way.
	const run = async (name, bytes, opts) => {
		const u0 = sx.uploads.length;
		const m0 = sx.made.length;
		const { id, made } = await send(name, bytes, opts);
		if (!id) return { id, made };
		const { st, seen } = await follow(id);
		const got = st.state === "done" ? await claim(id) : null;
		return {
			id,
			st,
			seen,
			result: got ? got.json : null,
			uploads: sx.uploads.slice(u0),
			made: sx.made.slice(m0),
		};
	};

	try {
		/* ---------- 0. the parts that read and cut, on their own ---------- */
		process.env.AK_HUB_HOME = path.join(tmp, "library");
		process.env.AK_HUB_PART_SECONDS = String(PART);
		process.env.AK_HUB_LONG_PART_SECONDS = String(LONG);
		process.env.AK_HUB_OVERLAP_SECONDS = String(SHARED);
		const lib = require(HUB);
		ok(
			"parts of 30 s (or 150 s if Soniox takes long files) sharing 6 s",
			lib.SHORT_PART === PART && lib.LONG_PART === LONG && lib.OVERLAP === SHARED,
		);
		ok(
			"70 s goes in three parts that overlap",
			JSON.stringify(lib.partRanges(70, PART)) === "[[0,30],[24,54],[48,70]]",
			JSON.stringify(lib.partRanges(70, PART)),
		);
		ok("30 s goes whole", JSON.stringify(lib.partRanges(30, PART)) === "[[0,30]]");
		ok(
			"just over goes in two, the second mostly overlap",
			JSON.stringify(lib.partRanges(31, PART)) === "[[0,30],[24,31]]",
		);
		ok(
			"with long files allowed, 70 s goes whole and 200 s in two",
			JSON.stringify(lib.partRanges(70, LONG)) === "[[0,70]]" &&
				JSON.stringify(lib.partRanges(200, LONG)) === "[[0,150],[144,200]]",
		);
		ok(
			"AAC's setup bytes: plain AAC, 48 kHz mono",
			JSON.stringify(lib.adtsConfig(Buffer.from([0x11, 0x88]))) ===
				'{"profile":1,"hzIndex":3,"channels":1}',
		);
		ok(
			"…HE-AAC is written as the plain AAC underneath it (22.05 kHz stereo)",
			JSON.stringify(lib.adtsConfig(Buffer.from([0x2b, 0x92, 0x08, 0x00]))) ===
				'{"profile":1,"hzIndex":7,"channels":2}',
			JSON.stringify(lib.adtsConfig(Buffer.from([0x2b, 0x92, 0x08, 0x00]))),
		);
		ok(
			"…and a kind ADTS can't carry is left alone",
			lib.adtsConfig(Buffer.from([0xf8, 0x8c, 0x40])) === null &&
				lib.adtsConfig(null) === null,
		);
		// Voices across a join. Part one: A (v1) talks until 27 s, then B. Part two, from 24 s, hears A and
		// B in the shared six seconds and then someone new.
		const said = (from, to, voice, at = 0) => {
			const out = [];
			for (let t = from; t < to; t += 0.5)
				out.push([
					Math.round((t - at) * 1000),
					Math.round((t - at) * 1000) + 300,
					voice,
					` w${t * 2}`,
				]);
			return out;
		};
		const joined = lib.stitch([
			{ start: 0, end: 30, words: [...said(0, 27, "1"), ...said(27, 30, "2")] },
			{
				start: 24,
				end: 50,
				words: [
					...said(24, 27, "2", 24),
					...said(27, 40, "1", 24),
					...said(40, 50, "3", 24),
				],
			},
		]);
		ok(
			"stitching: the next part's voices are matched by the words both parts heard",
			joined.lines.map((l) => l.v).join() === "1,2,3" &&
				wordsIn(joined.lines.map((l) => l.text).join(" ")).join() ===
					Array.from({ length: 100 }, (_, k) => k).join() &&
				joined.voices === 3,
			JSON.stringify(joined.lines.map((l) => [l.t, l.v, l.text.slice(0, 20)])),
		);
		ok(
			"…and says where the join is (a pause in the middle of the overlap)",
			joined.joins.length === 1 && joined.joins[0] >= 25 && joined.joins[0] <= 29,
			joined.joins,
		);
		const apart = lib.stitch([
			{ start: 0, end: 30, words: [...said(0, 20, "1"), ...said(20, 30, "2")] },
			{ start: 24, end: 50, words: [...said(24, 40, "1", 24), ...said(40, 50, "2", 24)] },
		]);
		ok(
			"…a voice that says nothing around the join gets a new number, not someone else's",
			apart.lines.map((l) => l.v).join() === "1,2,3",
			JSON.stringify(apart.lines.map((l) => [l.t, l.v])),
		);
		ok(
			"…and nothing to stitch is an empty transcript",
			lib.stitch([{ start: 0, end: 12, words: [] }]).lines.length === 0,
		);

		/* ---------- 1. who may send, and what ---------- */
		await startHub();
		const noCode = await req("POST", T, { headers: { host: "yans-mac-mini.local" }, body: {} });
		ok("needs the pairing code", noCode.status === 401, noCode.status);
		code = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).code;
		ok(
			"the page is told this Mac mini takes recordings",
			(await req("GET", "/api/hello")).json.api >= 2,
		);
		const noKey = await create("a.wav", wav(1));
		ok(
			"without a speech key: says to add one",
			noKey.status === 400 && /Soniox speech key/.test(noKey.json.error.message),
			noKey.text,
		);
		await req("PUT", "/api/keys", {
			headers: asDevice({ "content-type": "application/json" }),
			body: { speechKey: "sx-good" },
		});
		const huge = await create("a.wav", Buffer.alloc(1), { size: 3 * 1024 ** 3 });
		ok(
			"over 2 GB is refused up front",
			huge.status === 413 && /2 GB/.test(huge.json.error.message),
		);
		const sizeless = await create("a.wav", Buffer.alloc(0));
		ok("so is one with no size", sizeless.status === 400);

		/* ---------- 2. a short recording, piece by piece ---------- */
		const shortWav = wav(20);
		const a = await send("Board call.wav", shortWav, { start: false, piece: 300000 });
		ok(
			"says how big a piece to send",
			a.made.json.chunk >= 1024 * 1024 && a.made.json.state === "receiving",
		);
		const early = await req("POST", `${T}/${a.id}/start`);
		ok(
			"…all of it arrived, so it can start",
			early.status === 200 && early.json.state === "queued",
			early.text,
		);
		const b = await create("Half.wav", shortWav);
		const firstPiece = await req("PUT", `${T}/${b.json.id}/data?at=0`, {
			body: shortWav.subarray(0, 100000),
		});
		ok("a piece is taken", firstPiece.json.received === 100000);
		const wrongPlace = await req("PUT", `${T}/${b.json.id}/data?at=50000`, {
			body: shortWav.subarray(50000, 60000),
		});
		ok(
			"a piece from the wrong place isn't, and the answer says where to carry on",
			wrongPlace.status === 409 && wrongPlace.json.received === 100000,
			wrongPlace.text,
		);
		const tooSoon = await req("POST", `${T}/${b.json.id}/start`);
		ok(
			"can't start before it has all arrived",
			tooSoon.status === 409 && tooSoon.json.error.type === "incomplete",
		);
		const tooMuch = await req("PUT", `${T}/${b.json.id}/data?at=100000`, {
			body: Buffer.alloc(shortWav.length),
		});
		ok("more than the recording is refused", tooMuch.status === 413, tooMuch.text);
		ok(
			"another device can't read someone's recording back",
			(await req("GET", `${T}/${b.json.id}/data`)).status === 404,
		);
		await req("DELETE", `${T}/${b.json.id}`);
		ok(
			"a half-sent one can be dropped",
			(await req("GET", `${T}/${b.json.id}`)).status === 404 &&
				jobFiles(b.json.id) === "(gone)",
		);

		const first = await follow(a.id);
		ok("a short recording is done", first.st.state === "done", JSON.stringify(first.st));
		ok(
			"…step by step",
			["sending", "transcribing", "done"].every((s) => first.seen.includes(s)),
			first.seen.join(" → "),
		);
		ok(
			"it went to Soniox whole, as it was",
			sx.uploads.length === 1 &&
				sha(sx.uploads[0].bytes) === sha(shortWav) &&
				sx.uploads[0].name === "part-1.wav",
			sx.uploads.map((u) => `${u.name} ${u.bytes.length}`).join(),
		);
		const cfg1 = sx.made[0].config;
		ok(
			"asked for with the newest model that isn't a preview, voices told apart",
			cfg1.model === "stt-async-v7" && cfg1.enable_speaker_diarization === true,
			JSON.stringify(cfg1),
		);
		ok(
			"…the language, the names to expect and what it's about",
			cfg1.language_hints.join() === "en" &&
				cfg1.context.terms.join() === "Priya,Tom" &&
				cfg1.context.general[0].key === "topic" &&
				cfg1.context.general[0].value === "Launch timing",
			JSON.stringify(cfg1),
		);
		ok(
			"Soniox's copy of the audio and its transcription are deleted once the text is back",
			sx.files.size === 0 && sx.txs.size === 0 && sx.deleted.length === 2,
			sx.deleted.join(),
		);
		ok(
			"the Mac mini keeps the text, not the audio",
			jobFiles(a.id) === "job.json,result.json",
			jobFiles(a.id),
		);
		ok(
			"…where only the owner can read it",
			(fs.statSync(path.join(home, "recordings", a.id, "result.json")).mode & 0o077) === 0 &&
				(fs.statSync(path.join(home, "recordings", a.id)).mode & 0o077) === 0,
		);
		const got1 = await claim(a.id, "page-1");
		ok(
			"the text is the script, in lines by voice",
			isScript(got1.json, 20) === "",
			isScript(got1.json, 20),
		);
		ok(
			"…with its length, voices and model, and no joins",
			got1.json.duration === 20 &&
				got1.json.voices === 3 &&
				got1.json.model === "stt-async-v7" &&
				got1.json.joins.length === 0,
			JSON.stringify({ ...got1.json, lines: undefined }),
		);
		ok(
			"…sounds that aren't words left out, the full stops kept",
			!JSON.stringify(got1.json).includes("noise") &&
				/w7\. w8/.test(got1.json.lines.map((l) => l.text).join(" ")),
			got1.json.lines[0].text,
		);
		const second = await claim(a.id, "page-2");
		ok(
			"one device takes the text to save; a second is told to wait for that copy",
			got1.status === 200 && second.status === 409 && second.json.claimed === true,
			second.text,
		);
		ok("…the first can take it again", (await claim(a.id, "page-1")).status === 200);
		await req("DELETE", `${T}/${a.id}`);
		ok(
			"once saved, the page has it dropped",
			(await req("GET", `${T}/${a.id}`)).status === 404 && jobFiles(a.id) === "(gone)",
		);
		ok("nothing unknown was asked of Soniox", !/Nothing here/.test(hubLog));

		/* ---------- 2b. how long a file does Soniox take? The Mac mini finds out ---------- */
		const readConfig = () =>
			JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
		ok("at first it doesn't know", readConfig().longFiles === null, readConfig().longFiles);
		const firstLong = await run("First long one.mp3", mp3(70));
		const tried = firstLong.uploads.map((u) => Math.round(stretch(u.bytes).seconds));
		ok(
			"the first recording over the limit is tried whole, refused, then sent in parts",
			firstLong.st.state === "done" && tried.join() === "70,30,30,22",
			`${tried.join()} ${JSON.stringify(firstLong.st)}`,
		);
		ok(
			"…and the text is still the whole script",
			isScript(firstLong.result, 70) === "",
			isScript(firstLong.result, 70),
		);
		ok(
			"…the page saw it carry on, not fail",
			!firstLong.seen.includes("error") && firstLong.seen.some((x) => x.endsWith("3/3")),
			firstLong.seen.join(" → "),
		);
		ok(
			"it remembers that, and says so in its log",
			readConfig().longFiles === false && /takes an hour of audio at most/.test(hubLog),
		);
		ok(
			"nothing of the refused try is left at Soniox",
			sx.files.size === 0 && sx.txs.size === 0,
		);
		await req("DELETE", `${T}/${firstLong.id}`);

		/* ---------- 3. long recordings, cut into parts ---------- */
		const longs = [
			["an MP3 (tagged, with a contents frame)", "Site visit.mp3", mp3(70), ".mp3", "mp3"],
			[
				"an M4A (index at the end, as a phone writes it)",
				"Voice memo.m4a",
				mp4(70),
				".aac",
				"aac",
			],
			[
				"an M4A (index first, 64-bit offsets)",
				"Export.m4a",
				mp4(70, { indexFirst: true, wide: true }),
				".aac",
				"aac",
			],
			[
				"a video (MP4 with a picture track)",
				"Teams call.mp4",
				mp4(70, { video: true }),
				".aac",
				"aac",
			],
			["plain AAC", "Stream.aac", adts(70), ".aac", "aac"],
			["a WAV", "Dictaphone.wav", wav(70), ".wav", "wav"],
		];
		for (const [what, name, bytes, ext, kind] of longs) {
			const r = await run(name, bytes);
			const spans = (r.uploads || []).map((u) => stretch(u.bytes));
			ok(
				`${what}: done, in three parts`,
				!!r.st && r.st.state === "done" && r.st.parts === 3,
				JSON.stringify(r.st),
			);
			ok(
				`${what}: three files went to Soniox, each a proper ${kind} file under the limit`,
				r.uploads.length === 3 &&
					r.uploads.every((u, i) => u.name === `part-${i + 1}${ext}`) &&
					spans.every(
						(s) => s.kind === kind && s.seconds <= PART + 0.05 && s.whole !== false,
					),
				JSON.stringify(spans),
			);
			ok(
				`${what}: the parts start at 0, 24 and 48 s and overlap`,
				spans.length === 3 &&
					[0, 24, 48].every((t, i) => Math.abs(spans[i].start - t) < 0.03) &&
					Math.abs(spans[2].start + spans[2].seconds - 70) < 0.05,
				JSON.stringify(spans),
			);
			ok(
				`${what}: the text is the whole script, voices kept across the joins`,
				isScript(r.result, 70) === "",
				isScript(r.result || {}, 70),
			);
			ok(
				`${what}: says where the joins are`,
				r.result.joins.length === 2 &&
					r.result.joins[0] >= 25 &&
					r.result.joins[0] <= 29 &&
					r.result.joins[1] >= 49 &&
					r.result.joins[1] <= 53,
				JSON.stringify(r.result.joins),
			);
			ok(
				`${what}: reports each part as it goes`,
				["1/3", "2/3", "3/3"].every((p) => r.seen.some((s) => s.endsWith(p))),
				r.seen.join(" → "),
			);
			ok(
				`${what}: nothing left at Soniox, no audio left here`,
				sx.files.size === 0 &&
					sx.txs.size === 0 &&
					jobFiles(r.id) === "job.json,result.json",
				jobFiles(r.id),
			);
			await req("DELETE", `${T}/${r.id}`);
		}
		const video = mp4(20, { video: true, indexFirst: true });
		known.set(sha(video), 20);
		const v = await run("Short video.mp4", video);
		ok(
			"a short video goes as its sound only, a fraction of the size",
			v.st.state === "done" &&
				v.uploads.length === 1 &&
				v.uploads[0].name === "part-1.aac" &&
				v.uploads[0].bytes.length < video.length / 2 &&
				isScript(v.result, 20) === "",
			`${v.uploads.map((u) => `${u.name} ${u.bytes.length}`).join()} of ${video.length}; ${isScript(v.result || {}, 20)}`,
		);
		const memo = mp4(20);
		known.set(sha(memo), Math.round(20 / AAC_FRAME) * AAC_FRAME);
		const m4 = await run("Short memo.m4a", memo);
		ok(
			"a short M4A goes as it is",
			m4.st.state === "done" &&
				m4.uploads.length === 1 &&
				sha(m4.uploads[0].bytes) === sha(memo) &&
				m4.uploads[0].name === "part-1.m4a" &&
				isScript(m4.result, 20) === "",
			isScript(m4.result || {}, 20),
		);
		const offTrack = await run("Odd.m4a", mp4(40, { soundOff: true }));
		ok(
			"a sound track that isn't marked as switched on is still used",
			offTrack.st.state === "done" &&
				offTrack.uploads.length === 2 &&
				isScript(offTrack.result, 40) === "",
			JSON.stringify(offTrack.st),
		);
		const mute = await run("Screen.mp4", silentVideo());
		ok(
			"a video with no sound says so",
			mute.st.state === "error" && /no sound/.test(mute.st.error),
			JSON.stringify(mute.st),
		);
		ok("…and nothing went to Soniox for it", mute.uploads.length === 0);

		/* ---------- 4. kinds the Mac mini can't read itself ---------- */
		const ogg20 = other(20);
		known.set(sha(ogg20), 20);
		const o1 = await run("Short.ogg", ogg20);
		ok(
			"with no converter here, another kind goes to Soniox as it is",
			o1.st.state === "done" &&
				o1.uploads.length === 1 &&
				sha(o1.uploads[0].bytes) === sha(ogg20) &&
				o1.uploads[0].name === "part-1.ogg" &&
				isScript(o1.result, 20) === "",
			JSON.stringify(o1.st),
		);
		const ogg70 = other(70);
		known.set(sha(ogg70), 70);
		const o2 = await run("Long.ogg", ogg70);
		ok(
			"…and if Soniox finds that too long, the message says what to do",
			o2.st.state === "error" &&
				/longer than an hour/.test(o2.st.error) &&
				/MP3 or M4A/.test(o2.st.error),
			JSON.stringify(o2.st),
		);
		ok(
			"…with Soniox's copy cleared away all the same",
			sx.files.size === 0 && sx.txs.size === 0,
		);
		ok(
			"…and the recording kept here, to try again",
			/audio\.ogg/.test(jobFiles(o2.id)),
			jobFiles(o2.id),
		);
		// With ffmpeg on the Mac mini, the same file is turned into WAV and cut.
		await stopHub();
		await startHub({ AK_HUB_FFMPEG: fakeFfmpeg });
		const again = await req("POST", `${T}/${o2.id}/start`);
		ok(
			"after a restart, Try again picks the same recording up",
			again.status === 200 && again.json.state === "queued",
			again.text,
		);
		const u1 = sx.uploads.length;
		const o3 = await follow(o2.id);
		const o3parts = sx.uploads.slice(u1);
		ok(
			"with ffmpeg: turned into WAV, cut in three, and the text is the script",
			o3.st.state === "done" &&
				o3parts.length === 3 &&
				o3parts.every((u) => stretch(u.bytes).kind === "wav") &&
				isScript((await claim(o2.id)).json, 70) === "",
			`${JSON.stringify(o3.st)} ${hubLog.slice(-300)}`,
		);
		const o4 = await run("Short again.ogg", ogg20);
		ok(
			"with ffmpeg: one that's short enough still goes as it is",
			o4.st.state === "done" &&
				o4.uploads.length === 1 &&
				sha(o4.uploads[0].bytes) === sha(ogg20),
		);
		await stopHub();
		await startHub({ AK_HUB_AFCONVERT: fakeAfconvert, AK_HUB_AFINFO: fakeAfinfo });
		const o5 = await run("Long again.ogg", ogg70);
		ok(
			"with only macOS's own afconvert: the same",
			o5.st.state === "done" && o5.uploads.length === 3 && isScript(o5.result, 70) === "",
			`${JSON.stringify(o5.st)} ${hubLog.slice(-300)}`,
		);
		const o6 = await run("Short once more.ogg", ogg20);
		ok(
			"…and afinfo says when it needn't be cut",
			o6.st.state === "done" &&
				o6.uploads.length === 1 &&
				sha(o6.uploads[0].bytes) === sha(ogg20),
		);
		const broken = await run("Broken.ogg", Buffer.from("OggS not really"));
		ok(
			"a file nothing can read says so plainly",
			broken.st.state === "error" && /couldn't read this recording/.test(broken.st.error),
			JSON.stringify(broken.st),
		);
		// If Soniox does take long files (its other page says five hours), they go whole.
		await stopHub();
		const forget = readConfig();
		delete forget.longFiles;
		fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(forget), { mode: 0o600 });
		sx.limit = LONG + 1;
		await startHub();
		const whole = await run("Board meeting.mp3", mp3(70));
		ok(
			"where Soniox takes long files, a long recording goes whole: one file, no joins",
			whole.st.state === "done" &&
				whole.uploads.length === 1 &&
				Math.round(stretch(whole.uploads[0].bytes).seconds) === 70 &&
				whole.result.joins.length === 0 &&
				isScript(whole.result, 70) === "",
			`${whole.uploads.length} uploads; ${isScript(whole.result || {}, 70)}`,
		);
		ok(
			"…which is remembered too",
			readConfig().longFiles === true &&
				/takes recordings of over an hour whole/.test(hubLog),
		);
		const veryLong = await run("All day.wav", wav(200));
		const veryLongSpans = veryLong.uploads.map((u) => stretch(u.bytes));
		ok(
			"…and one longer than even that goes in parts of that size",
			veryLong.st.state === "done" &&
				veryLongSpans
					.map((x) => `${Math.round(x.start)}+${Math.round(x.seconds)}`)
					.join() === "0+150,144+56" &&
				isScript(veryLong.result, 200) === "",
			`${JSON.stringify(veryLongSpans)} ${isScript(veryLong.result || {}, 200)}`,
		);
		// And if it stops taking them, that is found out the same way.
		sx.limit = PART + 1;
		const changed = await run("Later.mp3", mp3(70));
		ok(
			"if Soniox stops taking long files, the Mac mini goes back to parts by itself",
			changed.st.state === "done" &&
				changed.uploads.length === 4 &&
				isScript(changed.result, 70) === "" &&
				readConfig().longFiles === false,
			`${changed.uploads.length} uploads, longFiles ${readConfig().longFiles}`,
		);
		await stopHub();
		await startHub();

		/* ---------- 5. when Soniox says no, or isn't there ---------- */
		sx.refuseUploads = 2;
		const busy = await run("Busy.wav", shortWav);
		ok(
			"Soniox busy for a moment: tried again by itself",
			busy.st.state === "done" && isScript(busy.result, 20) === "",
			JSON.stringify(busy.st),
		);
		sx.uploadStatus = 402;
		const broke = await run("No credit.wav", shortWav);
		ok(
			"out of credit: stops, and says where to top up",
			broke.st.state === "error" &&
				/needs credit/.test(broke.st.error) &&
				/console\.soniox\.com/.test(broke.st.error),
			JSON.stringify(broke.st),
		);
		sx.uploadStatus = 0;
		const retried = await req("POST", `${T}/${broke.id}/start`);
		const after = await follow(broke.id);
		ok(
			"…Try again, once that's fixed, finishes it without sending the recording to the Mac mini again",
			retried.json.state === "queued" &&
				after.st.state === "done" &&
				isScript((await claim(broke.id)).json, 20) === "",
			JSON.stringify(after.st),
		);
		sx.txError = "Audio could not be decoded.";
		const garbled = await run("Garbled.wav", shortWav);
		ok(
			"Soniox can't make it out: its own words are passed on",
			garbled.st.state === "error" &&
				/couldn't turn this recording into text: Audio could not be decoded/.test(
					garbled.st.error,
				),
			JSON.stringify(garbled.st),
		);
		ok(
			"…and its copy is cleared away",
			sx.files.size === 0 && sx.txs.size === 0,
			`${sx.files.size} files, ${sx.txs.size} transcriptions`,
		);
		sx.txError = "";
		sx.noExtras = true;
		const plain = await run("Old model.wav", shortWav);
		ok(
			"a model that doesn't take the extras is asked again without them",
			plain.st.state === "done" &&
				plain.made.length === 1 &&
				!plain.made[0].config.context &&
				plain.made[0].config.language_hints.join() === "en",
			JSON.stringify(plain.st),
		);
		sx.noExtras = false;
		await req("PUT", "/api/keys", {
			headers: asDevice({ "content-type": "application/json" }),
			body: { speechKey: "sx-wrong" },
		});
		const wrongKey = await run("Wrong key.wav", shortWav);
		ok(
			"a speech key Soniox turns down: says to check it",
			wrongKey.st.state === "error" && /turned down the speech key/.test(wrongKey.st.error),
			JSON.stringify(wrongKey.st),
		);
		await req("PUT", "/api/keys", {
			headers: asDevice({ "content-type": "application/json" }),
			body: { speechKey: "sx-good" },
		});
		await req("POST", `${T}/${wrongKey.id}/start`);
		ok(
			"…and with the right key, Try again finishes it",
			(await follow(wrongKey.id)).st.state === "done",
		);

		/* ---------- 6. it carries on by itself ---------- */
		// Two at once: the second waits its turn.
		sx.hold = true;
		const q1 = await send("First.mp3", mp3(40));
		const q2 = await send("Second.wav", shortWav);
		await follow(q1.id, ["transcribing"]);
		const waiting = await status(q2.id);
		ok(
			"a second recording waits for the first",
			waiting.state === "queued" && waiting.waiting === 1,
			JSON.stringify(waiting),
		);
		// The Mac mini is restarted while Soniox is still working on the first.
		const sentBefore = sx.uploads.length;
		const askedBefore = sx.made.length;
		await stopHub();
		ok("it stops cleanly in the middle", exited === 0, exited);
		await startHub();
		ok(
			"after a restart both are still there",
			(await status(q1.id)).state !== "missing" && (await status(q2.id)).state === "queued",
		);
		await follow(q1.id, ["transcribing"]);
		await sleep(200);
		ok(
			"…and the first carries on with what Soniox already has, nothing sent twice",
			sx.uploads.length === sentBefore && sx.made.length === askedBefore,
			`${sx.uploads.length - sentBefore} more uploads, ${sx.made.length - askedBefore} more transcriptions`,
		);
		sx.hold = false;
		const d1 = await follow(q1.id);
		const d2 = await follow(q2.id);
		ok(
			"both finish, in turn",
			d1.st.state === "done" &&
				d2.st.state === "done" &&
				isScript((await claim(q1.id)).json, 40) === "" &&
				isScript((await claim(q2.id)).json, 20) === "",
			`${JSON.stringify(d1.st)} ${JSON.stringify(d2.st)}`,
		);
		// Stopped from the page while Soniox is working.
		sx.hold = true;
		const c1 = await send("Changed my mind.wav", shortWav);
		await follow(c1.id, ["transcribing"]);
		const dropped = await req("DELETE", `${T}/${c1.id}`);
		await sleep(300);
		ok(
			"stopping one drops it here and at Soniox",
			dropped.status === 200 &&
				(await req("GET", `${T}/${c1.id}`)).status === 404 &&
				jobFiles(c1.id) === "(gone)" &&
				sx.files.size === 0 &&
				sx.txs.size === 0,
			`${jobFiles(c1.id)}; ${sx.files.size} files, ${sx.txs.size} transcriptions at Soniox`,
		);
		sx.hold = false;
		const next = await run("After that.wav", shortWav);
		ok(
			"…and the next one is unaffected",
			next.st.state === "done" && isScript(next.result, 20) === "",
		);

		/* ---------- 7. old ones are cleared away ---------- */
		const kept = await run("Unsaved.wav", shortWav);
		const stale = await send("Never finished.wav", shortWav, { start: false });
		const fresh = await send("Just started.wav", shortWav, { start: false });
		await stopHub();
		const age = (id, days) => {
			const file = path.join(home, "recordings", id, "job.json");
			const j = JSON.parse(fs.readFileSync(file, "utf8"));
			j.updatedAt = Date.now() - days * 864e5;
			fs.writeFileSync(file, JSON.stringify(j));
		};
		age(kept.id, 8);
		age(stale.id, 2);
		fs.mkdirSync(path.join(home, "recordings", "0123456789abcdef01234567"));
		fs.writeFileSync(
			path.join(home, "recordings", "0123456789abcdef01234567", "audio.mp3"),
			"left over",
		);
		await startHub();
		await sleep(200);
		ok(
			"text nobody took in a week is cleared away, and a recording that never finished arriving in a day",
			(await status(kept.id)).state === undefined &&
				jobFiles(kept.id) === "(gone)" &&
				jobFiles(stale.id) === "(gone)",
			`${jobFiles(kept.id)} ${jobFiles(stale.id)}`,
		);
		ok(
			"…a folder left without its record too",
			jobFiles("0123456789abcdef01234567") === "(gone)",
		);
		ok("…but not one that's on its way", (await status(fresh.id)).state === "receiving");
		ok(
			"the audio never reaches the notes or their daily copy",
			!fs.existsSync(path.join(home, "notes")) ||
				!JSON.stringify(
					fs.readdirSync(path.join(home, "notes"), { recursive: true }),
				).includes("audio"),
		);
		ok(
			"the log names no recording",
			!/Board call|Site visit|Voice memo|Teams call/.test(hubLog),
			hubLog.split("\n").find((l) => /Board call|Site visit|Voice memo|Teams call/.test(l)),
		);
	} catch (e) {
		ok("ran to the end", false, `${e.stack || e.message}\n${hubLog.slice(-1500)}`);
	} finally {
		await stopHub();
		soniox.close();
		nothing.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
	if (failed) console.log(`--- the Mac mini's log ---\n${hubLog.slice(-2500)}`);
	process.exit(failed ? 1 : 0);
})();
