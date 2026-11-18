import { formatHotkey } from '../../shared/hotkey'
import '../overlay'

const shortcutHint = document.getElementById('shortcutHint')!
const trayHint = document.getElementById('trayHint')!
const shortcut = document.getElementById('shortcut')!
const preparing = document.getElementById('preparing')!
const notice = document.getElementById('noSelection')!

window.kokoro.onCenteredOverlay((overlay) => {
  preparing.hidden = overlay.kind !== 'preparing'
  notice.hidden = overlay.kind !== 'no-selection'
  if (overlay.kind !== 'preparing') return
  const { hotkey } = overlay
  shortcutHint.hidden = hotkey === null
  trayHint.hidden = hotkey !== null
  shortcut.textContent = hotkey ? formatHotkey(hotkey, window.kokoro.windows) : ''
})
