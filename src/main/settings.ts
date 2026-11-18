import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '../shared/types'

const windows = process.platform === 'win32'
const DEFAULTS: Settings = {
  voice: 'af_heart',
  speed: 1.0,
  model: windows ? 'fp32' : 'bf16',
  // Option+Esc is taken by macOS's built-in "Speak selection" shortcut.
  hotkey: windows ? 'Control+Alt+Space' : 'Alt+Shift+Space',
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
      if (!windows && current!.hotkey === 'Alt+Escape') current!.hotkey = DEFAULTS.hotkey // old default, conflicts with macOS
      if (windows) {
        current!.model = DEFAULTS.model
        if (!/^[abefhip][fm]_/.test(current!.voice)) current!.voice = DEFAULTS.voice
      }
    } catch {
      current = { ...DEFAULTS }
    }
  }
  return current!
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...getSettings(), ...patch }
  if (windows) current.model = DEFAULTS.model
  writeFileSync(file(), JSON.stringify(current, null, 2))
  return current
}
