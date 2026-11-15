// Checks the 狼人杀 speaker tracking in index.html (who is speaking, from cues, order and Claude's answers).
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
const state = { settings: { autoSeat: true }, tr: { seat: 0, by: "", ended: false, fresh: false, dir: 1 }, closeSeg: false, openSegId: null, segEls: new Map(), myTurnAt: 0, sayCtl: null, sayNow: null, aiBlocked: false, cur: null, speaker: "" };
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
function addSeg(kind, text) { const m = state.cur; m.segs.push({ id: uid(), t: (Date.now() - m.startedAt) / 1000, sp: "", text, kind }); state.openSegId = null; }
`;
const HARNESS = String.raw`function hear(text, gap = 0) {
  const m = state.cur;
  const pieces = autoSeatOn() ? splitHeard(text, m, state.tr) : [text];
  pieces.forEach((piece, i) => addHeard(m, piece, i === 0 ? gap : 0, Date.now()));
}
function newGame(players = 12, seat = 3) {
  state.cur = { mode: "werewolf", startedAt: Date.now(), segs: [], game: { players, seat, out: [] }, live: null };
  state.tr = newTracker(); state.closeSeg = false; state.openSegId = null; state.myTurnAt = 0; state.sayNow = null; log.length = 0;
  return state.cur;
}
({ state, log, hear, newGame, seatCue, seatStep, splitHeard, applySpeakers, trackerAt, nextSeat, endsTurn, speakingKey, stepSpeaker, setSpeaker, newTracker });
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
