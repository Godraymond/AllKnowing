# AllKnowing on your Mac mini

Your always-on Mac mini becomes the home for AllKnowing:

- every meeting, transcript and follow-up is kept on the Mac mini, so your desktop, the Mac mini and your phones all see the same list (and a new meeting shows up on the others by itself)
- Claude runs through your Claude plan, with Claude Code on the Mac mini: no API key and nothing extra to pay. The Soniox speech key (for listening on phones) is saved on the Mac mini only, and a phone that starts listening gets a one-use key, never the real one
- it turns recordings into text for free, on the Mac mini itself: give it an MP3, M4A, WAV or MP4 on the Import screen and three free speech models hear it and check each other; you get the transcript with the voices told apart, then the minutes
- your phones and computers just open the Mac mini's link in Safari or Chrome. Nothing to install on them except, for listening, Tailscale (see below)

## What it costs

| What | How | Cost |
|---|---|---|
| Summaries, reads, "what to say", minutes | Claude Code on the Mac mini, signed in with your Claude account | Part of your Claude plan (it uses the plan's usage, and a long meeting with auto-update on uses a fair bit) |
| Listening on a computer (the Mac mini, a laptop) | The browser's own speech recognition: Chrome, Edge or Safari | Free. The browser's maker (Google, Microsoft or Apple) turns the sound into words. It doesn't tell voices apart |
| Listening on an iPhone, iPad or Android phone | Soniox, which tells voices apart | About US$0.12 an hour |
| Importing a recording | The Mac mini's own free speech models | Free |

Each device can choose differently: Home → Mac mini box → **Use Soniox for listening** (phones and iPads only, every device, or never). A device that doesn't use Soniox never asks for its key. The claude.ai version is unchanged and costs nothing extra either: it listens and asks Claude as part of your plan, and it has Outlook and Teams.

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

   It downloads AllKnowing into `~/AllKnowing`, installs Claude Code if it isn't there (with Anthropic's own installer), starts AllKnowing (and again at every login), shares it through Tailscale if it's there, prints your **pairing code** and links, and opens AllKnowing in the Mac's browser. If macOS asks whether `node` may accept incoming connections, choose **Allow**.
4. **Sign in to Claude Code.** The installer asks you to: a browser window opens, sign in with your Claude account (the one with your plan) and approve. If it didn't, or you skipped it, run `claude auth login --claudeai` in Terminal on the Mac mini. In AllKnowing, Home → **Mac mini** box should then say "Ready: Claude Code … signed in with your plan" (tap **Check** to try it). If Claude Code was already signed in with an API (Console) account, the box says so: run `claude auth logout`, then `claude auth login --claudeai`. Rather pay per use with an API key? The same box takes one instead.
5. **The Soniox key, once, for your phones.** In the same box, paste your Soniox speech key → Save. It says "Works." when it's right. Computers don't need it, and nor does importing recordings: the same box shows the Mac mini fetching its free speech models, about 1.8 GB, and says "Ready" when they're in. Already set it up in the web app? Its **This device** box has a **Show** button to copy it from.
6. **Each other device.** Open one of the links and enter the pairing code once. Or open the pairing link the installer put on the Mac's clipboard (AirDrop or message it to yourself). On iPhone you can then tap Share → **Add to Home Screen**; the installed app asks for the code once more.

## Move your existing notes

Notes from the web app (godraymond.github.io/AllKnowing) live in that browser. To bring them across:

1. In the old app: Home → Settings → **Download all notes**. You get one file: `AllKnowing notes <date>.json`.
2. In AllKnowing on the Mac mini (any connected device): Home → Settings → **Bring in notes** → pick that file.

Meetings already on the Mac mini stay as they are unless the file has a newer copy, so doing it twice changes nothing. The same works from the claude.ai version (its Settings has the same two buttons). Old 狼人杀 games come along but stay hidden.

## Import a recording

On any connected device: **Import** → drop or choose the recording (MP3, M4A, WAV, MP4, MOV and most others) → **Transcribe and write the minutes**.

It's free. The Mac mini turns the recording into text itself, with three free speech models that check each other, so nothing is paid for and the audio never leaves the Mac mini.

