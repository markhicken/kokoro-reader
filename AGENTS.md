# Agent instructions

Kokoro Reader ships on **macOS (Apple Silicon)** and **Windows 11 (x64)**. The two platforms must stay
feature-equivalent. When you add or change a feature, fix a bug, or change a setting, apply it to both
platforms in the same change, or explicitly record why it is platform-specific.

## Keep platforms in sync

- **Default to shared code.** UI, settings, overlays, playback controls, the reader, IPC, and the engine
  protocol live in `src/renderer`, `src/shared`, `src/preload`, and `src/main/index.ts`. Put behavior
  there so both platforms get it. Do not gate a feature behind `windows` / `process.platform` unless the
  OS truly requires it.
- **Platform code must reach parity.** If you change one of the paired implementations, update its
  counterpart so behavior matches:
  - `native/helper.swift` (macOS Accessibility) ↔ `native/helper-windows.cpp` (Windows UI Automation)
  - `python/kokoro_server.py` (MLX) ↔ `python/kokoro_windows.py` (CPU PyTorch); both run the shared `serve()`
    loop, so the line-delimited JSON protocol (`speak`, `cancel`, `speed`, `startSeq`, chunk fields) must not diverge.
  - `createMacSpinnerFrames` ↔ `createWindowsSpinnerFrames` in `src/main/tray-spinner.ts`
  - macOS `vibrancy` overlays ↔ `src/main/windows-overlay-backdrop.ts`
  - Native highlighting (helper replies on macOS, `windows-highlight.ts` on Windows)
- **Intentional differences** (document any new one in code comments and the README): macOS Accessibility
  grant handling (`src/main/permissions.ts`), macOS-only model precision options, Windows-only voice
  filtering and fixed `fp32` model, platform default hotkeys, and OS-specific packaging.
- **Settings:** new settings need a `Settings` field in `src/shared/types.ts`, a default in
  `src/main/settings.ts`, a control in `src/renderer/settings`, and handling in the `settings:set` IPC
  handler. Check that the default and any migration are right for both platforms.
- **Packaging:** both builds must include the files they need. Update `package.json` (`mac` and `win`
  `extraResources`), `electron.vite.config.ts` (new renderer pages), `scripts/build.mjs`, and
  `scripts/check-package.mjs` together. New renderer pages must be added to `electron.vite.config.ts`.
- **Docs and CI:** update `README.md` (usage, validation checklist) and the `.github/workflows` files
  when a feature or build step changes on either platform.

## Validate

- `npm run typecheck` and `npm run build` must pass on whichever platform you are on. `npm run build` is the
  single build: it compiles the native helper and the app, then packages the installer into `dist/`.
- You usually cannot run the other platform. Say so, review its code paths by reading them, and list the
  checks still needed (see "Validate before release" in `README.md`) rather than claiming it works.
- A packaged build is only current if it was rebuilt after your change: `npm run build`
  then `node scripts/check-package.mjs`. Old files in `dist/` and `out/` are stale; do not test them.
- `npm run build` is slow (it packages); do not run it or install packages unless needed. `dist/`, `out/`, and `build/bin/` are ignored by git.

## Conventions

- Only comment code that needs clarification.
- Make surgical changes; do not refactor unrelated code.
