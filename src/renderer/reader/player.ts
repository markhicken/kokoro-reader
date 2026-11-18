import type { Chunk } from '../../shared/types'

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

type BufferedPosition = { seq: number; start: number; duration: number }
type BufferedChunk = BufferedPosition & { speed: number; buffer: AudioBuffer }
type ScheduledChunk = { time: number; position: number; duration: number }

export class Player {
  readonly ctx = new AudioContext({ sampleRate: 24000, latencyHint: 'playback' })
  private nextStart = 0
  private sources = new Set<AudioBufferSourceNode>()
  private chunks: BufferedChunk[] = []
  private scheduled: ScheduledChunk[] = []
  private scheduledIndex = 0
  private seekPosition = 0
  private bufferedEnd = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private userPaused = false
  private cold = true

  /** Prepare for a new read: stop anything playing and make sure the device is awake. */
  async begin(): Promise<void> {
    this.clearTrack()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.userPaused = false
    if (this.ctx.state !== 'running') {
      this.cold = true
      await this.ctx.resume()
    }
  }

  /** Keep the decoded chunk for seeks and return its start within the selection. */
  enqueue(data: Chunk, play = true): BufferedPosition {
    const bytes = Uint8Array.from(atob(data.pcm), (c) => c.charCodeAt(0))
    const samples = new Float32Array(bytes.buffer)
    const buffer = this.ctx.createBuffer(1, samples.length, data.sr)
    buffer.copyToChannel(samples, 0)
    const chunk = { seq: data.seq, start: this.bufferedEnd, duration: buffer.duration, speed: data.speed, buffer }
    this.chunks.push(chunk)
    this.bufferedEnd += buffer.duration
    if (play) this.schedule(chunk, 0)
    return chunk
  }

  private schedule({ start, buffer }: BufferedChunk, offset: number): void {
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.ctx.destination)
    const lead = this.cold ? COLD_LEAD_S : WARM_LEAD_S
    this.cold = false
    const time = Math.max(this.nextStart, this.ctx.currentTime + lead)
    const duration = buffer.duration - offset
    src.start(time, offset)
    src.onended = () => this.sources.delete(src)
    this.sources.add(src)
    this.scheduled.push({ time, position: start + offset, duration })
    this.nextStart = time + duration
  }

  get duration(): number {
    return this.bufferedEnd
  }

  get position(): number {
    if (!this.scheduled.length) return this.seekPosition
    const time = this.outputTime
    while (this.scheduledIndex > 0 && this.scheduled[this.scheduledIndex].time > time) this.scheduledIndex--
    while (this.scheduledIndex + 1 < this.scheduled.length &&
      this.scheduled[this.scheduledIndex + 1].time <= time) this.scheduledIndex++
    const chunk = this.scheduled[this.scheduledIndex]
    return chunk.position + Math.min(chunk.duration, Math.max(0, time - chunk.time))
  }

  get started(): boolean {
    return this.scheduled.length > 0 && this.ctx.state === 'running' && !this.userPaused &&
      this.outputTime >= this.scheduled[0].time
  }

  get drained(): boolean {
    return !this.scheduled.length || this.outputTime >= this.nextStart
  }

  /** The position playing at the output device, on the same clock used to schedule audio. */
  private get outputTime(): number {
    const { contextTime, performanceTime } = this.ctx.getOutputTimestamp()
    return (performanceTime ?? 0) > 0 && contextTime !== undefined ? contextTime : this.ctx.currentTime
  }

  get paused(): boolean {
    return this.userPaused
  }

  chunkAt(position: number): BufferedPosition | undefined {
    return this.chunks.find((chunk) => position < chunk.start + chunk.duration) ?? this.chunks.at(-1)
  }

  needsRegeneration(seq: number, speed: number): boolean {
    return this.chunks.some((chunk) => chunk.seq >= seq && chunk.speed !== speed)
  }

  hold(position: number): void {
    this.clearSchedule()
    this.seekPosition = Math.min(this.bufferedEnd, Math.max(0, position))
  }

  discardFrom(seq: number): void {
    const index = this.chunks.findIndex((chunk) => chunk.seq >= seq)
    if (index === -1) return
    this.bufferedEnd = this.chunks[index].start
    this.chunks.length = index
    this.hold(this.bufferedEnd)
  }

  seek(position: number): void {
    this.hold(position)
    for (const chunk of this.chunks) {
      const offset = Math.max(0, this.seekPosition - chunk.start)
      if (offset < chunk.buffer.duration) this.schedule(chunk, offset)
    }
  }

  async toggle(): Promise<void> {
    this.userPaused = !this.userPaused
    await (this.userPaused ? this.ctx.suspend() : this.ctx.resume())
  }

  /** Stop playback but keep the context (and output device) alive for a while. */
  stop(): void {
    this.clearTrack()
    if (this.userPaused) {
      this.userPaused = false
      void this.ctx.resume()
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.ctx.suspend(), IDLE_SUSPEND_MS)
  }

  private clearTrack(): void {
    this.clearSchedule()
    this.chunks = []
    this.seekPosition = 0
    this.bufferedEnd = 0
  }

  private clearSchedule(): void {
    for (const s of this.sources) s.stop()
    this.sources.clear()
    this.scheduled = []
    this.scheduledIndex = 0
    this.nextStart = 0
  }
}
