import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface Capture {
  text: string
  /** True if the source app can report word positions for in-place highlighting. */
  sourceHighlight: boolean
}

/**
 * Manages the native kokoro-helper (native/helper.swift): reads the selection via
 * the Accessibility API and draws the in-place word highlight. Never uses the clipboard.
 */
export class AccessibilityHelper {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending: ((msg: any) => void) | null = null

  constructor(private path: string) {}

  start(): void {
    if (this.proc) return
    const proc = spawn(this.path, [])
    this.proc = proc
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.type === 'capture') {
        this.pending?.(msg)
        this.pending = null
      }
    })
    proc.stderr.on('data', (d) => console.log(`[helper] ${String(d).trimEnd()}`))
    proc.on('exit', (code) => {
      console.error(`[helper] exited (code ${code})`)
      this.proc = null
      this.pending?.({ ok: false, error: 'crashed' })
      this.pending = null
    })
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }

  capture(): Promise<Capture> {
    this.start()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error('Timed out reading the selection.'))
      }, 5000)
      this.pending = (msg) => {
        clearTimeout(timer)
        if (msg.ok) resolve({ text: msg.text, sourceHighlight: msg.sourceHighlight })
        else reject(new Error(CAPTURE_ERRORS[msg.error] ?? `Could not read the selection (${msg.error}).`))
      }
      this.send({ cmd: 'capture' })
    })
  }

  highlight(from: number, to: number, text: string): void {
    this.send({ cmd: 'highlight', from, to, text })
  }

  clear(): void {
    this.send({ cmd: 'clear' })
  }

  private send(msg: object): void {
    this.proc?.stdin.write(JSON.stringify(msg) + '\n')
  }
}

const CAPTURE_ERRORS: Record<string, string> = {
  untrusted: 'Accessibility permission required. Enable Kokoro Reader in System Settings → Privacy & Security → Accessibility.',
  noselection:
    "Couldn't read a selection from this app. Select some text first — some apps don't expose their selection to Accessibility.",
  crashed: 'The selection helper stopped unexpectedly; try again.'
}
