// Builds AllKnowing as a web app: the version that runs outside claude.ai, in any browser,
// and installs on an iPhone from Safari (Share → Add to Home Screen).
//
//   node assistant/build-web.cjs [version]     writes assistant/dist/
//
// It is the same page as the artifact (assistant/index.html) with three things added in <head>:
// the app manifest and icons, the iOS "installed app" tags, and web/standalone.js, which gives the
// page Claude and a microphone on the user's own keys. index.html itself stays exactly what the
// artifact runs, so nothing here can affect the artifact.
//
// The same files are what the Mac mini serves (hub/hub.cjs). dist/hub/ holds the hub and its installer,
// and dist/version.json lists every file with its SHA-256, which the installer and the hub's updates check.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// What this page expects of the Mac mini's server (HUB_API in hub/hub.cjs). Raise both together when the
// page starts using something new there, so an older hub waits for its own update instead.
// 2: recordings turned into text (/api/transcribe).
const HUB_API = 2;

const src = __dirname;
const web = path.join(src, "web");
const out = path.join(src, "dist");
const version = (process.argv[2] || new Date().toISOString().slice(0, 10)).replace(/[^\w.-]/g, "");

const HEAD = `<meta name="theme-color" content="#f3f4f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1014" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="AllKnowing">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="format-detection" content="telephone=no">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">
<script src="standalone.js?v=${version}"></script>`;

let html = fs.readFileSync(path.join(src, "index.html"), "utf8");
const anchor = "<title>AllKnowing</title>";
if (html.split(anchor).length !== 2)
	throw new Error(`Expected exactly one ${anchor} in index.html`);
html = html.replace(anchor, `${anchor}\n${HEAD}`);

const runtime = fs.readFileSync(path.join(web, "standalone.js"), "utf8");
if (!runtime.includes("__AK_VERSION__"))
	throw new Error("standalone.js has no version placeholder");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), html);
fs.writeFileSync(path.join(out, "standalone.js"), runtime.replace("__AK_VERSION__", version));
for (const name of [
	"manifest.webmanifest",
	"icon-180.png",
	"icon-192.png",
	"icon-512.png",
	"icon-maskable-512.png",
]) {
	fs.copyFileSync(path.join(web, name), path.join(out, name));
}
// The Mac mini's server and its installer, fetched from here by the installer and by the hub's updates.
fs.mkdirSync(path.join(out, "hub"), { recursive: true });
for (const name of ["hub.cjs", "install.sh"])
	fs.copyFileSync(path.join(src, "hub", name), path.join(out, "hub", name));
// GitHub Pages: serve the files as they are.
fs.writeFileSync(path.join(out, ".nojekyll"), "");
const files = {};
const walk = (dir, rel) => {
	for (const e of fs
		.readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) walk(path.join(dir, e.name), r);
		else if (!e.name.startsWith("."))
			files[r] = crypto
				.createHash("sha256")
				.update(fs.readFileSync(path.join(dir, e.name)))
				.digest("hex");
	}
};
walk(out, "");
fs.writeFileSync(
	path.join(out, "version.json"),
	`${JSON.stringify({ version, built: new Date().toISOString(), hubApi: HUB_API, files }, null, 2)}\n`,
);
console.log(`Built the web app (${version}) in ${path.relative(process.cwd(), out) || "."}`);
