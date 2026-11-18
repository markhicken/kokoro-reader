import { Highlighter } from './highlight'
import { Player } from './player'
import '../overlay'

const api = window.kokoro
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const statusEl = $('status')
const pauseBtn = $<HTMLButtonElement>('pause')
const textEl = $('text')
const scroller = $('scroller')
const SKIP_SECONDS = 10

let jobId: string | null = null
let generationId: string | null = null
let speed = 1
let pendingSeek: { seq: number; fraction: number; wordOffset?: number } | undefined
const player = new Player()
let highlighter: Highlighter | null = null
let generationDone = false
let playbackStarted = false
let timer: ReturnType<typeof setInterval> | undefined

function setStatus(text: string): void {
  statusEl.textContent = text
}

function updateReadStatus(): void {
  const preparing = !playbackStarted || pendingSeek !== undefined
  document.body.classList.toggle('busy', !player.paused && preparing)
  setStatus(player.paused ? 'Paused' : preparing ? 'Preparing audio…' : 'Reading')
}

function reset(): void {
  clearInterval(timer)
  document.body.classList.remove('busy')
  player.stop()
  highlighter = null
  jobId = null
  generationId = null
  pendingSeek = undefined
  playbackStarted = false
}

// A timer (not requestAnimationFrame) so timing keeps running while the panel is hidden.
function tick(): void {
  if (!highlighter || !jobId) return
  if (!playbackStarted && player.started) {
    playbackStarted = true
    updateReadStatus()
    api.playbackStarted(jobId)
  }
  if (playbackStarted) {
    const word = highlighter.update(player.position)
    if (word) api.reportWord(jobId, word.from, word.to, word.text)
  }
  if (generationDone && !pendingSeek && player.drained) finish()
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

api.onReaderStart(({ id, text, speed: initialSpeed }) => {
  reset()
  jobId = id
  generationId = id
  speed = initialSpeed
  generationDone = false
  void player.begin().catch((error) => failPlayback(id, error))
  highlighter = new Highlighter(textEl, scroller, text)
  scroller.scrollTop = 0
  pauseBtn.textContent = '⏸'
  updateReadStatus()
  timer = setInterval(tick, 20)
})

api.onChunk((chunk) => {
  if (chunk.id !== jobId || chunk.generationId !== generationId || !highlighter) return
  try {
    const seek = pendingSeek
    if (seek) {
      player.discardFrom(seek.seq)
      highlighter.discardFrom(seek.seq)
    }
    const { start, duration } = player.enqueue(chunk, !seek)
    highlighter.addWords(chunk.seq, chunk.words, start)
    if (seek) {
      const wordStart = seek.wordOffset === undefined ? undefined : highlighter.startForOffset(seek.wordOffset)
      const target = wordStart ?? (chunk.seq === seek.seq ? start + seek.fraction * duration : start)
      player.seek(target)
      pendingSeek = undefined
      updateReadStatus()
    }
  } catch (error) {
    failPlayback(chunk.id, error)
  }
})

api.onDone((id, completedGeneration) => {
  if (id !== jobId || completedGeneration !== generationId) return
  pendingSeek = undefined
  generationDone = true
})

api.onReaderSpeed((id, nextSpeed) => {
  if (id === jobId) speed = nextSpeed
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
api.onPlaybackCommand((id, command) => {
  if (id !== jobId) return
  if (command === 'toggle') void togglePause()
  else skip(command === 'rewind' ? -SKIP_SECONDS : SKIP_SECONDS)
})

pauseBtn.addEventListener('click', togglePause)
$('stop').addEventListener('click', stop)

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stop()
  else if (e.key === ' ') {
    e.preventDefault()
    togglePause()
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && playbackStarted) {
    e.preventDefault()
    skip(e.key === 'ArrowLeft' ? -SKIP_SECONDS : SKIP_SECONDS)
  }
})

function skip(seconds: number): void {
  if (!jobId || !highlighter || !playbackStarted) return
  const target = Math.min(player.duration, Math.max(0, player.position + seconds))
  const word = highlighter.wordAt(target)
  const position = word?.start ?? target
  try {
    const chunk = player.chunkAt(position)
    if (chunk && (pendingSeek || player.needsRegeneration(chunk.seq, speed))) {
      const nextGeneration = crypto.randomUUID()
      pendingSeek = {
        seq: chunk.seq,
        fraction: (position - chunk.start) / chunk.duration,
        wordOffset: word?.from
      }
      generationId = nextGeneration
      generationDone = false
      player.hold(position)
      api.regenerateForSeek(jobId, nextGeneration, chunk.seq)
      updateReadStatus()
    } else {
      player.seek(position)
    }
    tick()
  } catch (error) {
    failPlayback(jobId, error)
  }
}

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
  api.playbackPaused(id, player.paused)
}

function stop(): void {
  reset()
  api.stop()
}
