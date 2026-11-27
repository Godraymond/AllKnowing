#!/usr/bin/env node
"use strict";
/*
 * Checks the free way of turning a recording into text on the Mac mini (hub/speech.cjs, and the hub's
 * side of it): how the three models' texts are settled into one, the steps of a job, and the hub
 * fetching the engine and models, running a recording through them, stopping, carrying on after a
 * restart, and falling back to a clear message.
 *
 * The real models are 2 GB, so a stand-in engine takes their place (check-speech-engine.cjs): its
 * "sound" carries the time each sample was said, and a script says what each model hears. What can't
 * be checked this way, and was tried by hand with the real models on Linux: how well they hear. Not
 * tried anywhere: the engine's macOS build on a real Mac.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const HERE = __dirname;
const HUB = path.join(HERE, "hub", "hub.cjs");
const SPEECH = path.join(HERE, "hub", "speech.cjs");
const ENGINE = path.join(HERE, "check-speech-engine.cjs");
const S = require(SPEECH);
let failed = 0;
const ok = (name, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass || !detail ? "" : ` — ${detail}`}`);
	if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000, step = 50) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return true;
		await sleep(step);
	}
	return false;
};
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const zh = (text, swaps = {}) => [...text].map((c) => (swaps[c] ? { w: c, ...swaps[c] } : c));

/* What is "said" in the made-up meeting, and what each model hears of it. */
const SAID = [
	{ t: 1.0, who: 0, lang: "en", words: ["Thanks", "for", "making", "the", "time.", "Shall", "we", "start", "with", "pricing?"] },
	{ t: 4.6, who: 1, lang: "en", words: ["Yes.", "We", "need", "the", "price", "held", "at", { w: "fifty", first: "50" }, "until", { w: "June.", first: "Jude." }] },
	{ t: 8.4, who: 0, lang: "en", words: ["We", "can", "hold", "it", "if", "the", { w: "order", latin: "border" }, "is", "confirmed", "this", "month."] },
	{ t: 12.5, who: 2, lang: "en", words: ["That", "works.", "I", "will", "confirm", "with", { w: "Zhou", first: "Joe", latin: "Zoo", judge: "Zhao" }, "by", "Friday."] },
	{ t: 17.0, who: 1, lang: "zh", gap: 0.25, words: zh("好的我们下周三发货", { 货: { first: "火", cjk: "火" } }) },
	{ t: 20.5, who: 0, lang: "zh", gap: 0.25, words: zh("价格不变", { 变: { cjk: "便" } }) },
	{ t: 30.0, who: 2, lang: "en", words: ["Agreed."] },
	// the two short samples the models are tried out on
	{ t: 1800, who: 0, lang: "en", words: ["The", "tribal", "chief", "got", "gold."] },
	{ t: 1810, who: 0, lang: "zh", gap: 0.25, words: zh("开放时间早上九点") },
];
const WANT = [
	[1, "Thanks for making the time. Shall we start with pricing?"],
	[2, "Yes. We need the price held at fifty until June."],
	[1, "We can hold it if the order is confirmed this month."],
	[3, "That works. I will confirm with Zhou by Friday."],
	[2, "好的我们下周三发货"],
	[1, "价格不变"],
	[3, "Agreed."],
];
const same = (lines, want = WANT) => {
	const got = lines.map((l) => [l.v, l.text]);
	return JSON.stringify(got) === JSON.stringify(want) ? "" : JSON.stringify(got);
};

