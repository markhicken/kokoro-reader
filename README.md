# Kokoro Reader

**Free, private, AI text-to-speech for macOS.**

Select text in any app, press a hotkey, and hear it read aloud in a natural-sounding voice while each
word is highlighted as it is spoken. Kokoro Reader is a menu-bar app built on the open-weight
[Kokoro TTS](https://github.com/hexgrad/kokoro) model, run locally on Apple Silicon via
[mlx-audio](https://github.com/Blaizzy/mlx-audio).

<img width="458" height="757" alt="Screenshot 2026-10-02 at 5 09 28 PM" src="https://github.com/user-attachments/assets/49ff9ecd-d77f-4f46-a5e8-cf60213b46a0" />

- **Free** — open source (GPL-3.0), no subscription, no API keys, no usage limits.
- **Private** — speech is generated entirely on your Mac. Your text is never sent to a server; the
  only network access is the one-time download of the model and Python dependencies.
- **AI voices** — Kokoro's neural voices, with adjustable voice, speed, and model precision.

## Download

Grab the latest `.dmg` from the [Releases page](https://github.com/markhicken/kokoro-reader/releases/latest)
(Apple Silicon only), open it, and drag Kokoro Reader to Applications.

The app is not notarized, so macOS may block the first launch. Right-click the app and choose **Open**,
or run:

```sh
xattr -dr com.apple.quarantine "/Applications/Kokoro Reader.app"
```

To build from source instead, see below.

## Requirements

Building from source needs:

- **Apple Silicon Mac** — MLX only runs on Apple Silicon; the build is arm64-only.
- **Node.js** 20.19+ or 22.12+ (required by Vite 7 / electron-vite 5).
- **[uv](https://docs.astral.sh/uv/)** — `npm install` runs `uv sync`, and `npm run dist` bundles the
  local `uv` binary into the app. uv fetches a suitable Python (3.11–3.12) itself.
- **Xcode Command Line Tools** (`xcode-select --install`) — `swiftc` builds the native helper.
- **Network on first run** — Python dependencies and the model (~330 MB) are downloaded once.
- *Optional:* `misaki[ja]` / `misaki[zh]` for Japanese / Chinese voices (see Architecture).

## Setup

```sh
npm install        # postinstall downloads the Electron binary and runs `uv sync` in python/
npm run dev        # or: npm start (production build)
```

### Build the Mac app

```sh
npm run dist       # → dist/Kokoro Reader-<version>-arm64.dmg (and dist/mac-arm64/Kokoro Reader.app)
```

The app bundles `uv` and the Python sources. On first launch it creates its Python environment in
`~/Library/Application Support/Kokoro Reader/python-env` (needs network; can take a few minutes on a
fresh machine). The build is ad-hoc signed, not notarized: on another Mac, right-click → Open the
first time. Rebuilding changes the signature, so macOS may ask for Accessibility permission again.

The first run downloads the model from Hugging Face (~330 MB for bf16).

## Usage

- **Option+Shift+Space** (configurable) reads the current selection from any app. The first time, grant
  Accessibility permission to Kokoro Reader (or Electron when running via `npm run dev`) (System Settings → Privacy & Security → Accessibility) —
  the native helper (`native/helper.swift`) uses it to read the selection and locate words on screen.
- The tray menu offers Read Selection, Stop, and Settings. Pressing the hotkey while reading also stops.
- The spoken word is highlighted in place in the source app (native text views and Safari/WebKit),
  and optionally in the floating reader panel — both toggle in Settings.
- The app never reads or writes the clipboard: selections are read via the Accessibility API, so apps
  that don't expose their selection to Accessibility can't be read.
- Reader panel: Space = pause/resume, Esc = stop. Drag the header to move it; position is remembered.
- Settings: voice, speed, model precision (bf16 / 8-bit / 6-bit / 4-bit — smaller is lighter on
  memory), hotkey, and panel/highlight options.

## Architecture

- `src/main` — Electron main process: tray, global hotkey, selection capture, settings
  (`~/Library/Application Support/Kokoro Reader/settings.json`), sidecar management.
- `python/kokoro_server.py` — long-lived mlx-audio sidecar speaking line-delimited JSON over stdio;
  streams per-segment PCM plus per-word `start`/`end` timestamps.
- `src/renderer/reader` — floating panel: gapless Web Audio playback and word highlighting via the
  CSS Custom Highlight API.

Word timestamps come from Kokoro's duration predictor for English voices (`a*`/`b*`). Other
languages fall back to estimated timing. Spanish, French, Hindi, Italian and Portuguese use espeak-ng,
which ships with the Python environment (no system install); their text isn't chunked yet, so very long
selections may be cut short. Japanese and Chinese need extra G2P dependencies (`misaki[ja]`, `misaki[zh]`).

## Troubleshooting

- **Hotkey does nothing:** macOS's own "Speak selection" (System Settings → Accessibility → Spoken
  Content) owns Option+Esc, and other apps may own other combos. Pick a different hotkey in Settings.

## License

[GPL-3.0](LICENSE)
