// Checks the way round Outlook's refusal in index.html, without a browser: the calendar file, the link
// that opens Outlook on the web's new-event form, how a refusal is recognised, and how Outlook's errors
// are shortened. Run: node assistant/check-outlook.cjs
// Claude's Microsoft 365 connector may only be allowed to read. Then Add to calendar offers a calendar
// file or Outlook on the web instead. This takes those pieces out of the page by name and tries them.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const cut = (from, to) => {
	const a = page.indexOf(from);
	const b = page.indexOf(to, a);
	if (a < 0 || b < a) {
		console.log(`FAIL can't find the part of index.html from "${from}" to "${to}"`);
		process.exit(1);
	}
	return page.slice(a, b);
};
const box = {
	h: () => ({}),
	uid: () => "abc123",
	window: { matchMedia: () => ({ matches: false }) },
	TextEncoder,
};
vm.createContext(box);
vm.runInContext(cut("const noWrite =", "function openEmailModal("), box);
vm.runInContext(cut("function outlookSaid(", "function mcpErrorText("), box);
const get = (name) => vm.runInContext(name, box);

let fails = 0;
const ok = (name, pass, detail = "") => {
	if (!pass) fails++;
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass || !detail ? "" : `\n   ${detail}`}`);
};

// ---- the calendar file
const notes = `Line one, with a comma; and a semicolon\nLine two: 中文的备注，看看折行是否正确，${"长".repeat(40)} 🙂🙂\nBack\\slash`;
const title =
	"Follow up: Secure updated mandate from Saws and partners, and have Scott back for the presentation";
const ev = {
	title,
	start: new Date("2026-12-01T01:00:00Z"),
	end: new Date("2026-12-01T01:30:00Z"),
	notes,
	busy: true,
};
const ics = get("icsFile")(ev);
const raw = Buffer.from(ics, "utf8");
ok(
	"ends every line with CRLF",
	ics.endsWith("\r\n") && !/[^\r]\n/.test(ics) && !/\r[^\n]/.test(ics),
);
const lines = ics.split("\r\n").slice(0, -1);
const long = lines.filter((l) => Buffer.byteLength(l, "utf8") > 75);
ok(
	"no line is longer than 75 bytes",
	long.length === 0,
	long.map((l) => Buffer.byteLength(l, "utf8")).join(", "),
);
// Each line on its own must be whole UTF-8: a line cut inside a character won't decode.
const strict = new TextDecoder("utf-8", { fatal: true });
const byteLines = [];
for (let at = 0; at < raw.length; ) {
	const end = raw.indexOf("\r\n", at);
	byteLines.push(raw.subarray(at, end));
	at = end + 2;
}
const broken = byteLines.filter((b) => {
	try {
		strict.decode(b);
		return false;
	} catch {
		return true;
	}
});
ok(
	"folding never splits a character",
	broken.length === 0 && byteLines.length === lines.length,
	`${broken.length} lines cut inside a character`,
);
const unfolded = ics.replace(/\r\n /g, "").split("\r\n");
const field = (name) =>
	(unfolded.find((l) => l.startsWith(`${name}:`)) || "").slice(name.length + 1);
const icsUnescape = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
ok(
	"one event, in a calendar",
	unfolded[0] === "BEGIN:VCALENDAR" &&
		unfolded.filter((l) => l === "BEGIN:VEVENT").length === 1 &&
		unfolded.at(-2) === "END:VCALENDAR",
);
ok(
	"times in UTC",
	field("DTSTART") === "20261201T010000Z" &&
		field("DTEND") === "20261201T013000Z" &&
		/^\d{8}T\d{6}Z$/.test(field("DTSTAMP")),
	`${field("DTSTART")} ${field("DTEND")} ${field("DTSTAMP")}`,
);
ok(
	"the title comes back as it was, comma included",
	icsUnescape(field("SUMMARY")) === title,
	field("SUMMARY"),
);
ok(
	"the notes come back as they were: commas, semicolons, new lines, Chinese, emoji and the backslash",
	icsUnescape(field("DESCRIPTION")) === notes,
	JSON.stringify(icsUnescape(field("DESCRIPTION"))),
);
ok(
	"busy blocks the time",
	field("TRANSP") === "OPAQUE" && field("X-MICROSOFT-CDO-BUSYSTATUS") === "BUSY",
);
const free = get("icsFile")({ ...ev, busy: false, notes: "" }).replace(/\r\n /g, "");
ok(
	"free leaves it open, and no notes means no DESCRIPTION",
	/TRANSP:TRANSPARENT/.test(free) &&
		/X-MICROSOFT-CDO-BUSYSTATUS:FREE/.test(free) &&
		!/DESCRIPTION/.test(free),
);
ok("each file has its own id", field("UID") === "abc123@allknowing");

// ---- Outlook on the web's new-event form
const url = new URL(get("outlookEventLink")({ ...ev, notes: `${"x".repeat(2000)}` }));
const q = url.searchParams;
ok(
	"opens Outlook on the web's new-event form",
	url.origin === "https://outlook.office.com" &&
		url.pathname === "/calendar/0/action/compose" &&
		q.get("rru") === "addevent" &&
		q.get("path") === "/calendar/action/compose" &&
		q.get("allday") === "false",
	url.href.slice(0, 200),
);
ok(
	"with the times in UTC and the title",
	q.get("startdt") === "2026-12-01T01:00:00.000Z" &&
		q.get("enddt") === "2026-12-01T01:30:00.000Z" &&
		q.get("subject") === title,
);
ok("long notes are cut to 1,500 characters", q.get("body").length === 1500);
ok("spaces travel as %20, not +", !url.search.includes("+"));

// ---- recognising a refusal, and shortening what Outlook said
const refusal = {
	code: "tool_error",
	message: JSON.stringify({
		code: "FORBIDDEN",
		message: `FORBIDDEN: Missing scope 'Calendars.ReadWrite': Microsoft Entra has not granted this connector the 'Calendars.ReadWrite' delegated permission for the signed-in account. caused by: FORBIDDEN: Graph API Error: Access is denied.\n\nDebug Context:\n{\n "tenantId": "x"\n}`,
		details: { graphErrorCode: "ErrorAccessDenied" },
	}),
};
const writeRefused = get("writeRefused");
ok("Outlook's 'Missing scope' is a refusal to write", writeRefused(refusal) === true);
ok(
	"other troubles are not",
	!writeRefused({ code: "upstream_error", message: "timed out" }) &&
		!writeRefused({ code: "needs_reauth" }) &&
		!writeRefused(null),
);
const said = get("outlookSaid")(refusal);
ok(
	"what Outlook said, without the JSON and the debugging details",
	said.startsWith("FORBIDDEN: Missing scope 'Calendars.ReadWrite'") &&
		!/caused by|Debug Context|\{|tenantId/.test(said),
	said,
);
ok(
	"…and never more than 320 characters",
	get("outlookSaid")({ message: "y".repeat(1000) }).length === 321,
);
ok(
	"plain words pass through",
	get("outlookSaid")({ message: "The mailbox is full." }) === "The mailbox is full.",
);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
