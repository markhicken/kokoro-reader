import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '../shared/types'

const DEFAULTS: Settings = {
  voice: 'af_heart',
  speed: 1.0,
  model: 'bf16',
  // Option+Esc is taken by macOS's built-in "Speak selection" shortcut.
  hotkey: 'Alt+Shift+Space',
  autoClosePanel: true,
  showPanel: true,
  highlightInSource: true,
  joinLines: true,
  expandWords: true
}

const file = () => join(app.getPath('userData'), 'settings.json')

let current: Settings | null = null

export function getSettings(): Settings {
  if (!current) {
    try {
      current = { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) }
      if (current!.hotkey === 'Alt+Escape') current!.hotkey = DEFAULTS.hotkey // old default, conflicts with macOS
    } catch {
      current = { ...DEFAULTS }
    }
  }
  return current!
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...getSettings(), ...patch }
  writeFileSync(file(), JSON.stringify(current, null, 2))
  return current
}
