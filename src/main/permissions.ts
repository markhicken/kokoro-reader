import { app, shell, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'

/** Must match `build.appId` in package.json. */
const BUNDLE_ID = 'local.kokoro-gui.reader'
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

export function isAccessibilityTrusted(): boolean {
  return systemPreferences.isTrustedAccessibilityClient(false)
}

/**
 * Ask macOS for Accessibility permission. The build is ad-hoc signed, so after a
 * rebuild the old entry in System Settings can look enabled but no longer match this
 * binary — and macOS won't prompt again while it exists. Reset our own entry first
 * (never another app's, and only when untrusted), then trigger the system prompt.
 */
export async function requestAccessibility(): Promise<void> {
  if (isAccessibilityTrusted()) return
  if (app.isPackaged) {
    await new Promise<void>((resolve) =>
      execFile('/usr/bin/tccutil', ['reset', 'Accessibility', BUNDLE_ID], (err) => {
        if (err) console.error('[kokoro] tccutil reset failed:', err.message)
        resolve()
      })
    )
  }
  systemPreferences.isTrustedAccessibilityClient(true)
}

export function openAccessibilitySettings(): void {
  void shell.openExternal(SETTINGS_URL)
}

/** Poll while untrusted; calls `onChange` whenever the trust state flips. */
export function watchAccessibility(onChange: (trusted: boolean) => void): void {
  let last = isAccessibilityTrusted()
  setInterval(() => {
    const now = isAccessibilityTrusted()
    if (now !== last) {
      last = now
      onChange(now)
    }
  }, 2000)
}
