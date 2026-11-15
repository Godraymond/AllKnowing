// Checks the 狼人杀 speaker tracking in index.html (who is speaking, from cues, order, voices and Claude's answers).
// Run: node assistant/check-seat-tracking.cjs
// It lifts the tracking code out of index.html, stubs the page around it and plays a few tables through it.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const from = html.indexOf("/* ---------- 狼人杀: who is speaking");
const to = html.indexOf('function addSeg(kind, text, sp = "") {');
if (from < 0 || to < 0) throw new Error("Couldn't find the speaker-tracking code in index.html");
const STUBS = String.raw`const log = [];
const state = { settings: { autoSeat: true }, tr: { seat: 0, by: "", ended: false, fresh: false, dir: 1 }, closeSeg: false, openSegId: null, segEls: new Map(), myTurnAt: 0, sayCtl: null, sayNow: null, aiBlocked: false, cur: null, speaker: "", curVoice: 0, lastHeardAt: 0, listening: false, dirtyMeeting: false };
const cap = { sample: {} };
let idn = 0;
const uid = () => "s" + (++idn);
const arr = (v, max = 50) => (Array.isArray(v) ? v : []).slice(0, max);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const clampNum = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : lo; };
const markSegDirty = () => {};
const ensureClock = () => {};
const renderSegUpdate = () => {};
const renderChips = () => {};
const segEl = () => null;
const toast = (t) => log.push("toast: " + t);
const maybeAutoUpdate = (turn) => { if (turn) log.push("update@turn"); };
const askSayNow = () => log.push("SPEECH");
const isListening = () => state.listening;
const voiceName = () => "";
const nameVoice = () => {};
function addSeg(kind, text) { const m = state.cur; m.segs.push({ id: uid(), t: (Date.now() - m.startedAt) / 1000, sp: "", text, kind }); state.openSegId = null; }
`;
// hear(text, pause before it in seconds, voice number from the speech service or 0 for words only)
const HARNESS = String.raw`function hear(text, gap = 0, v = 0) {
  const m = state.cur;
  const pieces = autoSeatOn() ? splitHeard(text, m, state.tr) : [text];
  pieces.forEach((piece, i) => addHeard(m, piece, i === 0 ? gap : 0, Date.now(), v));
}
function newGame(players = 12, seat = 3) {
  state.cur = { mode: "werewolf", startedAt: Date.now(), segs: [], game: { players, seat, out: [] }, live: null };
  state.tr = newTracker(); state.closeSeg = false; state.openSegId = null; state.myTurnAt = 0; state.sayNow = null; log.length = 0;
  state.curVoice = 0; state.listening = false;
  return state.cur;
}
({ state, log, hear, newGame, seatCue, seatStep, splitHeard, applySpeakers, trackerAt, nextSeat, endsTurn, speakingKey, stepSpeaker, setSpeaker, newTracker, voiceMap, sweepVoices });
`;
const T = vm.runInNewContext(STUBS + html.slice(from, to) + HARNESS, { console });
const { state, log, hear, newGame } = T;
let fails = 0;
const tags = (m) => m.segs.filter((s) => s.kind === "speech").map((s) => s.sp || "??");
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) fails++;
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "\n   got  " + JSON.stringify(got) + "\n   want " + JSON.stringify(want)}`,
	);
};

// A. A normal round with a moderator
let m = newGame(12, 7);
hear("天黑请闭眼。");
hear("狼人请睁眼，请确认同伴。", 3);
hear("天亮了，昨晚是平安夜。", 20);
hear("从5号玩家开始发言。", 2);
hear("我是预言家，昨晚验了8号，8号是狼人。", 3);
hear(" 昨晚是平安夜，说明女巫开了解药。");
hear(" 我的警徽流是3号、9号。过。");
hear("我觉得5号的发言没什么问题，我站边5号。", 4);
hear("我过了。");
eq(
	"A tags",
	tags(m),
	["法官", "法官", "法官", "法官", "#5", "#5", "#6", "#6"].slice(0, tags(m).length),
);
eq("A my turn after #6 passes (I'm #7)", log.filter((x) => x === "SPEECH").length, 1);
eq("A floor is mine next", T.speakingKey(m), "#7");
hear("我是7号，我站边5号，今天出8号。过。", 5);
hear("请8号玩家发言。", 2);
hear("我才是真预言家，5号是悍跳狼。", 3);
eq("A later tags", tags(m).slice(-3), ["#7", "法官", "#8"]);
eq(
	"A phases",
	m.segs.filter((s) => s.kind === "event").map((s) => s.text),
	["天黑 · Night", "天亮 · Day"],
);

// B. No calls after the start; direction learned from a self-intro going down
m = newGame(9, 2);
hear("请6号发言。");
hear("我先简单聊一下，我是好人。过。", 2);
hear("我是5号，我也是好人，我没见过这种打法。", 3);
hear(" 就这样，过。");
hear("我觉得6号有点问题。过。", 3);
hear("3号这边没什么信息，过。", 3);
eq("B tags (down: 6,5,4,3)", tags(m), ["法官", "#6", "#5", "#5", "#4", "#3"]);
eq("B direction", state.tr.dir, -1);
eq("B my turn (I'm #2) after #3 passes", log.filter((x) => x === "SPEECH").length, 1);

// C. Speech-to-text runs three speakers into one phrase
m = newGame(12, 3);
hear("请5号发言。");
hear("我是好人，我站边8号。我过了。请6号发言。我是6号，我觉得5号像狼。", 2);
eq("C tags", tags(m), ["法官", "#5", "法官", "#6"]);

// D. Things that must not move the floor
m = newGame(12, 3);
hear("请5号发言。");
hear("5号的发言有问题，这是8号刚才说的。", 2);
hear(" 我是5号查验的金水？不是的。");
hear(" 从5号开始我就觉得他发言不对，这种话我没见过。");
hear(" 请大家投票给8号。");
hear(" 5号发言有问题这种说法我不认。");
eq("D all still #5", tags(m), ["法官", "#5", "#5"]);
eq("D floor", T.speakingKey(m), "#5");

// E. Traditional characters and Chinese numerals
m = newGame(12, 3);
hear("天黑請閉眼。");
hear("天亮了。", 9);
hear("請十二號玩家發言。", 2);
hear("我係好人。我過了。", 2);
hear("我是一號，我覺得十二號冇問題。", 3);
eq("E tags", tags(m), ["法官", "法官", "法官", "#12", "#1"]);

// F. Seats that are out are skipped; "next" from the moderator
m = newGame(6, 1);
m.game.out = [4];
m.live = { players: [{ seat: 5, status: "out" }] };
hear("从3号开始发言。");
hear("我是好人，过。", 2);
hear("下一位。", 1);
hear("我6号，我也是好人。过。", 2);
eq("F tags (4 and 5 are out)", tags(m), ["法官", "#3", "法官", "#6"]);
eq("F my turn (I'm #1)", log.filter((x) => x === "SPEECH").length, 1);

// G. Nothing to go on, then Claude's pass
m = newGame(8, 2);
hear("我先说一下，我昨晚验了3号，是好人。", 0);
hear("我觉得刚才预言家的发言可以相信。", 6);
hear("我是真预言家，前面那个是悍跳。", 7);
eq("G before: unknown", tags(m), ["??", "??", "??"]);
const seen = m.segs.length;
const floorG = { ...state.tr };
hear("所以今天应该出他。", 0); // heard while Claude was thinking
T.applySpeakers(
	m,
	{
		speakers: [
			{ line: 0, seat: 4, sure: 70 },
			{ line: 1, seat: 5, sure: 45 },
			{ line: 2, seat: 6, sure: 80 },
			{ line: 99, seat: 1, sure: 90 },
		],
		turn: { speaking: "#6", next: 7, direction: "up" },
	},
	seen,
	floorG,
);
eq(
	"G after (the late words joined line 2)",
	m.segs.map((s) => `${s.sp} ${s.by}${s.c || ""}`),
	["#4 ai70", "#5 ai45", "#6 ai80"],
);
eq("G floor follows Claude", T.speakingKey(m), "#6");
hear(" 过。");
hear("我是好人，没什么可说的。", 3);
eq("G order carries on from Claude's seat", tags(m).slice(-1), ["#7"]);

// H. Claude overrides an assumed tag but not a heard one without strong evidence
m = newGame(8, 2);
hear("请4号发言。");
hear("我是好人。", 2);
hear("我其实是5号，刚才4号没说话。", 6); // tagged #4 by order
T.applySpeakers(
	m,
	{
		speakers: [
			{ line: "L1", seat: 5, sure: 60 },
			{ line: 2, seat: "#5", sure: 60 },
		],
		turn: { speaking: 5, next: 6, direction: "up" },
	},
	m.segs.length,
	{ ...state.tr },
);
eq(
	"H heard stays, assumed changes",
	m.segs.map((s) => `${s.sp} ${s.by}`),
	["法官 cue", "#4 cue", "#5 ai"],
);
T.applySpeakers(
	m,
	{ speakers: [{ line: 1, seat: 5, sure: 90 }], turn: { speaking: 5, next: 6, direction: "up" } },
	m.segs.length,
	{ ...state.tr },
);
eq("H heard changes at 90", m.segs[1].sp, "#5");

// I. Manual correction still works and wins
m = newGame(8, 2);
T.setSpeaker("#3");
hear("随便说两句。");
T.applySpeakers(
	m,
	{ speakers: [{ line: 0, seat: 6, sure: 99 }], turn: { speaking: 6, next: 7, direction: "up" } },
	m.segs.length,
	{ ...state.tr },
);
eq("I tap is kept", `${m.segs[0].sp} ${m.segs[0].by}`, "#3 tap");
T.stepSpeaker(1);
eq("I next seat", T.speakingKey(m), "#4");

// J. Rebuild after a reload
m = newGame(8, 2);
hear("请4号发言。");
hear("我是好人。过。", 2);
state.tr = T.trackerAt(m, m.segs.length, { speaking: 0, next: 0, dir: 1 });
eq("J rebuilt floor: next is #5", T.speakingKey(m), "#5");

// K. My seat called by the moderator; no repeat within 90s
m = newGame(8, 2);
hear("请2号发言。");
hear("我是2号。", 1);
hear("请2号玩家继续发言。", 1);
eq("K one speech", log.filter((x) => x === "SPEECH").length, 1);

// M. Claude corrects the order; lines heard meanwhile are re-tagged from its view
m = newGame(8, 2);
hear("请4号发言。");
hear("我是好人。过。", 2);
hear("我觉得4号不错。", 3);
const seenM = m.segs.length;
const floorM = { ...state.tr };
hear("我站边他。", 3);
hear(" 过。");
hear("轮到我了，我是好人。", 4);
eq("M before (assumed going up)", tags(m), ["法官", "#4", "#5", "#5", "#6"]);
log.length = 0;
T.applySpeakers(
	m,
	{
		speakers: [{ line: 2, seat: 3, sure: 75 }],
		turn: { speaking: 3, next: 2, direction: "down" },
	},
	seenM,
	floorM,
);
eq(
	"M after (going down)",
	m.segs.map((s) => `${s.sp} ${s.by}`),
	["法官 cue", "#4 cue", "#3 ai", "#3 order", "#2 order"],
);
eq("M my turn found by the re-tag (I'm #2)", log.filter((x) => x === "SPEECH").length, 1);

// N. Moderator lines in the middle of nowhere, vote, and a typed-style call in English
m = newGame(8, 2);
hear("所有玩家请投票，3、2、1。");
hear("5号玩家出局，请5号玩家发表遗言。", 6);
hear("我是好人，你们投错了。", 2);
eq("N tags", tags(m), ["法官", "法官", "#5"]);
eq(
	"N vote logged",
	m.segs.filter((s) => s.kind === "event").map((s) => s.text),
	["投票 · Vote"],
);

// O. A vote-out with last words, then the night
m = newGame(8, 2);
hear("请5号发言。");
hear("我是好人。过。", 2);
hear("开始投票。", 5);
hear("6号玩家被放逐，请发表遗言。", 8);
hear("我是猎人，我带走3号。", 2);
hear("6号的遗言我不信，3号出局之后局势就清楚了。", 3);
hear("天黑请闭眼。", 6);
eq("O tags", tags(m), ["法官", "#5", "法官", "法官", "#6", "#6", "法官"]);

// P. Claude returns nothing useful: the page's own tracking is left alone
m = newGame(8, 2);
hear("请4号发言。");
hear("我是好人。过。", 2);
hear("下一位。", 1);
const seenP = m.segs.length;
const floorP = { ...state.tr };
hear("我觉得4号不错。", 2);
T.applySpeakers(m, {}, seenP, floorP);
eq(
	"P tags kept",
	m.segs.map((s) => `${s.sp} ${s.by}`),
	["法官 cue", "#4 cue", "法官 cue", "#5 order"],
);
eq("P floor kept", T.speakingKey(m), "#5");
T.applySpeakers(
	m,
	{ speakers: "nonsense", turn: { speaking: "法官", next: "?", direction: 3 } },
	m.segs.length,
	{ ...state.tr },
);
eq("P junk ignored", T.speakingKey(m), "#5");

// ---- Voices: the web app's listener also says which voice spoke (third argument of hear) ----
const how = (m2) =>
	m2.segs.filter((s) => s.kind === "speech").map((s) => `${s.sp || "??"} ${s.by || "-"}`);

// V1. Nobody is heard saying 过, but the voice changes: the floor still moves on
m = newGame(9, 9);
hear("请3号发言。", 0, 1);
hear("我是好人，昨晚没什么信息，我觉得5号有点问题。", 2, 2);
hear("先听后面的发言吧。", 0, 2);
hear("我这边是一张平民牌，我觉得3号说得有道理。", 1, 3);
eq("V1 a new voice waits one phrase before it is believed", tags(m), ["法官", "#3", "#3", "??"]);
hear("今天我会跟着3号投票。", 0, 3);
eq("V1 then takes the next seat, first phrase included", tags(m), ["法官", "#3", "#3", "#4", "#4"]);
hear("对。", 0, 2);
eq(
	"V1 a word from the side keeps its own seat and the floor stays",
	[tags(m).at(-1), T.speakingKey(m)],
	["#3", "#4"],
);
hear("我是5号，我是预言家，昨晚验了3号是好人。", 2, 4);
hear("过。", 0, 4);
hear("过。", 1, 5);
hear("我觉得5号是真预言家，我站边5号，今天出4号。", 1, 6);
eq("V1 whole round", tags(m), ["法官", "#3", "#3", "#4", "#4", "#3", "#5", "#5", "#6", "#7"]);
eq("V1 how each tag was set", how(m), [
	"法官 cue",
	"#3 cue",
	"#3 voice",
	"#4 order",
	"#4 order",
	"#3 voice",
	"#5 cue",
	"#5 voice",
	"#6 order",
	"#7 order",
]);

// V2. The moderator's voice is learned from the calls, so their other remarks aren't given to the called seat
m = newGame(9, 5);
hear("请2号发言。", 0, 1);
hear("大家安静一下。", 0, 1);
hear("我昨晚守对了人，我是守卫。", 1, 2);
eq("V2 tags", how(m), ["法官 cue", "法官 voice", "#2 cue"]);

// V3. Claude says whose voice is whose: untagged lines take it, and so do later lines
m = newGame(9, 9);
hear("我先说两句，我是好人。", 0, 1);
hear("我觉得不对，1号像狼。", 1, 2);
hear("你凭什么这么说？", 1, 1);
eq("V3 nobody has the floor yet", tags(m), ["??", "??", "??"]);
T.applySpeakers(
	m,
	{
		voices: [
			{ voice: 1, seat: 4, sure: 85 },
			{ voice: "v2", seat: 6, sure: 80 },
			{ voice: 9, seat: 1, sure: 90 },
		],
		turn: { speaking: 4, next: 5, direction: "up" },
	},
	m.segs.length,
	{ ...state.tr },
);
eq("V3 after Claude's voice map", how(m), ["#4 voice", "#6 voice", "#4 voice"]);
eq("V3 a voice that was never heard is ignored", Object.keys(m.voices), ["1", "2"]);
hear("我再补充一点。", 0, 1);
hear("我不同意4号说的，我才是好人。", 1, 2);
eq("V3 later lines follow the voices", tags(m), ["#4", "#6", "#4", "#6"]);
eq(
	"V3 the same voice carrying on joins its last line",
	m.segs[2].text,
	"你凭什么这么说？我再补充一点。",
);
eq("V3 floor follows the voice", T.speakingKey(m), "#6");

// V4. The user taps a seat while someone is talking: that voice is that seat from then on
m = newGame(9, 9);
hear("请5号发言。", 0, 1);
hear("我是好人，我觉得7号有问题。", 1, 2);
hear("我不同意5号，我才是好人，5号在乱说。", 1, 3);
eq("V4 before the tap", tags(m), ["法官", "#5", "??"]);
state.curVoice = 3;
state.listening = true;
state.lastHeardAt = Date.now();
T.setSpeaker("#8");
hear("所以今天应该出5号。", 0, 3);
eq("V4 after the tap", how(m), ["法官 cue", "#5 cue", "#8 voice", "#8 tap"]);
eq("V4 the tap is kept as the answer for that voice", m.voices[3], { sp: "#8", by: "tap", c: 100 });
T.applySpeakers(m, { voices: [{ voice: 3, seat: 2, sure: 95 }] }, m.segs.length, { ...state.tr });
eq("V4 Claude can't overrule the user", m.voices[3].sp, "#8");

// V5. A well-established voice isn't given to whoever the moderator just called; a weaker one is
m = newGame(9, 9);
hear("请3号发言。", 0, 1);
hear("我是好人，没有信息。过。", 1, 2);
hear("请4号发言。", 0, 1);
hear("我也是好人，过。", 1, 3);
hear("请3号发言。", 5, 1);
hear("我还是觉得4号有问题。过。", 1, 2);
eq("V5 voice 2 is seat 3 beyond doubt", T.voiceMap(m).get(2), { sp: "#3", strong: true });
hear("请4号发言。", 0, 1);
hear("等一下，我还要补充一点，4号昨天的发言前后矛盾。", 0, 2);
eq("V5 seat 3 cuts in after the call", [how(m).at(-1), T.speakingKey(m)], ["#3 voice", "#4"]);
hear("我没有矛盾，3号在带节奏。", 1, 3);
eq("V5 then the called seat speaks", how(m).at(-1), "#4 cue");

// V6. The same voice carrying on after 过 keeps the floor; a new voice then takes the next seat
m = newGame(9, 9);
hear("请6号发言。", 0, 1);
hear("我是平民，没什么要说的，过。", 1, 2);
hear("哦对了我想起来，昨天8号投票的时候很犹豫。", 1, 2);
eq("V6 still seat 6", [tags(m).at(-1), T.speakingKey(m)], ["#6", "#6"]);
hear("过。", 0, 2);
hear("我是好人，我同意6号。", 2, 3);
eq("V6 tags", tags(m), ["法官", "#6", "#6", "#7"]);

// V7. A laugh from a voice nobody can place doesn't move the floor
m = newGame(9, 9);
hear("请2号发言。", 0, 1);
hear("我是预言家，昨晚验了5号，5号是好人。", 1, 2);
hear("哈哈。", 0, 7);
hear("所以今天我建议出7号。", 0, 2);
eq("V7 tags", tags(m), ["法官", "#2", "??", "#2"]);

// V8. Words only (no voices): exactly the behaviour of the tests above, and no line gets a voice
m = newGame(9, 9);
hear("请2号发言。");
hear("我是好人。过。", 1);
hear("我也是好人。", 2);
eq("V8 tags", how(m), ["法官 cue", "#2 cue", "#3 order"]);
eq("V8 no voices stored", [m.segs.some((s) => "v" in s), m.voices === undefined], [false, true]);

// V9. Reopening a game picks up the floor-holder's voice from the last line
m = newGame(9, 9);
hear("请2号发言。", 0, 1);
hear("我是好人，我先说到这里。", 1, 2);
eq(
	"V9 tracker rebuilt from the lines",
	(({ seat, v }) => ({ seat, v }))(
		T.trackerAt(m, m.segs.length, { speaking: 0, next: 0, dir: 1 }),
	),
	{ seat: 2, v: 2 },
);

// V10. A new voice after a clear pause is the next seat at once; without the pause it waits for a second phrase
m = newGame(9, 9);
hear("请2号发言。", 0, 1);
hear("我是好人，我先说到这里。", 1, 2);
hear("我是平民，昨天我投了5号，今天我还是觉得5号有问题。", 3, 3);
eq("V10 tags", how(m), ["法官 cue", "#2 cue", "#3 order"]);
hear("我跟前面的意见不太一样，我觉得3号更可疑。", 0.4, 4);
eq("V10 no pause: not believed yet", tags(m).at(-1), "??");

// V11. A lone 过 from a voice nobody can place ends the floor-holder's turn (one syllable is too little to tell voices apart)
m = newGame(9, 9);
hear("请2号发言。", 0, 1);
hear("我是好人，我没有更多的信息了。", 1, 2);
hear("过。", 0, 6);
eq("V11 tags", how(m), ["法官 cue", "#2 cue", "#2 order"]);
eq("V11 floor moves on", T.speakingKey(m), "#3");

// L. End markers
for (const [txt, want] of [
	["过。", true],
	["我过了", true],
	["那我就先过了。", true],
	["好，过麦。", true],
	["发言完毕。", true],
	["我说完了", true],
	["pass", true],
	["I think so. Pass.", true],
	["我没见过", false],
	["这个逻辑说不过", false],
	["他昨天说过。", false],
	["过一会儿再说", false],
	["所以不能放过", false],
	["今天出8号我过了", true],
	["我站边5号 过", true],
	["这轮我先过", true],
	["已经讨论过了", false],
	["我们聊过", false],
	["好的过麦", true],
]) {
	eq(`L end "${txt}"`, T.endsTurn(txt), want);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exitCode = fails ? 1 : 0;
