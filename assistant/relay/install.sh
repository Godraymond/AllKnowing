#!/bin/bash
# Installs the AllKnowing relay on this Mac, so the AllKnowing web app on your phone can use Claude through
# Claude Code here, on your Claude plan, with no API key. Run it in Terminal on the Mac:
#
#   curl -fsSL https://raw.githubusercontent.com/Godraymond/AllKnowing/main/assistant/relay/install.sh | bash
#
# Safe to run again: it keeps your pairing code and updates the relay.
# To remove it:  curl -fsSL https://raw.githubusercontent.com/Godraymond/AllKnowing/main/assistant/relay/install.sh | bash -s uninstall
#
# What it sets up:
#   - relay.cjs in ~/Library/Application Support/AllKnowing Relay, with a random pairing code
#   - a LaunchAgent that starts it when you log in and keeps it running (it keeps the Mac awake while it runs)
#   - Tailscale Serve on HTTPS port 8443, so only devices signed in to your Tailscale can reach it
set -euo pipefail

SOURCE="${AK_RELAY_SOURCE:-https://raw.githubusercontent.com/Godraymond/AllKnowing/main/assistant/relay}"
DIR="${AK_RELAY_HOME:-$HOME/Library/Application Support/AllKnowing Relay}"
LABEL="com.godraymond.allknowing-relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT=47823
HTTPS_PORT=8443
UID_NUM="$(id -u)"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\n\033[33m%s\033[0m\n' "$*"; }
stop() {
	printf '\n\033[31m%s\033[0m\n\n' "$*" >&2
	exit 1
}

[ "$(uname -s)" = "Darwin" ] || stop "This installer is for a Mac."
[ "$UID_NUM" -ne 0 ] || stop "Run this without sudo."

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
find_claude() {
	first_executable "$(command -v claude 2>/dev/null || true)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude
}

if [ "${1:-}" = "uninstall" ]; then
	bold "Removing the AllKnowing relay"
	launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
	rm -f "$PLIST"
	TS="$(find_tailscale || true)"
	if [ -n "$TS" ]; then "$TS" serve --https="$HTTPS_PORT" off >/dev/null 2>&1 || true; fi
	rm -rf "$DIR"
	bold "Done. The relay is gone, and Tailscale no longer serves port $HTTPS_PORT."
	exit 0
fi

bold "Setting up Claude for AllKnowing on this Mac"

# ---- Node.js runs the relay ----
NODE="$(find_node || true)"
[ -n "$NODE" ] || stop "Node.js isn't installed. Install the LTS version from https://nodejs.org, then run this again."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || stop "Node.js $NODE_MAJOR is too old. Install the LTS version from https://nodejs.org, then run this again."
note "Node.js $("$NODE" -v) at $NODE"
# Reads one field from JSON on stdin (dotted path), or prints nothing.
json_get() {
	"$NODE" -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?undefined:v[k];if(v!==undefined&&v!==null)process.stdout.write(String(v))}catch{}})' "$1"
}

# ---- Claude Code, signed in with your Claude plan ----
CLAUDE="$(find_claude || true)"
if [ -z "$CLAUDE" ]; then
	bold "Installing Claude Code with Anthropic's own installer"
	curl -fsSL https://claude.ai/install.sh | bash
	CLAUDE="$(find_claude || true)"
	[ -n "$CLAUDE" ] || stop "Claude Code didn't install. Run: curl -fsSL https://claude.ai/install.sh | bash   then run this again."
fi
note "Claude Code $("$CLAUDE" --version 2>/dev/null | head -1) at $CLAUDE"
signed_in() { [ "$("$CLAUDE" auth status --json 2>/dev/null | json_get loggedIn)" = "true" ]; }
if ! signed_in; then
	bold "Sign in to Claude Code with your Claude account (the one with your plan)"
	note "A browser window opens. Approve it there, then come back to this window."
	"$CLAUDE" auth login --claudeai <"$TTY" || true
	signed_in || stop "Claude Code isn't signed in yet. Run: claude auth login   then run this installer again."
fi
AUTH_METHOD="$("$CLAUDE" auth status --json 2>/dev/null | json_get authMethod)"
note "Signed in (${AUTH_METHOD:-signed in})"
case "$AUTH_METHOD" in
	*[Aa][Pp][Ii]* | *[Cc]onsole*)
		warn "Claude Code here is signed in with an API account, so this would be billed to the API, not your plan."
		note "To use your plan instead, run: claude auth logout   then: claude auth login --claudeai   and run this again."
		;;
esac

# ---- Tailscale makes the relay reachable from your own devices ----
TS="$(find_tailscale || true)"
[ -n "$TS" ] || stop "Tailscale isn't installed. Install it from the Mac App Store or https://tailscale.com/download, sign in, then run this again. Put Tailscale on your iPhone too, signed in to the same account."
TS_STATUS="$("$TS" status --json 2>/dev/null || true)"
[ "$(printf '%s' "$TS_STATUS" | json_get BackendState)" = "Running" ] || stop "Tailscale isn't connected on this Mac. Open Tailscale, sign in and connect, then run this again."
HOST="$(printf '%s' "$TS_STATUS" | json_get Self.DNSName)"
HOST="${HOST%.}"
[ -n "$HOST" ] || stop "This Mac has no Tailscale name yet. In the Tailscale admin console (https://login.tailscale.com/admin/dns), turn on MagicDNS and HTTPS Certificates, then run this again."
note "Tailscale name: $HOST"

