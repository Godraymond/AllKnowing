# Recordly fork (Godraymond/AllKnowing)

This fork is based on the official Recordly **v1.4.0** release line (upstream commit `4992686`), not on upstream `main`.

## Don't

- Don't merge or pull upstream `main`. Upstream replaced it with a 2.0 rewrite whose history split from 1.4.0 in Nov 2025, so a merge drags in a different codebase.
- Don't use GitHub's "Sync fork" button, for the same reason. It offers to throw away this fork's commits.

## Day to day

- Work on `main`. Every push to `main` runs the **Code Quality** workflow (typecheck, lint, tests).
- Check before pushing: `npx tsc --noEmit && npm run lint && npx vitest --run`
- Headless/cloud setup: `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts`. The app window needs a desktop. On Windows, run `npm run dev` from a normal path; a path under a virtualised AppData folder breaks Vite's transform and gives a blank window.

## Releases

1. Bump `version` in package.json (`npm version patch --no-git-tag-version`), commit, push.
2. Run the **Build installers** workflow (Actions tab → Build installers → Run workflow). Cloud sessions can't start it themselves (the API refuses workflow dispatch and the git proxy refuses tag pushes), so use the person's browser or ask them to press it.
3. It builds Windows (.exe), macOS (Intel and Apple Silicon .dmg/.zip) and Linux (.AppImage) and publishes them as GitHub release `v<version>`.

Installed copies check this fork's releases for updates (`publish` in electron-builder.json5). Builds are unsigned, so Windows SmartScreen and macOS Gatekeeper warn on first open, and macOS auto-update won't work without signing.

## The AllKnowing assistant (`assistant/`)

