#!/bin/bash
# Sets up AllKnowing on this Mac (your always-on Mac mini). It keeps every meeting for all your devices,
# holds your Claude and Soniox keys, and serves the app to your desktop and phones. Run it in Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/Godraymond/AllKnowing/main/assistant/hub/install.sh | bash
#
# Safe to run again: it keeps your notes, keys and pairing code, and brings everything else up to date.
# To remove it (your notes stay in ~/AllKnowing):
#   curl -fsSL https://raw.githubusercontent.com/Godraymond/AllKnowing/main/assistant/hub/install.sh | bash -s uninstall
#
# What it sets up:
#   - ~/AllKnowing with the server (hub/hub.cjs), the app, your notes and a daily copy of them
#   - a LaunchAgent that starts it when you log in and keeps it running
#   - if Tailscale is on this Mac: Tailscale Serve, so your own devices get a secure https link (needed
#     for listening on a phone or another computer), at home and away
set -euo pipefail

SOURCE="${AK_HUB_SOURCE:-https://raw.githubusercontent.com/Godraymond/AllKnowing/gh-pages}"
DIR="${AK_HUB_HOME:-$HOME/AllKnowing}"
LABEL="com.godraymond.allknowing"
PLIST="${AK_HUB_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
PORT="${AK_HUB_PORT:-4790}"
UID_NUM="$(id -u)"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\n\033[33m%s\033[0m\n' "$*"; }
stop() {
	printf '\n\033[31m%s\033[0m\n\n' "$*" >&2
	exit 1
}

[ "$(uname -s)" = "Darwin" ] || [ -n "${AK_HUB_TEST:-}" ] || stop "This installer is for a Mac."
[ "$UID_NUM" -ne 0 ] || [ -n "${AK_HUB_TEST:-}" ] || stop "Run this without sudo."

first_executable() {
	local c
	for c in "$@"; do
		if [ -n "$c" ] && [ -x "$c" ]; then
			echo "$c"
			return 0
		fi
	done
	return 1
}
# This script usually arrives through a pipe, so questions go to the terminal itself when there is one.
TTY=/dev/null
if (: </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi
find_tailscale() {
	first_executable "$(command -v tailscale 2>/dev/null || true)" /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale
}
find_node() {
	local c nvm=""
	for c in "$HOME"/.nvm/versions/node/*/bin/node; do
		if [ -x "$c" ]; then nvm="$c"; fi
	done
	first_executable "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$nvm"
}

if [ "${1:-}" = "uninstall" ]; then
	bold "Removing AllKnowing from this Mac"
	launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
	rm -f "$PLIST"
	TS="$(find_tailscale || true)"
	if [ -n "$TS" ] && [ -f "$DIR/config.json" ]; then
		case "$(grep -o '"tsName": *"[^"]*"' "$DIR/config.json" || true)" in
			*:8443*) "$TS" serve --https=8443 off >/dev/null 2>&1 || true ;;
			*ts.net*) "$TS" serve --https=443 off >/dev/null 2>&1 || true ;;
		esac
	fi
	bold "Done. AllKnowing no longer runs here."
	note "Your notes, keys and daily copies are still in $DIR. Delete that folder yourself if you want them gone."
	exit 0
fi

bold "Setting up AllKnowing on this Mac"

# ---- Node.js runs the server ----
NODE="$(find_node || true)"
[ -n "$NODE" ] || stop "Node.js isn't installed. Install the LTS version from https://nodejs.org, then run this again."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || stop "Node.js $NODE_MAJOR is too old. Install the LTS version from https://nodejs.org, then run this again."
note "Node.js $("$NODE" -v) at $NODE"
# Reads one field from JSON on stdin (dotted path), or prints nothing.
json_get() {
	"$NODE" -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?undefined:v[k];if(v!==undefined&&v!==null)process.stdout.write(String(v))}catch{}})' "$1"
}

# ---- the server and the app, checked against the published hashes ----
mkdir -p "$DIR/hub" "$DIR/app" "$DIR/notes" "$DIR/backups" "$DIR/logs" "$(dirname "$PLIST")"
chmod 700 "$DIR"
bold "Downloading AllKnowing"
"$NODE" - "$SOURCE" "$DIR" <<'JS'
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const [source, dir] = process.argv.slice(2);
const get = async (name) => {
	const r = await fetch(`${source}/${name}${name === "version.json" ? `?t=${Date.now()}` : ""}`, { headers: { "cache-control": "no-cache" } });
	if (!r.ok) throw new Error(`${name}: ${r.status}`);
	return Buffer.from(await r.arrayBuffer());
};
(async () => {
	const versionBuf = await get("version.json");
	const v = JSON.parse(String(versionBuf));
	const staged = [];
	for (const [name, want] of Object.entries(v.files || {})) {
		if (name === "hub/install.sh") continue;
		const target = name === "hub/hub.cjs" || name === "hub/speech.cjs" ? path.join(dir, name) : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? path.join(dir, "app", name) : null;
		if (!target) continue;
		const buf = await get(name);
		if (crypto.createHash("sha256").update(buf).digest("hex") !== want) throw new Error(`${name} didn't match its published hash`);
		staged.push([target, buf]);
	}
	if (!staged.some(([t]) => t.endsWith("hub.cjs"))) throw new Error("the server wasn't in the download");
	for (const [target, buf] of staged) {
		fs.writeFileSync(`${target}.new`, buf);
		fs.renameSync(`${target}.new`, target);
	}
	fs.writeFileSync(path.join(dir, "app", "version.json"), versionBuf);
	console.log(`  AllKnowing ${v.version}`);
})().catch((e) => {
	console.error(`  Download failed: ${e.message}`);
	process.exit(1);
});
JS
"$NODE" --check "$DIR/hub/hub.cjs" || stop "The downloaded server didn't pass its check. Try again in a few minutes."
[ ! -f "$DIR/hub/speech.cjs" ] || "$NODE" --check "$DIR/hub/speech.cjs" || stop "The downloaded server didn't pass its check. Try again in a few minutes."

# ---- settings: a pairing code the first time; your keys and notes are kept ----
"$NODE" - "$DIR/config.json" "$PORT" <<'JS'
const fs = require("fs");
const crypto = require("crypto");
const [file, port] = process.argv.slice(2);
let c = {};
try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (!c.code) {
	const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const b = crypto.randomBytes(12);
	let s = "";
	for (let i = 0; i < 12; i++) s += a[b[i] % 32] + (i % 4 === 3 && i < 11 ? "-" : "");
	c.code = s;
}
c.port = Number(c.port) || Number(port);
if (!c.host) c.host = "0.0.0.0";
fs.writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
JS
CODE="$(json_get code <"$DIR/config.json")"
PORT="$(json_get port <"$DIR/config.json")"
set_config() { # key value
	"$NODE" -e 'const fs=require("fs");const [f,k,v]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(f,"utf8"));c[k]=v;fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n",{mode:0o600})' "$DIR/config.json" "$1" "$2"
}

# ---- Tailscale: a secure link for your own devices, which listening needs ----
TS="$(find_tailscale || true)"
TS_URL=""
if [ -z "$TS" ]; then
	warn "Tailscale isn't on this Mac, so only this Mac can listen for now."
	note "Phones and other computers can still open AllKnowing on your home Wi-Fi to read, prepare and import."
	note "To listen on them too: install Tailscale here (Mac App Store or https://tailscale.com/download) and on"
	note "each phone and computer, signed in to the same account, then run this installer again."
else
	TS_STATUS="$("$TS" status --json 2>/dev/null || true)"
	HOST="$(printf '%s' "$TS_STATUS" | json_get Self.DNSName)"
	HOST="${HOST%.}"
	if [ "$(printf '%s' "$TS_STATUS" | json_get BackendState)" != "Running" ]; then
		warn "Tailscale is on this Mac but not connected. Open Tailscale, sign in and connect, then run this again."
	elif [ -z "$HOST" ]; then
		warn "This Mac has no Tailscale name yet. At https://login.tailscale.com/admin/dns turn on MagicDNS and HTTPS Certificates, then run this again."
	else
		# Port 443 gives the plainest link. If something else of yours already uses it, 8443 instead.
		HTTPS_PORT=443
		SERVING="$("$TS" serve status --json 2>/dev/null || true)"
		if printf '%s' "$SERVING" | grep -q "\"$HOST:443\"" && ! printf '%s' "$SERVING" | grep -q "127.0.0.1:$PORT"; then HTTPS_PORT=8443; fi
		bold "Sharing it with your own devices through Tailscale (https, port $HTTPS_PORT)"
		note "If Tailscale prints a link to switch on HTTPS or Serve, open it, switch it on, and come back here."
		if "$TS" serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT" <"$TTY"; then
			TS_URL="https://$HOST"
			if [ "$HTTPS_PORT" != 443 ]; then TS_URL="https://$HOST:$HTTPS_PORT"; fi
		else
			warn "Tailscale Serve didn't start. Check HTTPS Certificates are on at https://login.tailscale.com/admin/dns, then run this again."
		fi
	fi
fi
if [ -n "$TS_URL" ]; then set_config tsName "${TS_URL#https://}"; fi
# The name other devices at home use for this Mac (yourname-mac-mini.local).
LAN_NAME="$(scutil --get LocalHostName 2>/dev/null || hostname)"
LAN_NAME="$(printf '%s' "$LAN_NAME" | tr '[:upper:]' '[:lower:]')"
LAN_NAME="${LAN_NAME%.local}"
set_config lanName "$LAN_NAME"

# ---- a LaunchAgent keeps it running ----
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE</string>
		<string>$DIR/hub/hub.cjs</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$DIR</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>AK_HUB_HOME</key>
		<string>$DIR</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>StandardOutPath</key>
	<string>$DIR/logs/hub.log</string>
	<key>StandardErrorPath</key>
	<string>$DIR/logs/hub.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null || stop "The LaunchAgent file didn't come out right: $PLIST"
launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
sleep 1 # let an older copy let go of its port
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
up=0
for _ in $(seq 1 40); do
	if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/hello" >/dev/null 2>&1; then
		up=1
		break
	fi
	sleep 0.5
done
[ "$up" = 1 ] || stop "AllKnowing didn't start. Its log is at: $DIR/logs/hub.log"
note "Running, and it starts by itself when you log in."

if [ -n "$TS_URL" ] && ! curl -fsS -m 40 "$TS_URL/api/hello" >/dev/null 2>&1; then
	warn "Couldn't reach it through Tailscale from this Mac yet. The first certificate can take a minute."
fi

bold "Done."
printf '\n  Pairing code:  \033[1m%s\033[0m   (each phone or computer asks for it once)\n' "$CODE"
note ""
note "On this Mac:               http://localhost:$PORT   (add your Claude and Soniox keys here, once)"
note "Recordings:                it is now fetching its free speech models (about 1.8 GB, once). The Mac mini box on Home shows how far."
note "At home, other devices:    http://$LAN_NAME.local:$PORT   (reading, preparing, importing)"
if [ -n "$TS_URL" ]; then
	note "Anywhere, with listening:  $TS_URL   (needs Tailscale on that device)"
	printf '%s' "$TS_URL/#pair=$CODE" | pbcopy 2>/dev/null || true
	note ""
	note "A pairing link is on the clipboard: open it on a phone (AirDrop or message it to yourself) and it's connected."
fi
note ""
note "If macOS asks whether node may accept incoming connections, say Allow, so your devices at home can reach it."
note "Moving your notes over: in the old app, Settings → Download all notes; then here, Settings → Bring in notes."
note "Update later: run this same line again. Remove: the same line ending  | bash -s uninstall"
echo
if [ -z "${AK_HUB_TEST:-}" ]; then open "http://localhost:$PORT/" >/dev/null 2>&1 || true; fi
