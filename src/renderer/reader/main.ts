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
let firstAudioAt: number | undefined
let playbackStarted = false
let timer: ReturnType<typeof setInterval> | undefined

function setStatus(text: string): void {
  statusEl.textContent = text
}

function updateReadStatus(): void {
  document.body.classList.toggle('busy', !player.paused && !playbackStarted)
  setStatus(player.paused ? 'Paused' : playbackStarted ? 'Reading' : 'Preparing audio…')
}

function reset(): void {
  clearInterval(timer)
  document.body.classList.remove('busy')
  player.stop()
  highlighter = null
  jobId = null
  firstAudioAt = undefined
  playbackStarted = false
}

// A timer (not requestAnimationFrame) so timing keeps running while the panel is hidden.
function tick(): void {
  if (!highlighter || !jobId) return
  const t = player.outputTime
  if (!playbackStarted && firstAudioAt !== undefined && t >= firstAudioAt &&
    player.ctx.state === 'running' && !player.paused) {
    playbackStarted = true
    updateReadStatus()
    api.playbackStarted(jobId)
  }
  const word = highlighter.update(t)
  if (word) api.reportWord(jobId, word.from, word.to, word.text)
  if (generationDone && (firstAudioAt === undefined || t >= player.endTime)) finish()
}

function finish(): void {
  const id = jobId!
  reset()
  setStatus('Finished')
  api.finished(id)
}

function showReadError(message: string): void {
  reset()
  setStatus(`Error: ${message}`)
}

function failPlayback(id: string, error: unknown): void {
  if (id !== jobId) return
  const message = error instanceof Error ? error.message : String(error)
  showReadError(message)
  api.playbackFailed(id, message)
}

api.onReaderStart(({ id, text }) => {
  reset()
  jobId = id
  generationDone = false
  void player.begin().catch((error) => failPlayback(id, error))
  highlighter = new Highlighter(textEl, scroller, text)
  scroller.scrollTop = 0
  pauseBtn.textContent = '⏸'
  updateReadStatus()
  timer = setInterval(tick, 20)
})

api.onChunk((chunk) => {
  if (chunk.id !== jobId || !highlighter) return
  try {
    const { start } = player.enqueue(chunk.pcm, chunk.sr)
    firstAudioAt ??= start
    highlighter.addWords(chunk.words, start)
  } catch (error) {
    failPlayback(chunk.id, error)
  }
})

api.onDone((id) => {
  if (id !== jobId) return
  generationDone = true
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

api.onError(showReadError)

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
  const id = jobId
  if (!id) return
  try {
    await player.toggle()
  } catch (error) {
    failPlayback(id, error)
    return
  }
  if (id !== jobId) return
  pauseBtn.textContent = player.paused ? '▶' : '⏸'
  updateReadStatus()
}

function stop(): void {
  reset()
  api.stop()
}