`assistant/index.html` is the meeting and 狼人杀 assistant: prep plan, live transcript with "what to say next" and a visual summary, minutes, follow-ups, Outlook calendar holds and email drafts. Its Import screen takes transcripts recorded elsewhere (.txt/.srt/.vtt/.docx/.json, pasted text, or a Teams meeting's transcript) and runs them through the same minutes and follow-ups. It runs as a claude.ai artifact, not inside the Electron app, because it relies on the artifact runtime: `dictation` (speech-to-text), `sample` (Claude), `db` (per-user storage), `mcp` (Microsoft 365: `outlook_calendar_search`, `outlook_create_event`, `outlook_create_draft`, `read_resource` for Teams transcripts), `downloads` and `user`.

- Live artifact: https://claude.ai/artifact/RLztYbj7DvF4Lm11eekJtd (slug `c5262278-7a8f-4515-8ac2-01b1c8e8d93e`).
- To change it: edit `assistant/index.html`, run `npx biome lint assistant/index.html`, then republish that file to the same artifact. Keep the repo copy and the artifact in step.
- If the page starts calling a connector tool it hasn't used before, add the tool to the artifact's declaration first (read_declaration, then declare_capabilities with the whole declaration), then republish.
- Don't republish while the owner is in a live meeting or game: open copies of the page reload at their next quiet moment.
- 狼人杀 speakers: the artifact's `dictation` gives words only (no voices, no audio), so the page works out who is speaking itself and the user never taps seats. `seatCue`/`seatStep` tag each phrase from what's heard (moderator calls like 请5号发言, 我是5号, a speech ending in 过, pauses); every live update also asks Claude for `speakers` and `turn`, and `applySpeakers` writes its calls back to the transcript. Spoken lines carry `by` (`cue` heard, `order` assumed, `ai` Claude with confidence `c`, `tap` set by the user, `voice` matched by voice) and `g` (pause before, seconds). After touching this, run `node assistant/check-seat-tracking.cjs`.
- Voices: the web app's listener (below) also says which voice spoke, so its lines carry `v`. A voice is evidence, not a fact (the speech service can split one person in two or merge two). In a game every cue, order, Claude or tap tag is a vote for "this voice is that seat" (`voiceMap`); a voice with a clear winner tags its own lines and moves the floor without a cue, Claude is shown `vN` on each line and asked for `voices`, and `sweepVoices` fixes earlier lines. In a meeting a voice gets a name from a tap on a name chip or line tag, or from Claude (`m.voices`). Voice numbers restart on every connection, so each listening start and each reconnect gets its own block of 20. With no `v` on any line (the artifact) none of this runs and Claude's prompts are unchanged.
- The page can't transcribe audio files itself. The desktop app's **Transcribe a Recording…** (`electron/transcribeRecording.ts`; taskbar Jump List on Windows, Dock menu on macOS, tray on Linux, File menu everywhere) runs the bundled whisper.cpp locally and saves `<name>.transcript.txt` and `<name>.srt` for the Import screen.
- Data lives in the artifact's db under `data/users/<id>/home` (settings), `.../home/index/<id>`, `.../home/meetings/<id>` with transcripts in `.../meetings/<id>/parts/pNNN`, and `.../home/todos/<id>`.

### The web app (iPhone and any browser)

The same page also runs outside claude.ai, so it can be opened in a browser or installed on an iPhone (Safari → Share → Add to Home Screen). An artifact can't do this job: its frame has no microphone, and its `dictation` gives no voices.

- `assistant/build-web.cjs` writes `assistant/dist/`: `index.html` with the manifest, icons, iOS tags and `web/standalone.js` added in `<head>`. `index.html` in the repo stays exactly what the artifact runs.
- `assistant/web/standalone.js` provides `window.claude` when the artifact runtime isn't there: `sample` (Claude, either through the Mac relay below or the Anthropic Messages API with the user's own key, streamed), `dictation` (microphone → 16 kHz 16-bit mono → Soniox real-time WebSocket with speaker diarization → `onFinal({ text, voice, gap })`), and `downloads`. No `db` or `mcp`: meetings live in that browser's localStorage and the Outlook buttons don't show. Keys are stored on the device only (`allknowing:keys:v1`).
- The Soniox protocol was taken from its official SDK (`@soniox/client` 2.5.0): `wss://stt-rt.soniox.com/transcribe-websocket`, key in the WebSocket subprotocol list (`["soniox-api-key", key]`), one JSON settings message, binary audio frames, `""` to finish, `<end>`/`<fin>` marker tokens, `{error_code, error_message}` on failure.
- **Claude on the user's Mac** (`assistant/relay/`): `relay.cjs` is a small Node server on the Mac that answers a subset of the Messages API (`POST /v1/messages`, streamed SSE, `GET /health`) by running `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --tools "" --strict-mcp-config --no-session-persistence ...` once per request, so Claude runs on the user's Claude plan through Claude Code itself (Anthropic's docs: `claude -p` signed in with a plan draws from the plan's limits). It strips `ANTHROPIC_API_KEY` from Claude Code's environment, listens on 127.0.0.1:47823 only, needs the pairing code as `x-api-key`, and only allows CORS from the Pages origin and localhost. `install.sh` (run on the Mac via curl | bash) sets up the files, a LaunchAgent and `tailscale serve --bg --https=8443`, and prints the Mac link `https://<mac>.ts.net:8443/#<code>` that the phone pastes in "This device". The message shapes come from the Agent SDK's types (`@anthropic-ai/claude-agent-sdk` 0.3.325) and the flags from `claude --help` (2.1.325); the relay leaves out any flag its Claude Code doesn't list and retries without one it rejects. Checks: `node assistant/check-relay.cjs` (with `relay/fake-claude.cjs` standing in for Claude Code) and the Mac section of the web app test. The installer was dry-run on Linux with stand-ins for launchctl, tailscale, plutil and pbcopy, never on a real Mac.
- Hosting: the **Web app** workflow builds on every push that touches `assistant/` and force-pushes the result to the `gh-pages` branch. GitHub Pages serves it at https://godraymond.github.io/AllKnowing/ once Pages is on (Settings → Pages → Deploy from a branch → `gh-pages`, `/ (root)`). Cloud sessions can't change that setting.
- Not testable from a cloud session: a real iPhone, a real microphone, the real Soniox service, the real Anthropic API, a real Mac with Tailscale, and real `claude -p` (running it here is blocked). What is tested is the page in headless Chrome with a fake microphone against local stand-ins that follow the SDK's protocol.
