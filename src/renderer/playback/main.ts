import '../overlay'

const api = window.kokoro
const toggle = document.getElementById('toggle')!

for (const command of ['rewind', 'toggle', 'forward', 'stop'] as const) {
  document.getElementById(command)!.addEventListener('click', () => api.controlPlayback(command))
}

api.onPlaybackPaused((paused) => {
  const label = paused ? 'Play' : 'Pause'
  toggle.classList.toggle('paused', paused)
  toggle.title = label
  toggle.setAttribute('aria-label', label)
})
