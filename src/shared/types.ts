export type ModelVariant = 'bf16' | '8bit' | '6bit' | '4bit'

export interface Settings {
  voice: string
  speed: number
  model: ModelVariant
  hotkey: string
  autoClosePanel: boolean
  /** Show the floating reader panel while reading. */
  showPanel: boolean
  /** Highlight the spoken word in the app the text was selected from. */
  highlightInSource: boolean
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
  sr: number
  pcm: string // base64 float32 little-endian
  words: Word[]
}

export type EngineStatus = 'stopped' | 'loading' | 'ready' | 'error'

export interface KokoroApi {
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  preview(): void
  suspendHotkey(suspend: boolean): void
  stop(): void
  reportWord(id: string, from: number, to: number, text: string): void
  finished(id: string): void
  onReaderStart(cb: (job: { id: string; text: string }) => void): void
  onChunk(cb: (chunk: Chunk) => void): void
  onDone(cb: (id: string) => void): void
  onStop(cb: () => void): void
  onMessage(cb: (message: string) => void): void
  onError(cb: (message: string) => void): void
  onStatus(cb: (status: EngineStatus) => void): void
  getStatus(): Promise<EngineStatus>
}
