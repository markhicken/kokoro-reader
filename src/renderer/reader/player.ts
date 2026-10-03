/**
 * Gapless sequential playback of PCM chunks via Web Audio.
 *
 * One AudioContext is kept alive across reads: opening a fresh output stream makes
 * some devices (HDMI receivers, Bluetooth) clip the first fraction of a second.
 * After IDLE_SUSPEND_MS without a read the context is suspended to release the
 * device; the next read then gets a longer lead-in while the device wakes up.
 */
const IDLE_SUSPEND_MS = 2 * 60 * 1000
const WARM_LEAD_S = 0.1
const COLD_LEAD_S = 0.6

export class Player {
  readonly ctx = new AudioContext({ sampleRate: 24000, latencyHint: 'playback' })
  private nextStart = 0
  private sources = new Set<AudioBufferSourceNode>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private userPaused = false
  private cold = true

  /** Prepare for a new read: stop anything playing and make sure the device is awake. */
  async begin(): Promise<void> {
    this.clear()
    this.nextStart = 0
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.userPaused = false
    if (this.ctx.state !== 'running') {
      this.cold = true
      await this.ctx.resume()
    }
  }

  /** Schedule a chunk; returns its start/end on the context clock. */
  enqueue(pcmBase64: string, sampleRate: number): { start: number; end: number } {
    const bytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0))
    const samples = new Float32Array(bytes.buffer)
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate)
    buffer.copyToChannel(samples, 0)

    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.ctx.destination)
    const lead = this.cold ? COLD_LEAD_S : WARM_LEAD_S
    this.cold = false
    const start = Math.max(this.nextStart, this.ctx.currentTime + lead)
    src.start(start)
    src.onended = () => this.sources.delete(src)
    this.sources.add(src)
    this.nextStart = start + buffer.duration
    return { start, end: this.nextStart }
  }

  get endTime(): number {
    return this.nextStart
  }

  get paused(): boolean {
    return this.userPaused
  }

  async toggle(): Promise<void> {
    this.userPaused = !this.userPaused
    await (this.userPaused ? this.ctx.suspend() : this.ctx.resume())
  }

  /** Stop playback but keep the context (and output device) alive for a while. */
  stop(): void {
    this.clear()
    if (this.userPaused) {
      this.userPaused = false
      void this.ctx.resume()
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.ctx.suspend(), IDLE_SUSPEND_MS)
  }

  private clear(): void {
    for (const s of this.sources) s.stop()
    this.sources.clear()
  }
}