# ---- the relay, its pairing code, and a LaunchAgent that keeps it running ----
mkdir -p "$DIR/work" "$DIR/logs" "$HOME/Library/LaunchAgents"
CODE=""
if [ -f "$DIR/config.json" ]; then CODE="$(json_get code <"$DIR/config.json")"; fi
if [ -z "$CODE" ]; then
	CODE="$("$NODE" -e 'const a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";const b=require("crypto").randomBytes(16);let s="";for(let i=0;i<16;i++){s+=a[b[i]%32];if(i%4===3&&i<15)s+="-"}process.stdout.write(s)')"
fi
curl -fsSL "$SOURCE/relay.cjs" -o "$DIR/relay.cjs.new"
mv "$DIR/relay.cjs.new" "$DIR/relay.cjs"
"$NODE" -e '
const fs = require("fs");
const [file, code, claude, port] = process.argv.slice(1);
let old = {};
try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const cfg = { ...old, port: Number(port), code, claude, origins: old.origins || ["https://godraymond.github.io"], keepAwake: old.keepAwake !== false };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
' "$DIR/config.json" "$CODE" "$CLAUDE" "$PORT"
chmod 600 "$DIR/config.json"

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
		<string>$DIR/relay.cjs</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$DIR</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$(dirname "$CLAUDE"):$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>$DIR/logs/relay.log</string>
	<key>StandardErrorPath</key>
	<string>$DIR/logs/relay.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null || stop "The LaunchAgent file didn't come out right: $PLIST"
launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
sleep 1 # let an older relay let go of its port
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
up=0
for _ in $(seq 1 40); do
	if curl -fsS -m 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
		up=1
		break
	fi
	sleep 0.5
done
[ "$up" = 1 ] || stop "The relay didn't start. Its log is at: $DIR/logs/relay.log"
note "The relay is running and starts by itself when you log in."

# ---- publish it on your tailnet ----
bold "Sharing it with your own devices through Tailscale (HTTPS, port $HTTPS_PORT)"
note "If Tailscale prints a link to enable HTTPS or Serve, open it, switch it on, and come back here."
"$TS" serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT" <"$TTY" ||
	stop "Tailscale Serve didn't start. Make sure HTTPS Certificates are on at https://login.tailscale.com/admin/dns, then run this again."
if curl -fsS -m 40 "https://$HOST:$HTTPS_PORT/" >/dev/null 2>&1; then
	note "Reachable at https://$HOST:$HTTPS_PORT"
else
	warn "Couldn't reach it through Tailscale from this Mac yet. The first certificate can take a minute; the Check button on the phone will tell you."
fi

# ---- one real question, through the relay ----
bold "Asking Claude a test question through the relay"
ANSWER="$(curl -sS -m 180 -N "http://127.0.0.1:$PORT/v1/messages" \
	-H "content-type: application/json" -H "x-api-key: $CODE" \
	-d '{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"Reply with the single word OK."}],"output_config":{"effort":"low"}}' 2>&1 || true)"
SAID="$(printf '%s' "$ANSWER" | "$NODE" -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
	try { const j = JSON.parse(s); process.stdout.write("ERROR " + ((j.error && j.error.message) || s)); return; } catch {}
	let text = "", err = "";
	for (const line of s.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			const e = JSON.parse(line.slice(5));
			if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta") text += e.delta.text;
			if (e.type === "error") err = (e.error && e.error.message) || "error";
		} catch {}
	}
	process.stdout.write(err ? "ERROR " + err : text.trim() ? "OK " + text.trim() : "ERROR no answer: " + s.slice(0, 300));
});')"
case "$SAID" in
	OK*) note "Claude replied: ${SAID#OK }" ;;
	*) warn "The test question didn't get an answer: ${SAID#ERROR }"
		note "Fix that, then run this installer again. The relay's log is at: $DIR/logs/relay.log" ;;
esac

LINK="https://$HOST:$HTTPS_PORT/#$CODE"
printf '%s' "$LINK" | pbcopy 2>/dev/null || true
bold "Done. Your Mac link (copied to the clipboard):"
printf '\n    %s\n\n' "$LINK"
note "On your iPhone, open AllKnowing: Home → This device → Claude runs on: My Mac → paste the Mac link → Check."
note "With Universal Clipboard you can paste it straight on the iPhone; otherwise AirDrop or message it to yourself."
note "Keep this Mac on and logged in, and Tailscale connected on the iPhone."
note "Anyone with the link and access to your tailnet can use Claude on your plan, so keep it to yourself."
note "Remove it later with: curl -fsSL $SOURCE/install.sh | bash -s uninstall"
echo
