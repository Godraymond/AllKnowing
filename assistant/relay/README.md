# Claude on your Mac, for the AllKnowing web app

The AllKnowing web app on your phone can use Claude through Claude Code on your Mac, signed in with your Claude plan, so you don't need a Claude API key. Listening, and telling the voices apart, still happens on the phone with your Soniox speech key.

Setting AllKnowing up on your Mac mini instead ([its guide](../hub/README.md))? Then you don't need this: the Mac mini runs the same relay by itself, and its installer sets up Claude Code.

```
iPhone (AllKnowing) ──Tailscale, HTTPS, your devices only──▶ Mac: relay ──▶ claude -p (your Claude plan)
```

## What you need

- A Mac that stays on and logged in. A Mac mini is ideal.
- Node.js 18 or later on the Mac: the LTS version from [nodejs.org](https://nodejs.org).
- Claude Code on the Mac, signed in with your Claude account. If it's missing, the installer installs it with Anthropic's own installer and asks you to sign in.
- Tailscale on the Mac and on the iPhone, signed in to the same account.

## Set it up (about 10 minutes)

1. **Tailscale.** Install it on the Mac (Mac App Store or [tailscale.com/download](https://tailscale.com/download)) and on the iPhone (App Store), and sign in to the same account on both. In the [admin console's DNS page](https://login.tailscale.com/admin/dns), check MagicDNS is on and turn on **HTTPS Certificates**.
2. **The relay.** On the Mac, open Terminal and run:

   ```
   curl -fsSL https://raw.githubusercontent.com/Godraymond/AllKnowing/main/assistant/relay/install.sh | bash
   ```

   It checks Node.js, makes sure Claude Code is installed and signed in, starts the relay and keeps it running, shares it on your tailnet on port 8443, asks Claude a test question, and copies your **Mac link** to the clipboard. If Tailscale prints a link to enable HTTPS or Serve, open it, switch it on and go back to Terminal.
3. **The phone.** Open AllKnowing from its Home Screen icon → Home → **This device** → Claude runs on: **My Mac** → paste the Mac link → **Check**. It should say "Works."
4. In the same box, paste your Soniox speech key and tap Check.

## Day to day

- Keep the Mac on and logged in. The relay keeps it from sleeping while it runs.
- Keep Tailscale connected on the iPhone.
- What AllKnowing asks counts toward your Claude plan's usage limits. For a long meeting, set Live updates to Fast in Settings.
- If something stops working, the Check button says why: the Mac is off or unreachable, Claude Code isn't signed in, or the plan's usage limit is reached (with when it resets).

## Good to know

- Each request runs `claude -p` once on the Mac, with no tools, no MCP servers and nothing saved. The relay's log records the time, model and outcome of each request, never what was said.
- The relay listens only on the Mac itself. Tailscale Serve makes it reachable from devices on your tailnet only, over HTTPS, and every request also needs the pairing code in your Mac link. Keep the link to yourself.
- Files: `~/Library/Application Support/AllKnowing Relay` (the relay, `config.json` with your pairing code, `logs/relay.log`) and `~/Library/LaunchAgents/com.godraymond.allknowing-relay.plist`.
- **Update:** run the installer again; it keeps your pairing code.
- **New pairing code:** delete `config.json` in that folder and run the installer again, then paste the new link on the phone.
- **Remove:** `curl -fsSL https://raw.githubusercontent.com/Godraymond/AllKnowing/main/assistant/relay/install.sh | bash -s uninstall`
