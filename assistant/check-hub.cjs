// Checks the Mac mini's server (hub/hub.cjs) against local stand-ins for Claude, Soniox and GitHub:
// the app it serves, the pairing code, the notes and their live changes, keys that never leave it,
// Claude through it, one-use speech keys, the daily copy, and updates.
//
//   node assistant/check-hub.cjs
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const HUB = path.join(__dirname, "hub", "hub.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ak-hub-"));
const home = path.join(tmp, "home");
const source = path.join(tmp, "source");
let failed = 0;
const ok = (name, cond, detail = "") => {
	console.log(
		`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail ? ` — ${String(detail).slice(0, 300)}` : ""}`,
	);
	if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (handler) =>
	new Promise((resolve) => {
		const s = http.createServer(handler);
		s.listen(0, "127.0.0.1", () => resolve(s));
	});
const readAll = (req) =>
	new Promise((resolve) => {
		let b = "";
		req.on("data", (c) => {
			b += c;
		});
		req.on("end", () => resolve(b));
	});

(async () => {
	// ---------- the published files, as the gh-pages branch has them ----------
	execFileSync(process.execPath, [path.join(__dirname, "build-web.cjs"), "check-1"], {
		stdio: "ignore",
	});
	fs.cpSync(path.join(__dirname, "dist"), source, { recursive: true });

	// ---------- stand-ins ----------
	const claudeCalls = [];
	const claude = await listen(async (req, res) => {
		const body = await readAll(req);
		claudeCalls.push({ headers: req.headers, body });
		if (req.headers["x-api-key"] !== "sk-ant-good") {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					type: "error",
					error: { type: "authentication_error", message: "invalid x-api-key" },
				}),
			);
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const t of ["Hel", "lo"]) {
			res.write(
				`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })}\n\n`,
			);
			await sleep(30);
		}
		res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
	});
	const sonioxCalls = [];
	const soniox = await listen(async (req, res) => {
		const body = JSON.parse((await readAll(req)) || "{}");
		sonioxCalls.push({ url: req.url, headers: req.headers, body });
		res.setHeader("content-type", "application/json");
		if (req.headers.authorization !== "Bearer sx-good") {
			res.writeHead(401);
			res.end(JSON.stringify({ message: "Invalid API key." }));
			return;
		}
		res.writeHead(201);
		res.end(
			JSON.stringify({
				api_key: `temp:${sonioxCalls.length}`,
				expires_at: "2030-01-01T00:00:00Z",
			}),
		);
	});
	const github = await listen((req, res) => {
		const name = decodeURIComponent(req.url.split("?")[0].slice(1));
		const file = path.join(source, name);
		if (!file.startsWith(source) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200);
		res.end(fs.readFileSync(file));
	});
	const port = 40000 + Math.floor(Math.random() * 20000);
	const base = `http://127.0.0.1:${port}`;
	let proc = null;
	let exited = null;
	const startHub = async () => {
		exited = null;
		proc = spawn(process.execPath, [HUB], {
			env: {
				...process.env,
				AK_HUB_HOME: home,
				AK_HUB_PORT: String(port),
				AK_HUB_BIND: "127.0.0.1",
				AK_HUB_ANTHROPIC: `http://127.0.0.1:${claude.address().port}`,
				AK_HUB_SONIOX: `http://127.0.0.1:${soniox.address().port}`,
				AK_HUB_SOURCE: `http://127.0.0.1:${github.address().port}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout.on("data", () => null);
		proc.stderr.on("data", (d) => process.stderr.write(d));
		proc.on("exit", (code) => {
			exited = code;
		});
		for (let i = 0; i < 60; i++) {
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
			for (let i = 0; i < 40 && exited === null; i++) await sleep(50);
		}
	};
	// Requests as another device would send them: through Tailscale (from this Mac, with its headers) or at home.
	const REMOTE = { host: "yans-mac-mini.local", "x-forwarded-for": "100.101.102.103" };
	let code = "";
	const asDevice = (extra = {}) => ({ ...REMOTE, "x-api-key": code, ...extra });
	// Node's fetch won't set Host, so these go through http.request.
	const req = (method, urlPath, { headers = {}, body } = {}) =>
		new Promise((resolve, reject) => {
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
					resolve({ status: res.statusCode, headers: res.headers, text: b, json });
				});
			});
			r.on("error", reject);
			if (body !== undefined) r.end(typeof body === "string" ? body : JSON.stringify(body));
			else r.end();
		});

	try {
		await startHub();

		// ---------- 1. the app ----------
		let page = await req("GET", "/");
		for (let i = 0; i < 40 && page.status !== 200; i++) {
			await sleep(150);
			page = await req("GET", "/");
		}
		ok(
			"fetches the app from GitHub by itself and serves it",
			page.status === 200 && page.text.includes("AllKnowing"),
			page.status,
		);
		ok(
			"marks the page as served by the Mac mini",
			page.text.includes('<meta name="allknowing-hub" content="1">'),
		);
		ok("page isn't cached", /no-cache/.test(page.headers["cache-control"] || ""));
		ok(
			"frames and sniffing are refused",
			page.headers["x-frame-options"] === "DENY" &&
				page.headers["x-content-type-options"] === "nosniff",
		);
		ok(
			"serves the runtime with the version stamped",
			(await req("GET", "/standalone.js?v=check-1")).text.includes('"check-1"'),
		);
		ok("knows its app version", (await req("GET", "/api/hello")).json.app === "check-1");
		for (const bad of [
			"/config.json",
			"/../config.json",
			"/%2e%2e/config.json",
			"/hub/hub.cjs",
			"/notes/x.json",
			"/.nojekyll",
			"/%zz",
		])
			ok(`won't serve ${bad}`, (await req("GET", bad)).status === 404);

		// ---------- 2. who may ask ----------
		const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
		code = cfg.code;
		ok("made a pairing code", /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);
		ok(
			"config.json is private",
			(fs.statSync(path.join(home, "config.json")).mode & 0o077) === 0,
		);
		ok(
			"this Mac's own browser gets the code",
			(await req("GET", "/api/pair/local", { headers: { host: `localhost:${port}` } })).json
				.code === code,
		);
		ok(
			"another device doesn't",
			(
				await req("GET", "/api/pair/local", {
					headers: { host: `yans-mac-mini.local:${port}` },
				})
			).status === 403,
		);
		ok(
			"nor does Tailscale, though it comes from this Mac",
			(
				await req("GET", "/api/pair/local", {
					headers: { host: `localhost:${port}`, "x-forwarded-for": "100.1.2.3" },
				})
			).status === 403,
		);
		ok(
			"nor a rebinding page with another name",
			(await req("GET", "/api/pair/local", { headers: { host: `evil.example:${port}` } }))
				.status === 403,
		);
		ok(
			"a device without the code is turned away",
			(await req("GET", "/api/status", { headers: REMOTE })).status === 401,
		);
		ok(
			"…with a message the page can show",
			/isn't connected to the Mac mini/.test(
				(await req("GET", "/api/status", { headers: REMOTE })).json.error.message,
			),
		);
		ok(
			"with the code it's in",
			(await req("GET", "/api/status", { headers: asDevice() })).status === 200,
		);
		ok(
			"the code can be typed in lower case or without dashes",
			(
				await req("GET", "/api/status", {
					headers: asDevice({ "x-api-key": code.toLowerCase().replace(/-/g, "") }),
				})
			).status === 200,
		);
		ok(
			"this Mac itself needs no code",
			(await req("GET", "/api/status", { headers: { host: `localhost:${port}` } })).status ===
				200,
		);
		let r429 = null;
		for (let i = 0; i < 13; i++)
			r429 = await req("GET", "/api/status", {
				headers: {
					...REMOTE,
					"x-forwarded-for": "100.9.9.9",
					"x-api-key": "WRONG-CODE-0000",
				},
			});
		ok("too many wrong codes: locked out for a while", r429.status === 429);
		ok(
			"…only that device",
			(await req("GET", "/api/status", { headers: asDevice() })).status === 200,
		);

		// ---------- 3. keys stay on the Mac ----------
		let st = (await req("GET", "/api/status", { headers: asDevice() })).json;
		ok(
			"status before keys",
			st.claude === false &&
				st.speech === false &&
				st.code === code &&
				st.links.mac === `http://localhost:${port}`,
		);
		ok(
			"Claude without a key says what to do",
			/Add your Claude API key/.test(
				(
					await req("POST", "/v1/messages", {
						headers: asDevice({ "content-type": "application/json" }),
						body: { model: "m", max_tokens: 5, messages: [] },
					})
				).json.error.message,
			),
		);
		ok(
			"listening without a key says what to do",
			/Add your Soniox speech key/.test(
				(await req("POST", "/api/speech-key", { headers: asDevice() })).json.error.message,
			),
		);
		ok(
			"a key with spaces in it is refused",
			(
				await req("PUT", "/api/keys", {
					headers: asDevice({ "content-type": "application/json" }),
					body: { claudeKey: "sk ant" },
				})
			).status === 400,
		);
		const put = await req("PUT", "/api/keys", {
			headers: asDevice({ "content-type": "application/json" }),
			body: { claudeKey: " sk-ant-good ", speechKey: "sx-good" },
		});
		ok("keys saved", put.status === 200 && put.json.claude && put.json.speech);
		st = (await req("GET", "/api/status", { headers: asDevice() })).json;
		ok(
			"status says they're there, without showing them",
			st.claude &&
				st.speech &&
				!JSON.stringify(st).includes("sk-ant-good") &&
				!JSON.stringify(st).includes("sx-good"),
		);
		ok(
			"kept in the private config.json",
			JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).claudeKey ===
				"sk-ant-good",
		);

		// ---------- 4. Claude through the Mac mini ----------
		const msg = await req("POST", "/v1/messages", {
			headers: asDevice({
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true",
			}),
			body: {
				model: "claude-haiku-5-5",
				max_tokens: 50,
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			},
		});
		const told = msg.text
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => JSON.parse(l.slice(5)))
			.filter((e) => e.type === "content_block_delta")
			.map((e) => e.delta.text)
			.join("");
		ok(
			"streams Claude's answer back",
			msg.status === 200 &&
				/event-stream/.test(msg.headers["content-type"]) &&
				told === "Hello",
			msg.text,
		);
		const call = claudeCalls[claudeCalls.length - 1];
		ok(
			"asks Claude with the key it keeps, not the pairing code",
			call.headers["x-api-key"] === "sk-ant-good" &&
				!JSON.stringify(call.headers).includes(code),
		);
		ok(
			"passes the API version on, and nothing a browser added",
			call.headers["anthropic-version"] === "2023-06-01" &&
				!call.headers["anthropic-dangerous-direct-browser-access"],
		);
		ok("sends the request as it came", JSON.parse(call.body).model === "claude-haiku-5-5");
		await req("PUT", "/api/keys", {
			headers: asDevice({ "content-type": "application/json" }),
			body: { claudeKey: "sk-ant-bad" },
		});
		const refused = await req("POST", "/v1/messages", {
			headers: asDevice({ "content-type": "application/json" }),
			body: { model: "m", max_tokens: 5, messages: [] },
		});
		ok(
			"Claude's own errors come back as they are",
			refused.status === 401 &&
				refused.json.error.type === "authentication_error" &&
				!refused.json.error.relay,
		);
		await req("PUT", "/api/keys", {
			headers: asDevice({ "content-type": "application/json" }),
			body: { claudeKey: "sk-ant-good" },
		});
		ok(
			"a device without the code can't use Claude",
			(await req("POST", "/v1/messages", { headers: REMOTE, body: "{}" })).status === 401,
		);

		// ---------- 5. one-use speech keys ----------
		const sk = await req("POST", "/api/speech-key", { headers: asDevice() });
		ok("hands out a one-use key", sk.status === 200 && sk.json.api_key === "temp:1", sk.text);
		const sc = sonioxCalls[0];
		ok(
			"made with the real key, for the WebSocket, once, for a minute",
			sc.url === "/v1/auth/temporary-api-key" &&
				sc.headers.authorization === "Bearer sx-good" &&
				sc.body.usage_type === "transcribe_websocket" &&
				sc.body.single_use === true &&
				sc.body.expires_in_seconds === 60,
		);
		ok("the real key isn't in what the device gets", !sk.text.includes("sx-good"));
		await req("PUT", "/api/keys", {
			headers: asDevice({ "content-type": "application/json" }),
			body: { speechKey: "sx-bad" },
		});
		ok(
			"a key Soniox refuses: says to check it",
			/refused the speech key/.test(
				(await req("POST", "/api/speech-key", { headers: asDevice() })).json.error.message,
			),
		);
		await req("PUT", "/api/keys", {
			headers: asDevice({ "content-type": "application/json" }),
			body: { speechKey: "sx-good" },
		});

		// ---------- 6. the notes, shared, with live changes ----------
		const events = [];
		const watch = http.request(`${base}/api/db/watch`, { headers: asDevice() }, (res) => {
			res.setEncoding("utf8");
			res.on("data", (c) => {
				for (const line of c.split("\n"))
					if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5)));
			});
		});
		watch.end();
		await sleep(200);
		ok(
			"a watching page is greeted with the app version",
			events.some((e) => e.hello && e.app === "check-1"),
		);
		const B = "data/users/owner/home";
		const doc = (p) => `/api/db/doc?p=${encodeURIComponent(p)}`;
		const J = { "content-type": "application/json" };
		const putDoc = (p, data) => req("PUT", doc(p), { headers: asDevice(J), body: { data } });
		ok(
			"stores a document",
			(await putDoc(`${B}/meetings/m1`, { id: "m1", title: "Pricing call", updatedAt: 2 }))
				.status === 200,
		);
		await putDoc(`${B}/index/m1`, {
			id: "m1",
			mode: "meeting",
			title: "Pricing call",
			updatedAt: 2,
		});
		await putDoc(`${B}/index/m2`, { id: "m2", mode: "meeting", title: "Board", updatedAt: 5 });
		await putDoc(`${B}/index/m3`, {
			id: "m3",
			mode: "werewolf",
			title: "old game",
			updatedAt: 9,
		});
		await putDoc(`${B}/meetings/m1/parts/p001`, { segs: [{ id: "c", text: "three" }] });
		await putDoc(`${B}/meetings/m1/parts/p000`, {
			segs: [
				{ id: "a", text: "one" },
				{ id: "b", text: "two" },
			],
		});
		await putDoc(`${B}/todos/t1`, { id: "t1", task: "Send the deck", updatedAt: 3 });
		await putDoc(B, { settings: { myName: "Raymond" }, updatedAt: 1 });
		const got = (await req("GET", doc(`${B}/meetings/m1`), { headers: asDevice() })).json;
		ok("reads it back", got.exists && got.data.title === "Pricing call");
		ok(
			"a missing one says so",
			(await req("GET", doc(`${B}/meetings/nope`), { headers: asDevice() })).json.exists ===
				false,
		);
		const col = (q) => req("GET", `/api/db/col?${q}`, { headers: asDevice() });
		const idx = (
			await col(`p=${encodeURIComponent(`${B}/index`)}&order=updatedAt&dir=desc&limit=2`)
		).json.docs;
		ok(
			"lists a collection newest first, with a limit",
			idx.length === 2 && idx[0].id === "m3" && idx[1].id === "m2",
		);
		const parts = (await col(`p=${encodeURIComponent(`${B}/meetings/m1/parts`)}`)).json.docs;
		ok("parts come in order", parts.map((d) => d.id).join() === "p000,p001");
		ok(
			"only direct children are listed",
			(await col(`p=${encodeURIComponent(`${B}/meetings`)}`)).json.docs
				.map((d) => d.id)
				.join() === "m1",
		);
		await sleep(150);
		ok(
			"watching pages hear about each change",
			events.some((e) => e.p === `${B}/index/m2`) &&
				events.some((e) => e.p === `${B}/meetings/m1/parts/p000`),
		);
		for (const bad of [
			"data/users/owner",
			"data/../x",
			"data/users/owner/home/x",
			"a/b%2Fc/d",
			"",
			"a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r",
		])
			ok(
				`refuses the path “${bad}”`,
				(await req("GET", doc(bad), { headers: asDevice() })).status === 400,
			);
		ok(
			"a document must be an object",
			(
				await req("PUT", doc(`${B}/todos/t2`), {
					headers: asDevice(J),
					body: { data: [1, 2] },
				})
			).status === 400,
		);
		ok(
			"deletes",
			(await req("DELETE", doc(`${B}/index/m2`), { headers: asDevice() })).status === 200 &&
				!(await req("GET", doc(`${B}/index/m2`), { headers: asDevice() })).json.exists,
		);
		ok(
			"files on disk mirror the paths",
			fs.existsSync(
				path.join(
					home,
					"notes",
					"data",
					"users",
					"owner",
					"home",
					"meetings",
					"m1",
					"parts",
					"p000.json",
				),
			),
		);
		ok(
			"a device without the code can't read notes",
			(await req("GET", doc(`${B}/meetings/m1`), { headers: REMOTE })).status === 401,
		);
		st = (await req("GET", "/api/status", { headers: asDevice() })).json;
		ok("status counts meetings, not old games", st.meetings === 1, st.meetings);
		watch.destroy();

		// ---------- 7. the daily copy ----------
		const b = await req("POST", "/api/backup", { headers: asDevice() });
		const file = path.join(home, "backups", b.json.name || "none");
		ok("saves a copy of every note", fs.existsSync(file));
		const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
		ok(
			"…in the format the page brings in",
			bundle.kind === "allknowing-notes" && bundle.from === "Saved on your Mac mini",
		);
		ok(
			"…with each meeting's transcript put back together",
			bundle.meetings.length === 1 &&
				bundle.meetings[0].segs.map((x) => x.text).join() === "one,two,three",
		);
		ok(
			"…and the follow-ups and settings",
			bundle.todos[0].task === "Send the deck" && bundle.settings.myName === "Raymond",
		);
		ok("the copy is private too", (fs.statSync(file).mode & 0o077) === 0);

		// ---------- 8. it all survives a restart ----------
		await stopHub();
		ok("stops cleanly", exited === 0, exited);
		await startHub();
		ok(
			"notes are still there after a restart",
			(await req("GET", doc(`${B}/meetings/m1/parts/p001`), { headers: asDevice() })).json
				.data.segs[0].text === "three",
		);
		ok(
			"so are the keys and the code",
			(await req("GET", "/api/status", { headers: asDevice() })).json.claude === true,
		);

		// ---------- 9. updates ----------
		ok(
			"nothing to update yet",
			/up to date/i.test(
				(await req("POST", "/api/update", { headers: asDevice() })).json.message,
			),
		);
		// A new page on GitHub.
		execFileSync(process.execPath, [path.join(__dirname, "build-web.cjs"), "check-2"], {
			stdio: "ignore",
		});
		fs.rmSync(source, { recursive: true, force: true });
		fs.cpSync(path.join(__dirname, "dist"), source, { recursive: true });
		const check = (await req("GET", "/api/update", { headers: asDevice() })).json;
		ok("sees the new version", check.latest === "check-2" && check.status.page === true);
		const up = await req("POST", "/api/update", { headers: asDevice() });
		ok(
			"puts in the new page",
			up.status === 200 && /Updated/.test(up.json.message) && !up.json.restart,
			up.text,
		);
		ok(
			"now serves it",
			(await req("GET", "/standalone.js")).text.includes('"check-2"') &&
				(await req("GET", "/api/hello")).json.app === "check-2",
		);
		// A download that doesn't match its hash changes nothing.
		const v = JSON.parse(fs.readFileSync(path.join(source, "version.json"), "utf8"));
		v.version = "check-3";
		v.files["standalone.js"] = "0".repeat(64);
		fs.writeFileSync(path.join(source, "version.json"), JSON.stringify(v));
		const badUp = await req("POST", "/api/update", { headers: asDevice() });
		ok(
			"a damaged download is refused",
			badUp.status === 502 && /didn't match/.test(badUp.json.message),
		);
		ok(
			"…and the page stays as it was",
			(await req("GET", "/api/hello")).json.app === "check-2",
		);
		// A new server: swapped in, checked, and the hub restarts (its LaunchAgent would start it again).
		execFileSync(process.execPath, [path.join(__dirname, "build-web.cjs"), "check-4"], {
			stdio: "ignore",
		});
		fs.rmSync(source, { recursive: true, force: true });
		fs.cpSync(path.join(__dirname, "dist"), source, { recursive: true });
		const hubSrc = `${fs.readFileSync(HUB, "utf8")}\n// a newer server\n`;
		fs.writeFileSync(path.join(source, "hub", "hub.cjs"), hubSrc);
		const v4 = JSON.parse(fs.readFileSync(path.join(source, "version.json"), "utf8"));
		v4.files["hub/hub.cjs"] = require("node:crypto")
			.createHash("sha256")
			.update(hubSrc)
			.digest("hex");
		fs.writeFileSync(path.join(source, "version.json"), JSON.stringify(v4));
		// Updating the server replaces the file it runs from, so this runs a copy of it.
		await stopHub();
		fs.mkdirSync(path.join(home, "hub"), { recursive: true });
		fs.copyFileSync(HUB, path.join(home, "hub", "hub.cjs"));
		const realHub = HUB;
		proc = null;
		exited = null;
		proc = spawn(process.execPath, [path.join(home, "hub", "hub.cjs")], {
			env: {
				...process.env,
				AK_HUB_HOME: home,
				AK_HUB_PORT: String(port),
				AK_HUB_BIND: "127.0.0.1",
				AK_HUB_SOURCE: `http://127.0.0.1:${github.address().port}`,
			},
			stdio: "ignore",
		});
		proc.on("exit", (c) => {
			exited = c;
		});
		for (let i = 0; i < 60; i++) {
			try {
				if ((await fetch(`${base}/api/hello`)).ok) break;
			} catch {
				/* starting */
			}
			await sleep(100);
		}
		ok(
			"the page knows the server has news",
			(await req("GET", "/api/update", { headers: asDevice() })).json.status.hub === true,
		);
		const upHub = await req("POST", "/api/update", { headers: asDevice() });
		ok(
			"updates the server and says it restarts",
			upHub.status === 200 && upHub.json.restart === true,
			upHub.text,
		);
		for (let i = 0; i < 40 && exited === null; i++) await sleep(100);
		ok("…then exits for its LaunchAgent to start it again", exited === 0, exited);
		ok(
			"the new server is in place, the old one kept",
			fs
				.readFileSync(path.join(home, "hub", "hub.cjs"), "utf8")
				.endsWith("// a newer server\n") &&
				fs.existsSync(path.join(home, "hub", "hub.cjs.previous")),
		);
		ok(
			"the real hub file was never touched",
			!fs.readFileSync(realHub, "utf8").includes("a newer server"),
		);
		ok(
			"notes untouched by updates",
			fs.existsSync(
				path.join(home, "notes", "data", "users", "owner", "home", "meetings", "m1.json"),
			),
		);
	} catch (e) {
		ok("ran to the end", false, e.stack || e.message);
	} finally {
		await stopHub();
		claude.close();
		soniox.close();
		github.close();
		fs.rmSync(tmp, { recursive: true, force: true });
		// Leave dist as the build normally writes it.
		execFileSync(process.execPath, [path.join(__dirname, "build-web.cjs")], {
			stdio: "ignore",
		});
	}
	console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
	process.exit(failed ? 1 : 0);
})();
