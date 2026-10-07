import type { EngineStatus } from '../../shared/types'
import { Highlighter } from './highlight'
import { Player } from './player'

const api = window.kokoro
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const statusEl = $('status')
const pauseBtn = $<HTMLButtonElement>('pause')
const textEl = $('text')
const scroller = $('scroller')

let jobId: string | null = null
const player = new Player()
let highlighter: Highlighter | null = null
let generationDone = false
let timer: ReturnType<typeof setInterval> | undefined
let engineStatus: EngineStatus = 'loading'

function setStatus(text: string): void {
  statusEl.textContent = text
}

/** Show the spinner while audio is still being generated. */
function setBusy(busy: boolean): void {
  document.body.classList.toggle('busy', busy)
}

function reset(): void {
  clearInterval(timer)
  setBusy(false)
  player.stop()
  highlighter = null
  jobId = null
}

// A timer (not requestAnimationFrame) so timing keeps running while the panel is hidden.
function tick(): void {
  if (!highlighter || !jobId) return
  const t = player.ctx.currentTime
  const word = highlighter.update(t)
  if (word) api.reportWord(jobId, word.from, word.to, word.text)
  if (generationDone && t >= player.endTime) finish()
}

function finish(): void {
  const id = jobId!
  reset()
  setStatus('Finished')
  api.finished(id)
}

api.onStatus((s) => {
  engineStatus = s
  if (s === 'loading') setStatus('Loading model…')
})

api.onReaderStart(({ id, text }) => {
  reset()
  jobId = id
  generationDone = false
  setBusy(true)
  void player.begin()
  highlighter = new Highlighter(textEl, scroller, text)
  scroller.scrollTop = 0
  pauseBtn.textContent = '⏸'
  setStatus(engineStatus === 'ready' ? 'Generating…' : 'Loading model…')
  timer = setInterval(tick, 20)
})

api.onChunk((chunk) => {
  if (chunk.id !== jobId || !highlighter) return
  const { start } = player.enqueue(chunk.pcm, chunk.sr)
  highlighter.addWords(chunk.words, start)
  setStatus('Reading')
})

api.onDone((id) => {
  if (id !== jobId) return
  generationDone = true
  setBusy(false)
})

api.onStop(() => {
  reset()
  setStatus('Stopped')
})

api.onMessage((message) => {
  reset()
  textEl.textContent = message
  setStatus('Kokoro')
})

api.onError((message) => {
  setBusy(false)
  setStatus(`Error: ${message}`)
})

pauseBtn.addEventListener('click', togglePause)
$('stop').addEventListener('click', stop)

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stop()
  else if (e.key === ' ') {
    e.preventDefault()
    togglePause()
  }
})

async function togglePause(): Promise<void> {
  if (!jobId) return
  await player.toggle()
  pauseBtn.textContent = player.paused ? '▶' : '⏸'
  setStatus(player.paused ? 'Paused' : 'Reading')
}

function stop(): void {
  reset()
  api.stop()
}

api.getStatus().then((s) => (engineStatus = s))