(async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ak-speech-"));
	const scriptFile = path.join(tmp, "script.json");
	fs.writeFileSync(scriptFile, JSON.stringify({ said: SAID }));
	process.env.AK_FAKE_SCRIPT = scriptFile;
	const fake = require(ENGINE);
	const meeting = fake.sound(32, SAID);
	const sampleOf = (t, seconds) => {
		const from = 44 + Math.round(t * 16000) * 2;
		const all = fake.sound(t + seconds, SAID);
		const pcm = all.subarray(from);
		const head = Buffer.from(all.subarray(0, 44));
		head.writeUInt32LE(36 + pcm.length, 4);
		head.writeUInt32LE(pcm.length, 40);
		return Buffer.concat([head, pcm]);
	};
	const enWav = sampleOf(1800, 2);
	const zhWav = sampleOf(1810, 2.5);

	/* ---------- 1. settling what the models heard ---------- */
	const keys = (t) => S.units(t).map((u) => u.k).join("|");
	ok("numbers are one thing however they're written", keys("fifty pieces, 12,000 units at $4.80, the 20th, two percent") === keys("50 pieces 12000 units at four dollars eighty the twentieth 2%"), keys("fifty pieces, 12,000 units at $4.80, the 20th, two percent"));
	ok("…in Chinese too", keys("募集八百万澳元，折让百分之十五，十八个月，下午三点") === keys("募集800万澳元折让15%18个月下午3点"), keys("募集八百万澳元，折让百分之十五，十八个月，下午三点"));
	ok("Traditional and Simplified are one word", keys("開放時間沒有對於") === keys("开放时间没有对于"));
	ok("two spellings are one word", keys("Mister Zhou will summarise the colour") === keys("Mr. Zhou will summarize the color"));
	let r = S.settle([
		{ id: "a", text: "The chief got fifty pieces of gold.", trust: 2 },
		{ id: "b", text: "the chief got 50 pieces of code", trust: 1 },
		{ id: "c", text: "The chief got fifty pieces of gold.", trust: 3 },
	]);
	ok("two that agree outvote the third, in the first one's wording", r.text === "The chief got fifty pieces of gold." && !r.alts.length && !r.agreed, JSON.stringify(r));
	r = S.settle([
		{ id: "a", text: "We met Mr Zoo on Friday.", trust: 2 },
		{ id: "b", text: "we met mister Joe on Friday", trust: 1 },
		{ id: "c", text: "We met Mr Zhou on Friday.", trust: 3 },
	]);
	ok("no two agreeing: the most trusted is kept and the others noted", r.text === "We met Mr Zhou on Friday." && r.alts.length === 1 && r.text.slice(r.alts[0][0], r.alts[0][1]) === "Zhou" && r.alts[0][2].join() === "Zoo,Joe", JSON.stringify(r));
	r = S.settle([
		{ id: "a", text: "开饭时间早上9点。", trust: 2 },
		{ id: "b", text: "开饭时间早上九点", trust: 1 },
		{ id: "c", text: "開放時間早上九點", trust: 3, say: 2 },
	]);
	ok("a judge with two votes prevails over two that agree, in the lead's script, and the place is marked", r.text === "开放时间早上9点。" && r.alts.length === 1 && r.alts[0][2].join() === "饭", JSON.stringify(r));
	r = S.settle([
		{ id: "a", text: "Tai van shu zien chao.", trust: 2 },
		{ id: "b", text: "开放时间早上九点。", trust: 1 },
		{ id: "c", text: "开放时间早上九点", trust: 3 },
	]);
	ok("a model that heard another language is left out", r.text === "开放时间早上九点。" && r.dropped.join() === "a" && r.from === "b", JSON.stringify(r));
	r = S.settle([
		{ id: "a", text: "Um, I will chase legal Monday.", trust: 2 },
		{ id: "b", text: "I will chase legal on Monday", trust: 1 },
		{ id: "c", text: "I will chase legal on Monday.", trust: 3 },
	]);
	ok("a word two heard and one missed goes in; a filler only one heard comes out", r.text === "I will chase legal on Monday.", JSON.stringify(r.text));
	r = S.settle([
		{ id: "a", text: "", trust: 2 },
		{ id: "b", text: "Thank you.", trust: 1 },
		{ id: "c", text: "", trust: 3 },
	]);
	ok("words only one model heard in a stretch are noise", r.text === "" && r.dropped.join() === "b", JSON.stringify(r));
	r = S.settle([{ id: "a", text: "Only one model here.", trust: 1 }]);
	ok("one model alone is taken as it is", r.text === "Only one model here." && r.agreed);
	r = S.settle([
		{ id: "a", text: "We can hold four eighty until June.", trust: 2 },
		{ id: "b", text: "We can hold at four eighty until June", trust: 1 },
	]);
	ok("two models, one with an extra word: kept as the lead has it, the other reading noted", r.text === "We can hold four eighty until June." && r.alts.length === 1 && r.alts[0][2][0] === "at four", JSON.stringify(r));
	const t = S.tokenTimes("Hello there. Bye.", [" Hello", " there", ".", " Bye", "."], [0.5, 1.0, 1.4, 3.0, 3.3], 10, 10, 14);
	ok("each character gets the time it was said", Math.abs(t[0] - 10.5) < 0.01 && Math.abs(t[6] - 11.0) < 0.01 && Math.abs(t[13] - 13.0) < 0.01 && t.every((x, i) => i === 0 || x >= t[i - 1]), Array.from(t).map((x) => x.toFixed(1)).join(","));

	/* ---------- 2. a job, step by step, with the stand-in engine ---------- */
	const home = path.join(tmp, "speech");
	for (const [key, m] of Object.entries(S.MODELS)) {
		for (const f of m.file ? [""] : m.has) {
			const file = f ? S.modelPath(home, key, f) : S.modelPath(home, key);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, f.endsWith("en.wav") ? enWav : f.endsWith("zh.wav") ? zhWav : "stand-in");
		}
	}
	const env = { ...process.env, AK_SPEECH_ENGINE: ENGINE, AK_FAKE_SCRIPT: scriptFile };
	const worker = (args, extra = {}) =>
		new Promise((resolve) => {
			const p = spawn(process.execPath, [SPEECH, ...args], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			let err = "";
			p.stdout.on("data", (d) => {
				out += d;
			});
			p.stderr.on("data", (d) => {
				err += d;
			});
			p.on("close", (code) => resolve({ code, err, lines: out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) }));
		});
	const newJob = (name, ask = {}) => {
		const dir = path.join(tmp, name);
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "sound.wav"), meeting);
		fs.writeFileSync(path.join(dir, "ask.json"), JSON.stringify({ terms: ["Zhou"], ...ask }));
		return dir;
	};
	const resultOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
	let w = await worker(["check", home]);
	const checked = w.lines.find((l) => typeof l.ok === "boolean") || {};
	ok("the try-out passes and measures every model", w.code === 0 && checked.ok && ["first", "latin", "cjk", "judge", "voices"].every((k) => checked.speeds[k] > 0), JSON.stringify(checked) + w.err.slice(-300));
	fs.renameSync(S.modelPath(home, "judge", "decoder.int8.onnx"), `${S.modelPath(home, "judge", "decoder.int8.onnx")}.away`);
	w = await worker(["check", home]);
	ok("…and says what's missing when something is", w.code === 1 && (w.lines.find((l) => l.ok === false) || {}).missing.join() === "judge", JSON.stringify(w.lines));
	fs.renameSync(`${S.modelPath(home, "judge", "decoder.int8.onnx")}.away`, S.modelPath(home, "judge", "decoder.int8.onnx"));

	const j1 = newJob("job1");
	w = await worker(["run", j1, home]);
	let res = w.code === 0 ? resultOf(j1) : { lines: [], stats: {} };
	ok("a recording comes out as it was said, each line with its voice", w.code === 0 && same(res.lines) === "", `${same(res.lines)} ${w.err.slice(-400)}`);
	ok("…voices numbered in the order they first speak", res.voices === 3);
	ok("…times from the start of the recording", res.lines.length === 7 && Math.abs(res.lines[0].t - 1.0) < 0.3 && Math.abs(res.lines[3].t - 12.5) < 0.3 && Math.abs(res.lines[6].t - 30) < 0.3, res.lines.map((l) => l.t).join(","));
	const alt4 = (res.lines[3] || {}).alt || [];
	const alt5 = (res.lines[4] || {}).alt || [];
	ok("where no two models agreed the other readings are kept with the line", alt4.length === 1 && res.lines[3].text.slice(alt4[0][0], alt4[0][1]) === "Zhou" && alt4[0][2].join() === "Zoo,Joe", JSON.stringify(alt4));
	ok("…and where the Chinese pair agreed against the judge", alt5.length === 1 && res.lines[4].text.slice(alt5[0][0], alt5[0][1]) === "货" && alt5[0][2].join() === "火", JSON.stringify(alt5));
	ok("…and nowhere else", res.lines.filter((l) => l.alt).length === 2 && res.stats.doubts === 2, JSON.stringify(res.stats));
	ok("the judge's hints reached it (a name from the meeting)", /Zhou/.test(fs.readFileSync(path.join(j1, "judge.jsonl"), "utf8")));
	ok("every piece went to all three, in one language each", res.stats.pieces === 4 && res.stats.judged === 4 && JSON.parse(fs.readFileSync(path.join(j1, "pieces.json"), "utf8")).map((p) => p.lang).join() === "en,zh,zh,en", JSON.stringify(res.stats));
	ok("the result says who made it", res.by === "this Mac" && res.models.join() === "SenseVoice,Parakeet,Paraformer,Qwen3-ASR" && Math.abs(res.duration - 32) < 0.01, JSON.stringify([res.by, res.models, res.duration]));
	const prog = w.lines.filter((l) => typeof l.progress === "number").map((l) => l.progress);
	ok("progress only goes forward, to the end", prog.length > 4 && prog.every((p, i) => i === 0 || p >= prog[i - 1]) && prog[prog.length - 1] === 1 && w.lines.some((l) => l.done && l.lines === 7), prog.join(","));

	const j2 = newJob("job2");
	w = await worker(["run", j2, home], { AK_FAKE_FAIL: "judge" });
	ok("a model that fails stops the job with a reason", w.code === 1 && /judge/.test((w.lines.find((l) => l.error) || {}).error || "") && !fs.existsSync(path.join(j2, "result.json")), JSON.stringify(w.lines.slice(-2)));
	const firstBefore = fs.statSync(path.join(j2, "first.jsonl")).mtimeMs;
	const secondBefore = fs.readFileSync(path.join(j2, "second.jsonl"), "utf8");
	w = await worker(["run", j2, home]);
	ok("run again, it carries on from what was done", w.code === 0 && same(resultOf(j2).lines) === "" && fs.statSync(path.join(j2, "first.jsonl")).mtimeMs === firstBefore && fs.readFileSync(path.join(j2, "second.jsonl"), "utf8") === secondBefore, same(resultOf(j2).lines));
	// A step cut off half way through a line.
	const j3 = newJob("job3");
	await worker(["run", j3, home]);
	const whole = fs.readFileSync(path.join(j3, "second.jsonl"), "utf8");
	fs.writeFileSync(path.join(j3, "second.jsonl"), whole.slice(0, whole.length - 30));
	fs.rmSync(path.join(j3, "result.json"));
	w = await worker(["run", j3, home]);
	ok("a step cut off mid-line is picked up cleanly", w.code === 0 && same(resultOf(j3).lines) === "" && fs.readFileSync(path.join(j3, "second.jsonl"), "utf8").trim().split("\n").length === 4, same(resultOf(j3).lines));

	const j4 = newJob("job4");
	w = await worker(["run", j4, home], { AK_FAKE_FAIL: "voices" });
	res = resultOf(j4);
	ok("without voices the words still come out", w.code === 0 && res.voices === 0 && res.lines.every((l) => l.v === undefined) && res.lines.map((l) => l.text).join(" ").includes("Thanks for making the time.") && w.lines.some((l) => /voices/.test(l.note || "")), JSON.stringify(res.lines.slice(0, 2)));

	const j5 = newJob("job5");
	w = await worker(["run", j5, home], { AK_SPEECH_BLOCK_MINUTES: "0.2" });
	res = resultOf(j5);
	ok("a long recording has its voices told apart a block at a time, and says where the blocks join", w.code === 0 && res.joins.length >= 1 && res.lines.map((l) => l.text).join("|") === WANT.map((x) => x[1]).join("|") && res.voices > 3, JSON.stringify([res.joins, res.voices]));

	const j6 = newJob("job6", { quick: true });
	w = await worker(["run", j6, home]);
	res = resultOf(j6);
	ok("asked to be quick, the judge only hears what the first two differ on", w.code === 0 && res.stats.judged === 2 && res.stats.agreed === 2 && res.lines[4].text === "好的我们下周三发火" && res.lines[6].text === "Agreed.", JSON.stringify([res.stats, res.lines[4]]));

	const quiet = path.join(tmp, "quiet");
	fs.mkdirSync(quiet);
	fs.writeFileSync(path.join(quiet, "sound.wav"), fake.sound(5, []));
	fs.writeFileSync(path.join(quiet, "ask.json"), "{}");
	w = await worker(["run", quiet, home]);
	ok("a recording with no speech gives no lines, not an error", w.code === 0 && resultOf(quiet).lines.length === 0);
	fs.writeFileSync(path.join(quiet, "sound.wav"), Buffer.from("not a wav file at all"));
	fs.rmSync(path.join(quiet, "result.json"));
	w = await worker(["run", quiet, home]);
	ok("something that isn't sound is refused", w.code === 1 && w.lines.some((l) => l.error));

	/* ---------- 3. the hub: fetching it all, then recordings ---------- */
	if (spawnSync("tar", ["--version"]).status !== 0) throw new Error("this check needs tar");
	const pack = path.join(tmp, "pack");
	fs.mkdirSync(pack);
	const tar = (args, cwd) => {
		const x = spawnSync("tar", args, { cwd });
		if (x.status !== 0) throw new Error(`tar ${args.join(" ")}: ${x.stderr}`);
	};
	// The engine as two npm tarballs: the stand-in as the package, and a file where the native part goes.
	const kind = S.platformKey();
	fs.mkdirSync(path.join(pack, "node", "package"), { recursive: true });
	fs.writeFileSync(path.join(pack, "node", "package", "package.json"), JSON.stringify({ name: "sherpa-onnx-node", main: "sherpa-onnx.js" }));
	fs.copyFileSync(ENGINE, path.join(pack, "node", "package", "sherpa-onnx.js"));
	tar(["-czf", path.join(pack, "node.tgz"), "package"], path.join(pack, "node"));
	fs.mkdirSync(path.join(pack, "native", "package"), { recursive: true });
	fs.writeFileSync(path.join(pack, "native", "package", "sherpa-onnx.node"), "stand-in");
	tar(["-czf", path.join(pack, "native.tgz"), "package"], path.join(pack, "native"));
	const served = { "npm/node.tgz": fs.readFileSync(path.join(pack, "node.tgz")), "npm/native.tgz": fs.readFileSync(path.join(pack, "native.tgz")) };
	const item = (route, more) => ({ url: `https://${route.startsWith("npm/") ? "registry.npmjs.org" : "github.com/k2-fsa/sherpa-onnx/releases/download"}/${route.replace(/^(npm|gh)\//, "")}`, sha256: sha(served[route]), bytes: served[route].length, ...more });
	const catalogue = { ENGINE: { node: item("npm/node.tgz", { into: "sherpa-onnx-node" }), [kind]: item("npm/native.tgz", { into: `sherpa-onnx-${kind}` }) }, MODELS: {} };
	for (const [key, m] of Object.entries(S.MODELS)) {
		if (m.file) {
			served[`gh/${m.file}`] = Buffer.from(`stand-in ${key} ${"x".repeat(300000)}`);
			catalogue.MODELS[key] = item(`gh/${m.file}`, { name: m.name, file: m.file });
			continue;
		}
		const dir = path.join(pack, key, m.dir);
		for (const f of m.has) {
			fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
			fs.writeFileSync(path.join(dir, f), f.endsWith("en.wav") ? enWav : f.endsWith("zh.wav") ? zhWav : crypto.randomBytes(key === "judge" ? 400000 : 20000));
		}
		tar(["-cjf", path.join(pack, `${key}.tar.bz2`), m.dir], path.join(pack, key));
		served[`gh/${key}.tar.bz2`] = fs.readFileSync(path.join(pack, `${key}.tar.bz2`));
		catalogue.MODELS[key] = item(`gh/${key}.tar.bz2`, { name: m.name, dir: m.dir, has: m.has });
	}
	const catalogueFile = path.join(tmp, "catalogue.json");
	fs.writeFileSync(catalogueFile, JSON.stringify(catalogue));
	const net = { asked: [], ranges: [], cutOnce: "gh/judge.tar.bz2", spoil: "", down: false };
	const source = http.createServer((req, res) => {
		const route = decodeURIComponent(req.url.slice(1));
		net.asked.push(route);
		let body = served[route];
		if (net.down || !body) {
			res.writeHead(net.down ? 503 : 404);
			return res.end();
		}
		if (net.spoil === route) body = Buffer.concat([Buffer.from("XX"), body.subarray(2)]);
		const m = /bytes=(\d+)-/.exec(req.headers.range || "");
		const from = m ? Number(m[1]) : 0;
		if (m) net.ranges.push(`${route}@${from}`);
		res.writeHead(m ? 206 : 200, { "content-length": body.length - from });
		// One download loses its connection part way through, once.
		if (net.cutOnce === route && !m) {
			net.cutOnce = "";
			res.write(body.subarray(0, Math.floor(body.length / 2)));
			return setTimeout(() => res.destroy(), 50);
		}
		res.end(body.subarray(from));
	});
	await new Promise((r) => source.listen(0, "127.0.0.1", r));
	const nothing = http.createServer((_, res) => {
		res.writeHead(404);
		res.end();
	});
	await new Promise((r) => nothing.listen(0, "127.0.0.1", r));
	const hubHome = path.join(tmp, "AllKnowing");
	fs.mkdirSync(hubHome);
	const port = 20000 + Math.floor(Math.random() * 20000);
	const writeConfig = (speechKey) => fs.writeFileSync(path.join(hubHome, "config.json"), JSON.stringify({ port, code: "TEST-CODE-2345", claudeKey: "", speechKey }));
	writeConfig("");
	let proc = null;
	let hubLog = "";
	const startHub = async (extra = {}) => {
		proc = spawn(process.execPath, [HUB], {
			env: { ...process.env, AK_HUB_HOME: hubHome, AK_HUB_BIND: "127.0.0.1", AK_HUB_SOURCE: `http://127.0.0.1:${nothing.address().port}`, AK_HUB_SPEECH_SOURCE: `http://127.0.0.1:${source.address().port}`, AK_SPEECH_CATALOGUE: catalogueFile, AK_FAKE_SCRIPT: scriptFile, AK_HUB_FFMPEG: "", AK_HUB_AFCONVERT: "", AK_HUB_RETRY_MS: "1", AK_HUB_CLAUDE: path.join(os.tmpdir(), "no-such-claude"), AK_HUB_RELAY_PORT: String(port + 1), ...extra },
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout.on("data", (d) => {
			hubLog += d;
		});
		proc.stderr.on("data", (d) => {
			hubLog += d;
		});
		if (!(await until(async () => fetch(`http://127.0.0.1:${port}/api/hello`).then((x) => x.ok, () => false)))) throw new Error(`the hub didn't start: ${hubLog}`);
	};
	const stopHub = async () => {
		if (!proc) return;
		const p = proc;
		proc = null;
		p.kill("SIGTERM");
		await new Promise((r) => p.on("close", r));
	};
	const req = async (method, route, body, raw) => {
		const x = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { "x-api-key": "TEST-CODE-2345", ...(raw || body === undefined ? {} : { "content-type": "application/json" }) }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
		return { status: x.status, json: await x.json().catch(() => ({})) };
	};
	const localNow = async () => (await req("GET", "/api/status")).json.local || {};
	const send = async (name, buf, more = {}) => {
		const made = await req("POST", "/api/transcribe", { name, size: buf.length, terms: ["Zhou"], ...more });
		if (made.status !== 200) return made;
		await req("PUT", `/api/transcribe/${made.json.id}/data?at=0`, buf, true);
		return req("POST", `/api/transcribe/${made.json.id}/start`);
	};
	const follow = async (id, states = ["done", "error"], ms = 30000) => {
		const seen = [];
		let st = {};
		await until(async () => {
			st = (await req("GET", `/api/transcribe/${id}`)).json;
			seen.push(st);
			return states.includes(st.state);
		}, ms);
		return { st, seen };
	};
	const workers = () => spawnSync("pgrep", ["-f", `speech.cjs (run|step).*${hubHome}`]).stdout.toString().trim().split("\n").filter(Boolean).length;
	try {
		net.spoil = "gh/cjk.tar.bz2";
		await startHub();
		const seenStates = new Set();
		let top = 0;
		let fell = false;
		const settled = () =>
			until(async () => {
				const l = await localNow();
				seenStates.add(l.state);
				if (l.state === "getting") {
					if (l.progress < top) fell = true;
					top = Math.max(top, l.progress);
				}
				return l.state === "error" || l.state === "ready";
			}, 60000, 10);
		await settled();
		let l = await localNow();
		ok("a download that isn't the expected file is refused, and it says so", l.state === "error" && /wasn't the file that was expected/.test(l.error) && seenStates.has("getting"), JSON.stringify(l));
		ok("…and a recording is turned away meanwhile, with the reason", ((await send("m.wav", meeting)).json.error || {}).type === "no_engine");
		const before = net.asked.length;
		net.spoil = "";
		top = 0;
		ok("Try again starts it afresh", (await req("POST", "/api/speech/setup")).status === 200);
		await settled();
		l = await localNow();
		ok("then everything is fetched, unpacked and tried out", l.state === "ready" && l.perHour > 0 && l.models.includes("Qwen3-ASR") && S.missing.length >= 0 && fs.existsSync(path.join(hubHome, "speech", "ready.json")), JSON.stringify(l) + hubLog.slice(-600));
		const again = net.asked.slice(before);
		ok("…without fetching again what had already arrived", again[0] === "gh/cjk.tar.bz2" && !again.some((x) => /^npm\/|silero|first|latin/.test(x)), again.join());
		ok("a dropped connection carried on from where it stopped", again.filter((x) => x === "gh/judge.tar.bz2").length === 2 && net.ranges.some((x) => x.startsWith("gh/judge.tar.bz2@") && !x.endsWith("@0")), `${again.join()} | ${net.ranges.join()}`);
		ok("…progress went forward, and nothing is left in the downloads folder", top > 0.3 && !fell && fs.readdirSync(path.join(hubHome, "speech", "downloads")).length === 0, `${top} ${fell}`);
		const fetched = net.asked.length;
		ok("the engine and the models are where the worker looks", fs.existsSync(path.join(hubHome, "speech", "engine", "node_modules", "sherpa-onnx-node", "sherpa-onnx.js")) && fs.existsSync(path.join(hubHome, "speech", "models", S.MODELS.judge.dir, "tokenizer", "vocab.json")) && fs.existsSync(path.join(hubHome, "speech", "models", S.MODELS.vad.file)));

		let sent = await send("Supplier call.wav", meeting);
		ok("a recording goes to the Mac's own models when no way is asked for", sent.status === 200 && sent.json.engine === "local", JSON.stringify(sent.json));
		let f = await follow(sent.json.id);
		const got = await req("POST", `/api/transcribe/${sent.json.id}/claim`, { by: "check" });
		ok("…and comes back as it was said, with voices and the places in doubt", f.st.state === "done" && same(got.json.lines || []) === "" && got.json.voices === 3 && got.json.lines.filter((x) => x.alt).length === 2 && got.json.by === "this Mac", `${JSON.stringify(f.st)} ${same(got.json.lines || [])}`);
		ok("…the status said which way, which step and how far", f.seen.some((x) => x.state === "transcribing" && x.engine === "local") && f.st.progress === 1 && f.st.lines === 7 && f.st.voices === 3, JSON.stringify(f.seen.slice(-3)));
		ok("…and only the text is kept", fs.readdirSync(path.join(hubHome, "recordings", sent.json.id)).sort().join() === "job.json,result.json");
		ok("the log says so, and holds none of the words", /made on this Mac: 1 min, 7 lines, 3 voice\(s\), 2 place\(s\) in doubt/.test(hubLog) && !/pricing|发货/.test(hubLog), hubLog.slice(-300));

		ok("Soniox can't be asked for without a key", ((await req("POST", "/api/transcribe", { name: "a.wav", size: 10, engine: "soniox" })).json.error || {}).type === "no_key");
		const odd = await send("phone.mp3", Buffer.concat([Buffer.from("ID3"), crypto.randomBytes(5000)]));
		f = await follow(odd.json.id);
		ok("a file nothing here can read says what to do", f.st.state === "error" && /nothing to read this kind of recording with/.test(f.st.error), JSON.stringify(f.st));

		// Stopped while the models are at work.
		await stopHub();
		await startHub({ AK_FAKE_SLOW_MS: "400" });
		ok("after a restart the models are ready at once, with nothing fetched", (await localNow()).state === "ready" && net.asked.length === fetched);
		sent = await send("Changed my mind.wav", meeting);
		await follow(sent.json.id, ["transcribing"]);
		await until(() => workers() > 0, 5000);
		const dropped = await req("DELETE", `/api/transcribe/${sent.json.id}`);
		ok("stopping one ends its work and clears it away", dropped.status === 200 && (await until(() => workers() === 0, 8000)) && !fs.existsSync(path.join(hubHome, "recordings", sent.json.id)), `${workers()} still at work`);

		// The hub goes down part way through a recording.
		sent = await send("Long one.wav", meeting);
		await until(async () => fs.existsSync(path.join(hubHome, "recordings", sent.json.id, "second.jsonl")), 20000);
		await stopHub();
		await until(() => workers() === 0, 8000);
		ok("when the hub stops, so does the work", workers() === 0);
		await startHub();
		f = await follow(sent.json.id);
		const late = await req("POST", `/api/transcribe/${sent.json.id}/claim`, { by: "check" });
		ok("a recording under way carries on after a restart", f.st.state === "done" && same(late.json.lines || []) === "", `${JSON.stringify(f.st)} ${same(late.json.lines || [])}`);

		// A model that fails, with and without Soniox to fall back on.
		await stopHub();
		await startHub({ AK_FAKE_FAIL: "judge" });
		sent = await send("Unlucky.wav", meeting);
		f = await follow(sent.json.id);
		ok("a failure is told plainly", f.st.state === "error" && /own speech models couldn't finish this recording\. Try again\.$/.test(f.st.error), JSON.stringify(f.st));
		await stopHub();
		writeConfig("a-soniox-key");
		await startHub({ AK_FAKE_FAIL: "judge", AK_HUB_SONIOX: `http://127.0.0.1:${nothing.address().port}` });
		f = { st: (await req("POST", `/api/transcribe/${sent.json.id}/start`)).json };
		f = await follow(sent.json.id);
		ok("…and with a Soniox key saved, offers that for this one", f.st.state === "error" && /or use Soniox for this one/.test(f.st.error), JSON.stringify(f.st));
		const swapped = await req("POST", `/api/transcribe/${sent.json.id}/start`, { engine: "soniox" });
		ok("the same recording can be sent the other way, starting afresh", swapped.status === 200 && swapped.json.engine === "soniox" && swapped.json.state === "queued" && !fs.existsSync(path.join(hubHome, "recordings", sent.json.id, "first.jsonl")), JSON.stringify(swapped.json));
		await req("DELETE", `/api/transcribe/${sent.json.id}`);
		const both = await req("POST", "/api/transcribe", { name: "b.wav", size: 10 });
		const paid = await req("POST", "/api/transcribe", { name: "c.wav", size: 10, engine: "soniox" });
		ok("with both there, the free way is the one used unless Soniox is asked for", both.json.engine === "local" && paid.json.engine === "soniox", JSON.stringify([both.json.engine, paid.json.engine]));
		await req("DELETE", `/api/transcribe/${both.json.id}`);
		await req("DELETE", `/api/transcribe/${paid.json.id}`);

		await stopHub();
		await startHub({ AK_HUB_SPEECH: "off" });
		l = await localNow();
		const viaKey = await req("POST", "/api/transcribe", { name: "d.wav", size: 10 });
		ok("switched off, recordings go to Soniox as before", l.state === "off" && viaKey.json.engine === "soniox", JSON.stringify([l, viaKey.json]));
	} finally {
		await stopHub();
		source.close();
		nothing.close();
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
	process.exit(failed ? 1 : 0);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
