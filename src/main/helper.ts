import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Rectangle } from 'electron'

export interface Capture {
  text: string
  /** True if the source app can report word positions for in-place highlighting. */
  sourceHighlight: boolean
}

type CaptureReply = { type: 'capture' } & (
  | ({ ok: true } & Capture)
  | { ok: false; error: string; app?: string; detail?: string }
)
type HelperReply = CaptureReply | { type: 'rect'; request: number; bounds: Rectangle | null } |
  { type: 'hide' } | { type: 'status'; trusted: boolean }

/** Manages the native selection helper and its source highlighting commands. */
export class AccessibilityHelper {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending: ((msg: CaptureReply) => void) | null = null
  private nextRequest = 0
  private inFlight: number | null = null
  private nextWord: { from: number; to: number } | null = null
  private pendingStatus: ((trusted: boolean) => void)[] = []

  constructor(private path: string, private showWindowsHighlight?: (bounds: Rectangle | null) => void) {}

  start(): void {
    if (this.proc) return
    const proc = spawn(this.path, this.showWindowsHighlight ? [String(process.pid)] : [], { windowsHide: true })
    this.proc = proc
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (this.proc !== proc) return
      let msg: HelperReply
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.type === 'capture') {
        const pending = this.pending
        this.pending = null
        pending?.(msg)
      } else if (msg.type === 'hide') {
        this.showWindowsHighlight?.(null)
      } else if (msg.type === 'rect' && msg.request === this.inFlight) {
        this.inFlight = null
        this.showWindowsHighlight?.(msg.bounds)
        const word = this.nextWord
        this.nextWord = null
        if (word) this.highlight(word.from, word.to, '')
      } else if (msg.type === 'status') {
        this.pendingStatus.shift()?.(!!msg.trusted)
      }
    })
    // A write to a dead helper emits EPIPE here; without a listener it is an uncaught exception.
    proc.stdin.on('error', (e) => console.error(`[helper] stdin error: ${e.message}`))
    proc.on('error', (e) => console.error(`[helper] spawn error: ${e.message}`))
    proc.stderr.on('data', (d) => console.log(`[helper] ${String(d).trimEnd()}`))
    proc.on('close', (code) => {
      if (this.proc !== proc) return
      console.error(`[helper] exited (code ${code})`)
      this.proc = null
      this.clear()
      this.pending?.({ type: 'capture', ok: false, error: 'crashed' })
      this.pending = null
      for (const resolve of this.pendingStatus.splice(0)) resolve(true)
    })
  }

  /** Respawn so the helper picks up a freshly granted permission instead of its pre-grant state. */
  restart(): void {
    this.stop()
    this.pending?.({ type: 'capture', ok: false, error: 'crashed' })
    this.pending = null
    for (const resolve of this.pendingStatus.splice(0)) resolve(true)
    this.start()
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.clear()
  }

  capture(fromTray = false): Promise<Capture> {
    this.start()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        this.stop()
        reject(new Error('Timed out reading the selection.'))
      }, 5000)
      this.pending = (msg) => {
        clearTimeout(timer)
        if (msg.ok) resolve({ text: msg.text, sourceHighlight: msg.sourceHighlight })
        else {
          let message = msg.error === 'noselection' && this.showWindowsHighlight
            ? 'Couldn’t read a selection. Select text in an app that exposes it to Windows UI Automation.'
            : CAPTURE_ERRORS[msg.error] ?? `Could not read the selection (${msg.error}).`
          if (msg.error === 'noselection' && msg.app) message += ` (${msg.app}: ${msg.detail})`
          reject(Object.assign(new Error(message), { code: msg.error }))
        }
      }
      this.send(this.showWindowsHighlight ? (fromTray ? 'capture tray' : 'capture') : { cmd: 'capture' })
    })
  }

  /** Whether the helper's Accessibility calls actually work (false for missing, revoked or stale grants). */
  checkTrusted(): Promise<boolean> {
    this.start()
    return new Promise((resolve) => {
      const done = (trusted: boolean) => {
        clearTimeout(timer)
        resolve(trusted)
      }
      const timer = setTimeout(() => {
        this.pendingStatus = this.pendingStatus.filter((f) => f !== done)
        resolve(true) // an unresponsive helper says nothing about the grant; don't raise a false alarm
      }, 3000)
      this.pendingStatus.push(done)
      this.send({ cmd: 'status' })
    })
  }

  highlight(from: number, to: number, text: string): void {
    if (this.showWindowsHighlight) {
      if (!this.proc) return
      if (this.inFlight !== null) {
        this.nextWord = { from, to }
        return
      }
      this.inFlight = ++this.nextRequest
      this.send(`highlight ${this.inFlight} ${from} ${to}`)
    } else {
      this.send({ cmd: 'highlight', from, to, text })
    }
  }

  clear(): void {
    this.inFlight = null
    this.nextWord = null
    this.showWindowsHighlight?.(null)
    this.send(this.showWindowsHighlight ? 'clear' : { cmd: 'clear' })
  }

  private send(msg: object | string): void {
    const stdin = this.proc?.stdin
    if (stdin?.writable) stdin.write((typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n')
  }
}

const CAPTURE_ERRORS: Record<string, string> = {
  untrusted: 'Accessibility permission required. Enable Kokoro Reader in System Settings → Privacy & Security → Accessibility.',
  noselection:
    "Couldn't read a selection from this app. Select some text first — some apps don't expose their selection to Accessibility.",
  crashed: 'The selection helper stopped unexpectedly; try again.'
}
