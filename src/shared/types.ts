export type ModelVariant = 'fp32' | 'bf16' | '8bit' | '6bit' | '4bit'

export interface Settings {
  voice: string
  speed: number
  model: ModelVariant
  hotkey: string
  autoClosePanel: boolean
  /** Show the floating reader panel while reading. */
  showPanel: boolean
  /** Show a centered status while waiting for audio to begin. */
  showPreparingOverlay: boolean
  showPlaybackControls: boolean
  playbackControlsPosition: { x: number; y: number } | null
  /** Highlight the spoken word in the app the text was selected from. */
  highlightInSource: boolean
  /** Merge hard-wrapped lines into one sentence before speaking. */
  joinLines: boolean
  /** Expand abbreviations (Dr., e.g., ...) into words before speaking. */
  expandWords: boolean
  panelBounds?: { x: number; y: number; width: number; height: number }
}

export interface Word {
  text: string
  start: number
  end: number
}

export interface Chunk {
  id: string
  seq: number
  speed: number
  sr: number
  pcm: string // base64 float32 little-endian
  words: Word[]
}

export type ReaderChunk = Chunk & { generationId: string }

export type EngineStatus = 'stopped' | 'loading' | 'ready' | 'error'
export type PlaybackCommand = 'rewind' | 'toggle' | 'forward' | 'stop'

export interface KokoroApi {
  windows: boolean
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  preview(): void
  suspendHotkey(suspend: boolean): void
  stop(): void
  playbackStarted(id: string): void
  playbackPaused(id: string, paused: boolean): void
  playbackFailed(id: string, message: string): void
  controlPlayback(command: PlaybackCommand): void
  regenerateForSeek(id: string, generationId: string, startSeq: number): void
  reportWord(id: string, from: number, to: number, text: string): void
  finished(id: string): void
  onReaderStart(cb: (job: { id: string; text: string; speed: number }) => void): void
  onReaderSpeed(cb: (id: string, speed: number) => void): void
  onChunk(cb: (chunk: ReaderChunk) => void): void
  onDone(cb: (id: string, generationId: string) => void): void
  onStop(cb: () => void): void
  onMessage(cb: (message: string) => void): void
  onError(cb: (message: string) => void): void
  onStatus(cb: (status: EngineStatus) => void): void
  onPreparationShortcut(cb: (hotkey: string | null) => void): void
  onPlaybackPaused(cb: (paused: boolean) => void): void
  onPlaybackCommand(cb: (id: string, command: Exclude<PlaybackCommand, 'stop'>) => void): void
  getStatus(): Promise<EngineStatus>
}
