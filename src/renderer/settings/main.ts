import type { EngineStatus, ModelVariant, Settings } from '../../shared/types'

const api = window.kokoro

interface Voice {
  id: string
  grade?: string // overall quality grade from Kokoro's VOICES.md
}

// Grouped by language; English voices ordered best-first by Kokoro's quality grades.
const VOICES: Record<string, Voice[]> = {
  'American English': [
    { id: 'af_heart', grade: 'A' }, { id: 'af_bella', grade: 'A-' }, { id: 'af_nicole', grade: 'B-' },
    { id: 'af_aoede', grade: 'C+' }, { id: 'af_kore', grade: 'C+' }, { id: 'af_sarah', grade: 'C+' },
    { id: 'am_fenrir', grade: 'C+' }, { id: 'am_michael', grade: 'C+' }, { id: 'am_puck', grade: 'C+' },
    { id: 'af_alloy', grade: 'C' }, { id: 'af_nova', grade: 'C' }, { id: 'af_sky', grade: 'C-' },
    { id: 'af_jessica', grade: 'D' }, { id: 'af_river', grade: 'D' }, { id: 'am_echo', grade: 'D' },
    { id: 'am_eric', grade: 'D' }, { id: 'am_liam', grade: 'D' }, { id: 'am_onyx', grade: 'D' },
    { id: 'am_santa', grade: 'D-' }, { id: 'am_adam', grade: 'F+' }
  ],
  'British English': [
    { id: 'bf_emma', grade: 'B-' }, { id: 'bf_isabella', grade: 'C' }, { id: 'bm_fable', grade: 'C' },
    { id: 'bm_george', grade: 'C' }, { id: 'bm_lewis', grade: 'D+' }, { id: 'bf_alice', grade: 'D' },
    { id: 'bf_lily', grade: 'D' }, { id: 'bm_daniel', grade: 'D' }
  ],
  'Spanish (needs espeak-ng)': [{ id: 'ef_dora' }, { id: 'em_alex' }, { id: 'em_santa' }],
  'French (needs espeak-ng)': [{ id: 'ff_siwis' }],
  'Hindi (needs espeak-ng)': [{ id: 'hf_alpha' }, { id: 'hf_beta' }, { id: 'hm_omega' }, { id: 'hm_psi' }],
  'Italian (needs espeak-ng)': [{ id: 'if_sara' }, { id: 'im_nicola' }],
  'Portuguese (needs espeak-ng)': [{ id: 'pf_dora' }, { id: 'pm_alex' }, { id: 'pm_santa' }],
  'Japanese (needs misaki[ja])': [
    { id: 'jf_alpha' }, { id: 'jf_gongitsune' }, { id: 'jf_nezumi' }, { id: 'jf_tebukuro' }, { id: 'jm_kumo' }
  ],
  'Chinese (needs misaki[zh])': [
    { id: 'zf_xiaobei' }, { id: 'zf_xiaoni' }, { id: 'zf_xiaoxiao' }, { id: 'zf_xiaoyi' },
    { id: 'zm_yunjian' }, { id: 'zm_yunxi' }, { id: 'zm_yunxia' }, { id: 'zm_yunyang' }
  ]
}

