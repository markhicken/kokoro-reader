# Kokoro Reader

**Free, private, AI text-to-speech for macOS and Windows.**

Select text in any app, press a hotkey, and hear it read aloud in a natural-sounding voice while each
word is highlighted as it is spoken. Kokoro Reader runs from the menu bar on macOS and the system
tray on Windows. It uses the open-weight [Kokoro TTS](https://github.com/hexgrad/kokoro) model,
running locally through [mlx-audio](https://github.com/Blaizzy/mlx-audio) on Apple Silicon and through
CPU PyTorch on Windows.

<img width="459" height="838" alt="Screenshot 2026-10-07 at 10 41 10 AM" src="https://github.com/user-attachments/assets/54adb358-243f-4dc5-a994-de986f6efc3e" />

- **Free** — open source (GPL-3.0), no subscription, no API keys, no usage limits.
- **Private** — speech is generated on your computer. The app downloads Python dependencies, model
  weights, and voices on first use. Cached voices work offline.
- **AI voices** — choose a Kokoro voice and playback speed. macOS also offers model precision settings.

## Download

Installers are listed on the [Releases page](https://github.com/markhicken/kokoro-reader/releases/latest).

- **macOS (Apple Silicon)** — open the `.dmg` and drag Kokoro Reader to Applications.
- **Windows 11 (x64)** — run the `x64-setup.exe` installer when available, then open Kokoro Reader
  from Start. Look in the notification-area overflow if the tray icon is hidden. Local builds use
  an unsigned installer unless Windows signing credentials are configured.

The app is not notarized, so macOS may block the first launch. Right-click the app and choose **Open**,
or run:

```sh
xattr -dr com.apple.quarantine "/Applications/Kokoro Reader.app"
```

To build from source instead, see below.

## Build from source

Both platforms require Node.js 22.12 or later and [uv](https://docs.astral.sh/uv/). `uv` installs
Python and the platform's locked dependencies. Initial setup and the first use of a voice need internet access.

- **macOS** — Apple Silicon and Xcode Command Line Tools (`xcode-select --install`).
- **Windows** — Windows 11 x64 and Visual Studio 2022 Build Tools with **Desktop development with C++**
  and a Windows SDK. The build locates the compiler from an ordinary PowerShell or Command Prompt.

```text
npm ci
npm run dev
npm run dist -- --publish never
```

The installer goes in `dist/`. macOS produces `Kokoro Reader-<version>-arm64.dmg` and Windows produces
`Kokoro Reader-<version>-x64-setup.exe`.

The packaged app includes `uv` and the Python sources. On first launch it creates a Python environment
in its per-user application data directory. The setup can take a few minutes. macOS stores it under
`~/Library/Application Support/Kokoro Reader/` and Windows under `%APPDATA%\Kokoro Reader\`.
The model comes from Hugging Face. Rebuilding the Mac app can require a new Accessibility grant.

## Usage

- **Option+Shift+Space** on macOS or **Ctrl+Alt+Space** on Windows reads the current selection. Change
  the shortcut in Settings. On macOS, grant Accessibility permission to Kokoro Reader (or Electron
  in development) in System Settings → Privacy & Security → Accessibility.
- The tray menu offers Read Selection, Stop, and Settings. Pressing the hotkey while reading also stops.
- The **Show preparing overlay** setting is on by default. It shows a centered status and the cancel shortcut while audio is preparing.
- **Playback controls** are enabled by default. The floating overlay supports pause, stop, and 10-second skips within generated audio. Drag it to move it, or use the reset button beside the setting.
- Enable source and reader panel highlighting independently in Settings. Source highlighting works
  where macOS Accessibility or Windows UI Automation can report the position of the selected words.
- Selection capture uses the OS accessibility API without accessing the clipboard. Source apps need to
  expose their selection through those APIs. Windows apps running elevated may be unavailable to the reader.
- Reader panel: Space = pause/resume, Esc = stop. Drag the header to move it; position is remembered.
- Settings include voice, speed, shortcut, and panel and highlight options. macOS also offers
  fp32, bf16, 8-bit, 6-bit, and 4-bit model precision. Windows uses a single CPU model.

## Architecture

- `src/main` — Electron main process manages windows, tray, shortcuts, settings, and child processes.
- `native/helper.swift` and `native/helper-windows.cpp` — macOS Accessibility and Windows UI Automation helpers.
- `python/kokoro_server.py` and `python/kokoro_windows.py` — MLX and CPU PyTorch backends share a
  line-delimited JSON protocol and stream PCM with word timings. Each OS has its own Python lockfile.
- `src/renderer/reader` — floating panel: gapless Web Audio playback and word highlighting via the
  CSS Custom Highlight API.

Word timestamps come from Kokoro's duration predictor for English voices (`a*`/`b*`). Other
languages fall back to estimated timing. Spanish, French, Hindi, Italian and Portuguese use espeak-ng,
which is installed in the Python environment. On macOS, Japanese and Chinese require optional
G2P dependencies (`misaki[ja]`, `misaki[zh]`).

## Validate before release

The **Validate desktop builds** workflow builds both installers without publishing and runs a packaged
speech test covering timestamps, cancellation, and cached offline speech. Require its **macOS arm64**
and **Windows x64** checks before merging platform changes.

- **Apple Silicon Mac** — install the test DMG over the previous build and verify settings persist.
  Exercise first launch, grant and regrant Accessibility, then test the shortcut and tray action in
  TextEdit and Safari. Verify word highlights, switching apps, full-screen sources, pause and resume,
  stopping with the shortcut, and the floating panel with highlighting disabled or enabled.
- **Windows 11 x64** — install under a standard account. Verify first setup, offline relaunch, upgrade,
  and uninstall. Test the tray and shortcut in Notepad, a Chromium browser, and VS Code. Exercise
  focus changes, apps without selection support, and monitors using different scaling.

Mac releases continue to publish on pushes to `main` or `master`. After the interactive checks pass,
set the repository Actions variable `RELEASE_WINDOWS` to `true` to include the Windows installer in
the same releases. With Windows enabled, publication requires both installers to build successfully.

## Troubleshooting

- **Hotkey does nothing:** macOS's own "Speak selection" (System Settings → Accessibility → Spoken
  Content) owns Option+Esc, and other apps may own other combos. Pick a different hotkey in Settings.

## License

[GPL-3.0](LICENSE)
