# AllKnowing on your Mac mini

Your always-on Mac mini becomes the home for AllKnowing:

- every meeting, transcript and follow-up is kept on the Mac mini, so your desktop, the Mac mini and your phones all see the same list (and a new meeting shows up on the others by itself)
- your Claude API key and Soniox speech key are saved on the Mac mini only. It asks Claude for you, and a device that starts listening gets a one-use speech key, never the real one
- your phones and computers just open the Mac mini's link in Safari or Chrome. Nothing to install on them except, for listening, Tailscale (see below)

## Why Tailscale for listening

Browsers only let a page use the microphone over a secure (https) link, or on the computer the page comes from. So:

| Where | Link | What works |
|---|---|---|
| The Mac mini itself | `http://localhost:4790` | Everything, listening too |
| Other devices on your home Wi-Fi | `http://<your-mac-mini>.local:4790` | Reading, preparing, importing, minutes. Not listening |
| Any of your devices with Tailscale, at home or away | `https://<your-mac-mini>.<tailnet>.ts.net` | Everything, listening too |

Tailscale is free for personal use. It's a private network between your own devices only: nothing is opened to the internet.

## Set it up (once)

1. **Node.js on the Mac mini.** In Terminal, `node -v` should say v18 or later. If not, install the LTS version from https://nodejs.org.
2. **Tailscale** (for listening on phones and other computers). On the Mac mini, install Tailscale from the Mac App Store and sign in. At https://login.tailscale.com/admin/dns switch on **MagicDNS** and **HTTPS Certificates**. Install Tailscale on each iPhone and computer you'll listen on, signed in to the same account. You can skip this and add it later; run the installer again afterwards.
3. **Install.** In Terminal on the Mac mini:

   ```
   curl -fsSL https://raw.githubusercontent.com/Godraymond/AllKnowing/main/assistant/hub/install.sh | bash
   ```

   It downloads AllKnowing into `~/AllKnowing`, starts it (and again at every login), shares it through Tailscale if it's there, prints your **pairing code** and links, and opens AllKnowing in the Mac's browser. If macOS asks whether `node` may accept incoming connections, choose **Allow**.
4. **Keys, once for every device.** In the AllKnowing window that opened on the Mac mini: Home → **Mac mini** box → paste your Claude API key → Save, then your Soniox speech key → Save. Each says "Works." when it's right. Already set them up in the web app? Its **This device** box has a **Show** button to copy them from.
5. **Each other device.** Open one of the links and enter the pairing code once. Or open the pairing link the installer put on the Mac's clipboard (AirDrop or message it to yourself). On iPhone you can then tap Share → **Add to Home Screen**; the installed app asks for the code once more.

## Move your existing notes

Notes from the web app (godraymond.github.io/AllKnowing) live in that browser. To bring them across:

1. In the old app: Home → Settings → **Download all notes**. You get one file: `AllKnowing notes <date>.json`.
2. In AllKnowing on the Mac mini (any connected device): Home → Settings → **Bring in notes** → pick that file.

Meetings already on the Mac mini stay as they are unless the file has a newer copy, so doing it twice changes nothing. The same works from the claude.ai version (its Settings has the same two buttons). Old 狼人杀 games come along but stay hidden.

## Updates

- The page updates itself from GitHub when nothing has been saved for a while (not during a meeting). Open pages are told to reload.
- **Get the latest version** in the Mac mini box (under "Keys, links, other devices and updates") updates everything now, the server included.
- Or run the install line again. Updates never touch your notes, keys or pairing code.

## Good to know

- Keep the Mac mini on and logged in. While AllKnowing runs it stops the Mac from going to sleep (the screen can still turn off).
- Every day the Mac mini saves a copy of all your notes in `~/AllKnowing/backups` and keeps the last 30. Bring one in with **Bring in notes** if you ever need it.
- `~/AllKnowing/config.json` holds the pairing code and your keys; only your Mac user can read it. The log is `~/AllKnowing/logs/hub.log`.
- Only a device that has the pairing code can see or change anything. The Mac mini itself doesn't need it. After 12 wrong codes a device has to wait 10 minutes.
- On the home Wi-Fi link (plain http) the code and your notes cross your own network unencrypted. Through Tailscale they're encrypted and private to your devices.
- The audio goes to Soniox and the transcript and notes go to Claude (Anthropic's API), as before. Tell people in the meeting that AllKnowing is listening.
- Remove it with the same line ending in `| bash -s uninstall`. Your notes stay in `~/AllKnowing` until you delete the folder.
- Outlook and Teams stay in the claude.ai version.
- This was tested in a simulated setup (headless Chrome, stand-ins for Claude, Soniox, GitHub and Tailscale, and a dry run of the installer on Linux), not yet on a real Mac mini, iPhone or the real services. Expect the first real run to turn something up.
