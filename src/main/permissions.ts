import { app, shell, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Must match `build.appId` in package.json. */
const BUNDLE_ID = 'local.kokoro-gui.reader'
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

/** Resolve a binary's code-signature CDHash — the identity an ad-hoc-signed TCC grant is pinned to. */
function cdHash(path: string): Promise<string> {
  return new Promise((done) =>
    execFile('/usr/bin/codesign', ['-d', '-vvv', path], (_err, _out, stderr) =>
      done(/CDHash=(\w+)/.exec(stderr)?.[1] ?? '')
    )
  )
}

/**
 * Packaged builds are ad-hoc signed, so every build gets a new CDHash and the previous build's
 * Accessibility entry (which still looks enabled in System Settings) no longer matches. On the
 * first launch of a build, drop our old entry so macOS prompts afresh. Returns true if it did.
 */
export async function resetGrantForNewBuild(helperPath: string): Promise<boolean> {
  if (!app.isPackaged) return false
  const bundle = resolve(process.execPath, '../../..')
  const fingerprint = `${await cdHash(bundle)}:${await cdHash(helperPath)}`
  const file = join(app.getPath('userData'), 'accessibility-build.txt')
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (fingerprint === previous || fingerprint === ':') return false
  await resetEntry()
  try {
    writeFileSync(file, fingerprint)
  } catch {}
  console.log('[kokoro] new build detected; reset Accessibility grant')
  return true
}

function resetEntry(): Promise<void> {
  return new Promise<void>((done) =>
    execFile('/usr/bin/tccutil', ['reset', 'Accessibility', BUNDLE_ID], (err) => {
      if (err) console.error('[kokoro] tccutil reset failed:', err.message)
      done()
    })
  )
}

export function isAccessibilityTrusted(): boolean {
  return systemPreferences.isTrustedAccessibilityClient(false)
}

/**
 * Ask macOS for Accessibility permission. The build is ad-hoc signed, so after a
 * rebuild the old entry in System Settings can look enabled but no longer match this
 * binary — and macOS won't prompt again while it exists. Reset our own entry first
 * (never another app's, and only when untrusted or `force`d because the helper found the
 * grant stale), then trigger the system prompt.
 */
export async function requestAccessibility(force = false): Promise<void> {
  if (!force && isAccessibilityTrusted()) return
  if (app.isPackaged) await resetEntry()
  systemPreferences.isTrustedAccessibilityClient(true)
}

export function openAccessibilitySettings(): void {
  void shell.openExternal(SETTINGS_URL)
}

/**
 * Poll the trust state; calls `onChange` whenever it flips. `check` must also catch stale
 * grants, which `isAccessibilityTrusted()` alone still reports as trusted.
 */
export function watchAccessibility(
  initial: boolean,
  check: () => Promise<boolean>,
  onChange: (trusted: boolean) => void
): void {
  let last = initial
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const now = await check()
      if (now !== last) {
        last = now
        onChange(now)
      }
    } finally {
      busy = false
    }
  }, 2000)
}
