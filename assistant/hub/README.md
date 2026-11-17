# AllKnowing on your Mac mini

Your always-on Mac mini becomes the home for AllKnowing:

- every meeting, transcript and follow-up is kept on the Mac mini, so your desktop, the Mac mini and your phones all see the same list (and a new meeting shows up on the others by itself)
- your Claude API key and Soniox speech key are saved on the Mac mini only. It asks Claude for you, and a device that starts listening gets a one-use speech key, never the real one
- it turns recordings into text: give it an MP3, M4A, WAV or MP4 on the Import screen and you get the transcript with the voices told apart, then the minutes
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

## Import a recording

On any connected device: **Import** → drop or choose the recording (MP3, M4A, WAV, MP4, MOV and most others) → **Transcribe and write the minutes**.

- The file goes to the Mac mini first. Keep the page open until that's done (a bar shows how far it is). After that you can close AllKnowing or put the phone away: the meeting is already in your list, marked "Transcribing", and the transcript is there when you open it, on whichever device.
- The Mac mini sends the audio to Soniox with your speech key, and Soniox sends back the text with the voices numbered. It costs about US$0.10 for an hour of audio, on your Soniox account. Soniox's copy is deleted as soon as the text is back, and so is the Mac mini's; only the transcript is kept, with the meeting.
- Then Claude writes the minutes and puts names to the voices from what was said (fill in "Who was there" first and it has the names to use). Tap a name on any line of the transcript to change whose voice it is.
- Longer than an hour? Soniox's own pages disagree on whether it takes more than an hour of audio in one file, so the Mac mini finds out: the first long recording is sent whole, and if Soniox says no it goes in parts of under an hour that overlap by a few minutes and are stitched back together. It remembers which way worked. In parts, someone who said nothing around a join can come back as a new "Voice"; Claude is told where the joins are, and you can fix a name with a tap.
- A video is sent as its sound only. From a Teams or Zoom recording, the MP4 is fine as it is.
- MP3, M4A/MP4/MOV (AAC), AAC and WAV need nothing extra, however long. Other kinds (OGG, FLAC, WebM, Apple Lossless…) go as they are; if one has to be cut into parts, the Mac mini converts it first, with what macOS has for Apple's own formats and with `ffmpeg` for the rest if it's installed (`brew install ffmpeg`). Or save it as MP3 or M4A first.
- Up to 2 GB a file. Recordings can be imported over the home Wi-Fi link too; only live listening needs the secure one.
- Would you rather the audio never left your own computer? Recordly's **Transcribe a Recording…** does it on the desktop (slower, no voices), and its .srt imports here as a transcript.

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
- The audio goes to Soniox (live, and for recordings you import) and the transcript and notes go to Claude (Anthropic's API), as before. Tell people in the meeting that AllKnowing is listening, and that a recording is being transcribed by a service.
- While a recording is being worked on it sits in `~/AllKnowing/recordings`. That folder empties itself: the audio when the text is back, the text once it's saved with the meeting (or after a week).
- Remove it with the same line ending in `| bash -s uninstall`. Your notes stay in `~/AllKnowing` until you delete the folder.
- Outlook and Teams stay in the claude.ai version.
- This was tested in a simulated setup (headless Chrome, stand-ins for Claude, Soniox, GitHub and Tailscale, and a dry run of the installer on Linux), not yet on a real Mac mini, iPhone or the real services. Importing recordings was tested the same way: real audio files cut by the Mac mini's own code and played back to check, against a stand-in for Soniox's file service built from its published SDK. Expect the first real run to turn something up.
