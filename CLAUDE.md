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
2. Run the **Build installers** workflow (Actions tab → Build installers → Run workflow).
3. It builds Windows (.exe), macOS (Intel and Apple Silicon .dmg/.zip) and Linux (.AppImage) and publishes them as GitHub release `v<version>`.

Installed copies check this fork's releases for updates (`publish` in electron-builder.json5). Builds are unsigned, so Windows SmartScreen and macOS Gatekeeper warn on first open, and macOS auto-update won't work without signing.

## The AllKnowing assistant (`assistant/`)

`assistant/index.html` is the meeting and 狼人杀 assistant: prep plan, live transcript with "what to say next" and a visual summary, minutes, follow-ups, Outlook calendar holds and email drafts. It runs as a claude.ai artifact, not inside the Electron app, because it relies on the artifact runtime: `dictation` (speech-to-text), `sample` (Claude), `db` (per-user storage), `mcp` (Microsoft 365: `outlook_calendar_search`, `outlook_create_event`, `outlook_create_draft`), `downloads` and `user`.

- Live artifact: https://claude.ai/artifact/RLztYbj7DvF4Lm11eekJtd (slug `c5262278-7a8f-4515-8ac2-01b1c8e8d93e`).
- To change it: edit `assistant/index.html`, run `npx biome lint assistant/index.html`, then republish that file to the same artifact. Keep the repo copy and the artifact in step.
- Don't republish while the owner is in a live meeting or game: open copies of the page reload at their next quiet moment.
- Data lives in the artifact's db under `data/users/<id>/home` (settings), `.../home/index/<id>`, `.../home/meetings/<id>` with transcripts in `.../meetings/<id>/parts/pNNN`, and `.../home/todos/<id>`.
