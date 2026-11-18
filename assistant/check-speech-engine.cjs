"use strict";
/*
 * A stand-in for the speech engine (sherpa-onnx-node), for check-speech.cjs.
 *
 * The "sound" it is given carries its own clock: every sample of speech holds the moment it was said
 * (2000 + tenths of a second, as a 16-bit sample), and silence is 0. A script (the JSON file named in
 * AK_FAKE_SCRIPT) says which words were said when, by whom and in which language, and what each model
 * "mishears". So the models here hear whatever stretch of sound they're handed, the way real ones do,
 * and the check knows exactly what should come out.
 *
 * script: { said: [{ t, who, lang, gap, words: ["Thanks", { w: "gold.", first: "code." }, …] }] }
 * A word takes `gap` seconds (0.3 unless given). A word given as an object has the right word in `w`
 * and, per model (first, latin, cjk, judge), what that model hears instead ("" for nothing).
 */
const fs = require("node:fs");
const RATE = 16000;
const script = JSON.parse(fs.readFileSync(process.env.AK_FAKE_SCRIPT, "utf8"));
const WORDS = [];
for (const u of script.said) {
	const gap = u.gap || 0.3;
	u.words.forEach((w, i) => {
		WORDS.push({ t: u.t + i * gap, who: u.who, lang: u.lang, w: typeof w === "string" ? { w } : w });
	});
	u.end = u.t + u.words.length * gap;
}
const slow = () => {
	const ms = Number(process.env.AK_FAKE_SLOW_MS) || 0;
	if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const tenths = (v) => Math.round(v * 32768) - 2000;
// The runs of speech in a stretch of sound: where they are in it, and when they were said.
function spans(samples) {
	const out = [];
	let cur = null;
	for (let i = 0; i < samples.length; i += 160) {
		const d = tenths(samples[i]);
		if (d < 0) continue;
		const t = d / 10;
		if (cur && i - cur.to <= 320 && Math.abs(t - cur.t1) < 0.25) {
			cur.to = i + 160;
			cur.t1 = cur.t0 + (cur.to - cur.from) / RATE;
		} else {
			// the clock ticks in tenths: this run began part way through one
			cur = { from: i, to: i + 160, t0: t, t1: t + 0.01 };
			out.push(cur);
		}
	}
	return out;
}
// A run starts on a tenth of a second only if the sound was cut on one; find the real start from
// the first tick it crosses.
function exact(samples, s) {
	for (let i = s.from; i < s.to; i += 16) {
		const t = tenths(samples[i]) / 10;
		if (Math.abs(t - s.t0) > 0.05) return { ...s, t0: t - (i - s.from) / RATE, t1: t - (i - s.from) / RATE + (s.to - s.from) / RATE };
	}
	return s;
}
function heard(samples, model) {
	const out = [];
	for (const raw of spans(samples)) {
		const s = exact(samples, raw);
		for (const x of WORDS) {
			if (x.t < s.t0 - 0.04 || x.t >= s.t1 - 0.04) continue;
			let word = model in x.w ? x.w[model] : x.w.w;
			const cjk = x.lang === "zh";
			// A model that doesn't know the language makes noises.
			if (model === "latin" && cjk) word = "shu";
			if (model === "cjk" && !cjk) word = "呃";
			if (word === "") continue;
			out.push({ word, lang: x.lang, cjk: model === "cjk" || (cjk && model !== "latin"), at: s.from / RATE + (x.t - s.t0) });
		}
	}
	return out;
}
class OfflineRecognizer {
	constructor(config) {
		this.config = config;
		const m = config.modelConfig;
		this.model = m.senseVoice ? "first" : m.transducer ? "latin" : m.paraformer ? "cjk" : m.qwen3Asr ? "judge" : "";
		if (!this.model) throw new Error("the stand-in engine doesn't know this model");
		for (const f of [m.tokens, m.senseVoice && m.senseVoice.model, m.transducer && m.transducer.encoder, m.paraformer && m.paraformer.model, m.qwen3Asr && m.qwen3Asr.decoder]) {
			if (f && !fs.existsSync(f)) throw new Error(`model file missing: ${f}`);
		}
		this.hotwords = (m.qwen3Asr && m.qwen3Asr.hotwords) || "";
	}
	createStream() {
		return { samples: null, acceptWaveform(o) { this.samples = o.samples; } };
	}
	decode(stream) {
		if (process.env.AK_FAKE_FAIL === this.model) throw new Error(`the stand-in ${this.model} model was told to fail`);
		slow();
		const words = heard(stream.samples, this.model);
		let text = "";
		const tokens = [];
		const timestamps = [];
		for (const x of words) {
			text += x.cjk || !text ? x.word : ` ${x.word}`;
			if (this.model === "first" || this.model === "latin") {
				tokens.push(x.cjk ? x.word : ` ${x.word}`);
				timestamps.push(x.at);
			}
		}
		// The judge takes hints: a hinted name comes out as hinted.
		if (this.model === "judge") for (const h of this.hotwords.split(",").filter(Boolean)) text = text.replace(new RegExp(`\\b${h.slice(0, 2)}\\w*\\b`, "g"), (w) => (w.length === h.length ? h : w));
		stream.result = { text, lang: this.model === "first" ? `<|${words.length ? words[0].lang : "nospeech"}|>` : "", tokens, timestamps };
	}
	getResult(stream) {
		return stream.result;
	}
}
class Vad {
	constructor(config) {
		this.c = config.sileroVad;
		this.at = 0;
		this.buf = [];
		this.start = -1;
		this.quiet = 0;
		this.out = [];
	}
	acceptWaveform(win) {
		const speech = tenths(win[0]) >= 0 || tenths(win[win.length - 1]) >= 0;
		if (speech) {
			if (this.start < 0) {
				this.start = this.at;
				this.buf = [];
			}
			this.quiet = 0;
		} else if (this.start >= 0) this.quiet += win.length;
		if (this.start >= 0) this.buf.push(new Float32Array(win));
		this.at += win.length;
		const long = this.start >= 0 && (this.at - this.start) / RATE >= this.c.maxSpeechDuration;
		if (this.start >= 0 && (this.quiet / RATE >= this.c.minSilenceDuration || long)) this.cut();
	}
	cut() {
		const all = new Float32Array(this.buf.reduce((a, b) => a + b.length, 0));
		let o = 0;
		for (const b of this.buf) {
			all.set(b, o);
			o += b.length;
		}
		const keep = all.subarray(0, Math.max(0, all.length - this.quiet + 512));
		if (keep.length / RATE >= this.c.minSpeechDuration) this.out.push({ start: this.start, samples: keep });
		this.start = -1;
		this.quiet = 0;
		this.buf = [];
	}
	flush() {
		if (this.start >= 0) this.cut();
	}
	isEmpty() {
		return !this.out.length;
	}
	front() {
		return this.out[0];
	}
	pop() {
		this.out.shift();
	}
}
class OfflineSpeakerDiarization {
	constructor(config) {
		for (const f of [config.segmentation.pyannote.model, config.embedding.model]) if (!fs.existsSync(f)) throw new Error(`model file missing: ${f}`);
		this.sampleRate = RATE;
	}
	process(samples) {
		if (process.env.AK_FAKE_FAIL === "voices") throw new Error("the stand-in voices model was told to fail");
		slow();
		const out = [];
		for (const raw of spans(samples)) {
			const s = exact(samples, raw);
			for (const u of script.said) {
				const a = Math.max(u.t, s.t0);
				const b = Math.min(u.end, s.t1);
				if (b - a < 0.05) continue;
				out.push({ start: s.from / RATE + (a - s.t0), end: s.from / RATE + (b - s.t0), speaker: u.who });
			}
		}
		// The real one numbers voices in the order it meets them, per stretch it is given.
		const seen = new Map();
		for (const x of out.sort((p, q) => p.start - q.start)) {
			if (!seen.has(x.speaker)) seen.set(x.speaker, seen.size);
			x.speaker = seen.get(x.speaker);
		}
		return out;
	}
}
function readWave(file) {
	const b = fs.readFileSync(file);
	const n = (b.length - 44) >> 1;
	const samples = new Float32Array(n);
	for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(44 + i * 2) / 32768;
	return { samples, sampleRate: b.readUInt32LE(24) };
}
// For the check that makes the sound: the same clock, written the other way.
function sound(seconds, said) {
	const pcm = Buffer.alloc(Math.round(seconds * RATE) * 2);
	for (const u of said) {
		const end = u.t + u.words.length * (u.gap || 0.3);
		for (let i = Math.round(u.t * RATE); i < Math.round(end * RATE) && i * 2 < pcm.length; i++) pcm.writeInt16LE(2000 + Math.floor((i / RATE) * 10 + 1e-6), i * 2);
	}
	const head = Buffer.alloc(44);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(36 + pcm.length, 4);
	head.write("WAVEfmt ", 8, "latin1");
	head.writeUInt32LE(16, 16);
	head.writeUInt16LE(1, 20);
	head.writeUInt16LE(1, 22);
	head.writeUInt32LE(RATE, 24);
	head.writeUInt32LE(RATE * 2, 28);
	head.writeUInt16LE(2, 32);
	head.writeUInt16LE(16, 34);
	head.write("data", 36, "latin1");
	head.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([head, pcm]);
}
module.exports = { OfflineRecognizer, Vad, OfflineSpeakerDiarization, readWave, sound, version: "stand-in" };