/** "af_heart" + grade A → "Heart — Female · A ★" */
function voiceLabel({ id, grade }: Voice): string {
  const [prefix, raw] = id.split('_')
  const name = raw.charAt(0).toUpperCase() + raw.slice(1)
  const gender = prefix[1] === 'f' ? 'Female' : 'Male'
  const quality = grade ? ` · ${grade}${grade.startsWith('A') || grade.startsWith('B') ? ' ★' : ''}` : ''
  return `${name} — ${gender}${quality}`
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const voiceEl = $<HTMLSelectElement>('voice')
const speedEl = $<HTMLInputElement>('speed')
const speedValue = $('speedValue')
const modelEl = $<HTMLSelectElement>('model')
const hotkeyEl = $<HTMLButtonElement>('hotkey')
const showPanelEl = $<HTMLInputElement>('showPanel')
const highlightEl = $<HTMLInputElement>('highlightInSource')
const autoCloseEl = $<HTMLInputElement>('autoClose')
const autoCloseRow = $('autoCloseRow')
const statusEl = $('status')

const STATUS: Record<EngineStatus, string> = {
  stopped: 'Stopped',
  loading: 'Loading…',
  ready: 'Ready',
  error: 'Error'
}

for (const [group, voices] of Object.entries(VOICES)) {
  const og = document.createElement('optgroup')
  og.label = group
  for (const v of voices) og.append(new Option(voiceLabel(v), v.id))
  voiceEl.append(og)
}

const SYMBOLS: Record<string, string> = { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Space: 'Space' }
/** "Alt+Shift+Space" → "⌥⇧ Space" */
function prettyHotkey(accel: string): string {
  const parts = accel.split('+')
  const key = parts.pop()!
  return parts.map((p) => SYMBOLS[p] ?? p).join('') + ' ' + key
}

function setSpeedLabel(speed: number): void {
  speedValue.textContent = `${speed.toFixed(2)}×`
  const fill = ((speed - Number(speedEl.min)) / (Number(speedEl.max) - Number(speedEl.min))) * 100
  speedEl.style.setProperty('--fill', `${fill}%`)
}

function render(s: Settings): void {
  voiceEl.value = s.voice
  speedEl.value = String(s.speed)
  setSpeedLabel(s.speed)
  modelEl.value = s.model
  if (!recording) hotkeyEl.textContent = prettyHotkey(s.hotkey)
  showPanelEl.checked = s.showPanel
  highlightEl.checked = s.highlightInSource
  autoCloseEl.checked = s.autoClosePanel
  autoCloseRow.classList.toggle('disabled', !s.showPanel)
}

function renderStatus(s: EngineStatus): void {
  statusEl.textContent = STATUS[s]
  statusEl.dataset.status = s
}

const save = async (patch: Partial<Settings>) => render(await api.setSettings(patch))

voiceEl.addEventListener('change', () => save({ voice: voiceEl.value }))
speedEl.addEventListener('input', () => setSpeedLabel(Number(speedEl.value)))
speedEl.addEventListener('change', () => save({ speed: Number(speedEl.value) }))
modelEl.addEventListener('change', () => save({ model: modelEl.value as ModelVariant }))
showPanelEl.addEventListener('change', () => save({ showPanel: showPanelEl.checked }))
highlightEl.addEventListener('change', () => save({ highlightInSource: highlightEl.checked }))
autoCloseEl.addEventListener('change', () => save({ autoClosePanel: autoCloseEl.checked }))
$('preview').addEventListener('click', () => api.preview())

// Hotkey recorder: click the keycap, then press a modifier+key combo (Esc cancels).
// Keyed by e.code (physical key): with Option held, e.key is the composed character.
const KEY_NAMES: Record<string, string> = {
  Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape',
  Enter: 'Return', Backspace: 'Backspace', Tab: 'Tab', Delete: 'Delete'
}
let recording = false

function setRecording(on: boolean): void {
  recording = on
  hotkeyEl.classList.toggle('recording', on)
  // Pause the global hotkey so pressing the current shortcut reaches this page.
  api.suspendHotkey(on)
  if (on) hotkeyEl.textContent = 'Type shortcut…'
  else void api.getSettings().then(render)
}

hotkeyEl.addEventListener('click', () => {
  if (!recording) setRecording(true)
})
window.addEventListener('blur', () => recording && setRecording(false))
// Listen on the window (capture phase): the button may not hold keyboard focus, and
// Space/Enter must not re-trigger its click while recording.
window.addEventListener(
  'keyup',
  (e) => {
    if (recording || e.target === hotkeyEl) e.preventDefault()
  },
  true
)
window.addEventListener(
  'keydown',
  (e) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.code === 'Escape' && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) return setRecording(false)
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return
    const parts: string[] = []
    if (e.metaKey) parts.push('Command')
    if (e.ctrlKey) parts.push('Control')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (!parts.length) return // a global hotkey needs a modifier
    const code = e.code
    const key =
      KEY_NAMES[code] ??
      (code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5) : /^F\d+$/.test(code) ? code : null)
    if (!key) return
    parts.push(key)
    recording = false
    hotkeyEl.classList.remove('recording')
    void save({ hotkey: parts.join('+') }).then(() => api.suspendHotkey(false))
  },
  true
)

api.onStatus(renderStatus)
api.getStatus().then(renderStatus)
api.getSettings().then(render)
