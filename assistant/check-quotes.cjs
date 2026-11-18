// Checks that a key quote is only shown if it was said: saidQuotes() in index.html, without a browser.
// Run: node assistant/check-quotes.cjs
// Claude is asked for the things said that are worth keeping word for word. The page holds it to that:
// a quote whose words are not in the transcript is dropped, and the line the words are on decides whose
// they are. This takes that one function out of the page and tries it on a made-up meeting.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const from = page.indexOf("const bareWords =");
const to = page.indexOf("function normMeetingLive(");
if (from < 0 || to < from) {
	console.log(
		"FAIL can't find saidQuotes in index.html (it sits between bareWords and normMeetingLive)",
	);
	process.exit(1);
}
// The two helpers it leans on, as the page has them.
const box = {
	str: (v, max = 2000) => (typeof v === "string" ? v : "").trim().slice(0, max),
	voiceName: (m, v) => ((m.voices || {})[v] || {}).sp || "",
};
vm.createContext(box);
vm.runInContext(page.slice(from, to), box);

let fails = 0;
const ok = (name, pass, detail = "") => {
	if (!pass) fails++;
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass || !detail ? "" : `\n   ${detail}`}`);
};
const q = (who, quote) => ({ who, quote, why: "why" });
const kept = (m, quotes) => box.saidQuotes(m, quotes).map((x) => `${x.who}: ${x.quote}`);
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);

const m = {
	voices: { 2: { sp: "Tom", by: "ai", c: 90 } },
	segs: [
		{
			t: 2,
			kind: "speech",
			sp: "Mori",
			text: "We can hold four eighty until June, if the order is confirmed this month.",
		},
		{
			t: 9,
			kind: "speech",
			sp: "Tom",
			v: 2,
			text: "Five weeks with a two percent penalty per week",
		},
		{ t: 12, kind: "speech", sp: "Tom", v: 2, text: "is fine by us." },
		{ t: 15, kind: "speech", sp: "Me", text: "好的，交期五周可以，但是每延迟一周罚百分之二。" },
		{ t: 20, kind: "note", sp: "", text: "Ask about credit insurance next time." },
		{ t: 21, kind: "event", text: "Listening paused" },
		{ t: 25, kind: "speech", sp: "Mori", text: "Agreed." },
		{ t: 27, kind: "speech", sp: "", v: 3, text: "Agreed. We will send the draft on Friday." },
		{ t: 31, kind: "speech", sp: "", text: "Nobody tagged this line but it was said." },
		{
			t: 35,
			kind: "speech",
			sp: "Ana",
			by: "ai",
			c: 40,
			text: "A line with a name that was only a guess.",
		},
	],
};

let got = kept(m, [
	q("Mori", "we can hold four eighty until June"),
	q("Mori", "WE CAN HOLD FOUR EIGHTY — until June; if the order is confirmed…"),
]);
ok(
	"words that are in the transcript are kept, whatever their capitals and punctuation",
	same(got, [
		"Mori: we can hold four eighty until June",
		"Mori: WE CAN HOLD FOUR EIGHTY — until June; if the order is confirmed…",
	]),
	got.join(" | "),
);

got = kept(m, [
	q("Mori", "We can hold $4.80 until June"),
	q("Mori", "We will hold the price until June"),
	q("Tom", "Mid March works for the pilot."),
	q("Mori", "We can hold four eighty … if the order is confirmed"),
]);
ok(
	"words that are not there are dropped: tidied up, reworded, made up, or joined from two places",
	got.length === 0,
	got.join(" | "),
);

got = kept(m, [q("Me", "Ask about credit insurance next time"), q("", "Listening paused")]);
ok(
	"a typed note or a marker in the transcript is not something anybody said",
	got.length === 0,
	got.join(" | "),
);

got = kept(m, [q("v2", "a two percent penalty per week is fine by us")]);
ok(
	"a sentence the speech service split over two lines is still one stretch of words",
	same(got, ["v2: a two percent penalty per week is fine by us"]),
	got.join(" | "),
);

got = kept(m, [
	q("", "交期五周可以，但是每延迟一周罚百分之二"),
	q("Me", "交期五周可以, 但是每延迟一周罚百分之二!"),
]);
ok(
	"Chinese is matched the same way, and the same words twice are shown once",
	same(got, ["Me: 交期五周可以，但是每延迟一周罚百分之二"]),
	got.join(" | "),
);

got = kept(m, [
	q("Priya", "we can hold four eighty"),
	q("Priya", "five weeks with a two percent penalty"),
]);
ok(
	"the name on the line wins over the one Claude gave: a tagged name, or a named voice as vN",
	same(got, ["Mori: we can hold four eighty", "v2: five weeks with a two percent penalty"]),
	got.join(" | "),
);

got = kept(m, [q("Ana", "we will send the draft on Friday")]);
ok(
	"a voice nobody has named keeps the name Claude put to it",
	same(got, ["Ana: we will send the draft on Friday"]),
	got.join(" | "),
);
got = kept(m, [q("v7", "We will send the draft"), q("", "send the draft on Friday")]);
ok(
	"…and otherwise goes by its own number, not another voice's",
	same(got, ["v3: We will send the draft", "v3: send the draft on Friday"]),
	got.join(" | "),
);

got = kept(m, [
	q("Sam", "nobody tagged this line"),
	q("", "but it was said"),
	q("Raj", "a name that was only a guess"),
]);
ok(
	"a line with no name, or only a guessed one, leaves the speaker to Claude",
	same(got, [
		"Sam: nobody tagged this line",
		": but it was said",
		"Raj: a name that was only a guess",
	]),
	got.join(" | "),
);

got = kept(m, [q("v3", "Agreed.")]);
ok("words said twice go to the speaker Claude meant", same(got, ["v3: Agreed."]), got.join(" | "));
got = kept(m, [q("Somebody", "Agreed.")]);
ok(
	"…and to whoever said them first when Claude's speaker said neither",
	same(got, ["Mori: Agreed."]),
	got.join(" | "),
);

got = kept(m, [q("Mori", "a"), q("Mori", "…"), q("Mori", "")]);
ok("a single letter or nothing but punctuation is no quote", got.length === 0, got.join(" | "));

got = kept({ segs: [{ t: 1, kind: "note", text: "We can hold four eighty until June." }] }, [
	q("Mori", "We can hold four eighty until June"),
]);
ok("with nothing said, nothing is quoted", got.length === 0, got.join(" | "));

const long = {
	segs: Array.from({ length: 4000 }, (_, i) => ({
		t: i,
		kind: "speech",
		sp: i % 2 ? "A" : "B",
		text: `Line number ${i} of a long meeting, no no no.`,
	})),
};
const start = Date.now();
got = kept(long, [
	q("A", "line number 3999 of a long meeting"),
	q("A", "no"),
	q("C", "line number 4000"),
]);
ok(
	"a long meeting is searched quickly",
	same(got, ["A: line number 3999 of a long meeting", "A: no"]) && Date.now() - start < 1000,
	`${got.join(" | ")} in ${Date.now() - start} ms`,
);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
