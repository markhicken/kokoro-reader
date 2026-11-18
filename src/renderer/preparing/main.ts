import { formatHotkey } from '../../shared/hotkey'

const shortcutHint = document.getElementById('shortcutHint')!
const trayHint = document.getElementById('trayHint')!
const shortcut = document.getElementById('shortcut')!

window.kokoro.onPreparationShortcut((hotkey) => {
  shortcutHint.hidden = hotkey === null
  trayHint.hidden = hotkey !== null
  shortcut.textContent = hotkey ? formatHotkey(hotkey, window.kokoro.windows) : ''
})