- The file goes to the Mac mini first. Keep the page open until that's done (a bar shows how far it is). After that you can close AllKnowing or put the phone away: the meeting is already in your list, marked "Transcribing", and the transcript is there when you open it, on whichever device.
- How the three work together: every stretch of speech is heard by SenseVoice (which also says what language it is), then by a second model (Parakeet for English and European languages, Paraformer for Chinese), then by a third, stronger one (Qwen3-ASR) that is given the names from "Who was there". The three texts are lined up word by word. Two that agree outvote the third. Where all three differ, the most trusted reading is kept and the others are noted: those words have a dotted underline in the transcript (tap one to see what else was heard), and Claude is shown the other readings when it writes the minutes.
- The voices are told apart too, and Claude puts names to them from what was said (fill in "Who was there" first and it has the names to use). Tap a name on any line of the transcript to change whose voice it is.
- It isn't quick. On the computer it was tried on, an hour of recording took about 40 minutes; an older Mac may take longer. The Mac mini measures its own speed, and the Import screen says about how long each recording will take. The page shows which model is listening and how far along it is.
- The first time, the Mac mini fetches the speech models by itself: about 1.8 GB, once, and it needs about 4.5 GB free while it sets them up (2.1 GB afterwards). The Mac mini box on Home shows how far it is, then "Ready". They come from the sherpa-onnx project's releases on GitHub and from npm, and each download is checked against a fingerprint written into AllKnowing before it's used.
- English, Mandarin and Cantonese are what it's set up for, and a meeting that mixes them is fine. Japanese and Korean get two of the three models. Other European languages work through Parakeet and Qwen3-ASR.
- A video goes in as its sound only. From a Teams or Zoom recording, the MP4 is fine as it is.
- MP3, M4A, MP4, MOV, WAV, AIFF and FLAC are read with what macOS has. OGG and WebM need `ffmpeg` (`brew install ffmpeg`), or save them as MP3 or M4A first.
- Up to 2 GB a file. Recordings can be imported over the home Wi-Fi link too; only live listening needs the secure one.

**In a hurry?** If a Soniox speech key is saved, the Import screen also offers "Use Soniox instead": a few minutes instead of the best part of an hour, for about US$0.10 an hour of audio. The recording then goes to Soniox and is deleted there and on the Mac mini once the text is back. (Soniox's own pages disagree on whether it takes more than an hour in one file, so the Mac mini tries a long recording whole and, if Soniox says no, sends it in overlapping parts and stitches them back.)

**To switch the free way off** (and use only Soniox), put `"localSpeech": false` in `~/AllKnowing/config.json` and restart; to free the space, delete `~/AllKnowing/speech`.

## Updates

- The page updates itself from GitHub when nothing has been saved for a while (not during a meeting). Open pages are told to reload.
- **Get the latest version** in the Mac mini box (under "Keys, links, other devices and updates") updates everything now, the server included.
- Or run the install line again. Updates never touch your notes, keys or pairing code.

## Good to know

- Keep the Mac mini on and logged in. While AllKnowing runs it stops the Mac from going to sleep (the screen can still turn off).
- Every day the Mac mini saves a copy of all your notes in `~/AllKnowing/backups` and keeps the last 30. Bring one in with **Bring in notes** if you ever need it.
- `~/AllKnowing/config.json` holds the pairing code and your keys; only your Mac user can read it. The log is `~/AllKnowing/logs/hub.log`. Claude Code keeps its own sign-in (in the Mac's keychain), which is why AllKnowing runs as you, when you're logged in.
- Only a device that has the pairing code can see or change anything. The Mac mini itself doesn't need it. After 12 wrong codes a device has to wait 10 minutes.
- On the home Wi-Fi link (plain http) the code and your notes cross your own network unencrypted. Through Tailscale they're encrypted and private to your devices.
- Live, the audio goes to Soniox on a phone, and to the browser's own speech service on a computer (Google for Chrome, Microsoft for Edge, Apple for Safari). A recording you import stays on the Mac mini (unless you pick Soniox for it). The transcript and notes go to Claude, through Claude Code on the Mac mini (or Anthropic's API, if you chose a key). Tell people in the meeting that AllKnowing is listening.
- While a recording is being worked on it sits in `~/AllKnowing/recordings`. That folder empties itself: the audio when the text is back, the text once it's saved with the meeting (or after a week).
- Remove it with the same line ending in `| bash -s uninstall`. Your notes stay in `~/AllKnowing` until you delete the folder.
- Outlook and Teams stay in the claude.ai version. Here, Add to calendar and the follow-up email open Outlook on the web with everything filled in, or save a calendar file, or open your email app.
- The free speech models and their makers: the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) engine (Apache-2.0), SenseVoice and Paraformer (FunASR, Alibaba), Parakeet TDT 0.6b v3 (NVIDIA, CC-BY-4.0), Qwen3-ASR 0.6B (Alibaba, Apache-2.0), Silero VAD (MIT), pyannote segmentation 3.0 (MIT) and 3D-Speaker CAM++ (Apache-2.0). They live in `~/AllKnowing/speech`.
- This was tested in a simulated setup (headless Chrome, stand-ins for Claude, Claude Code, Soniox, the browser's speech recognition, GitHub and Tailscale, and a dry run of the installer on Linux), not yet on a real Mac mini, iPhone or the real services. Importing recordings with the free speech models was tried for real on a Linux computer: the real engine and the real models, on made-up meetings in English, Chinese and both, and on five minutes of a real speech. What hasn't been tried is the engine's Mac build on a real Mac (it comes ready-made for Intel and Apple Silicon Macs; if it won't run on yours, the Mac mini box says so and Soniox still works), macOS's own converter for MP3 and M4A, and real meetings with people talking over each other, where expect more mistakes and voices mixed up now and then. The Soniox way was tested against a stand-in built from its published SDK. Expect the first real run to turn something up.
