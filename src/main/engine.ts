import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Chunk, EngineStatus, ModelVariant } from '../shared/types'

const MODEL_IDS: Record<ModelVariant, string> = {
  // No fp32 repo exists; the server upcasts bf16 weights (see --dtype).
  fp32: 'mlx-community/Kokoro-82M-bf16',
  bf16: 'mlx-community/Kokoro-82M-bf16',
  '8bit': 'mlx-community/Kokoro-82M-8bit',
  '6bit': 'mlx-community/Kokoro-82M-6bit',
  '4bit': 'mlx-community/Kokoro-82M-4bit'
}

function findUv(): string {
  for (const p of [join(homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) {
    if (existsSync(p)) return p
  }
  return 'uv'
}

export interface EngineOptions {
  /** Directory containing kokoro_server.py, pyproject.toml and uv.lock. */
  pythonDir: string
  /** uv binary; defaults to a uv found on the system. */
  uvPath?: string
  /** Where uv should create the virtualenv; defaults to pythonDir/.venv. */
  envDir?: string
}

/**
 * Manages the Python mlx-audio sidecar. Emits:
 *   'status' (EngineStatus), 'chunk' (Chunk), 'done' (id), 'error' (id | null, message)
 */
export class KokoroEngine extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private status: EngineStatus = 'stopped'
  private model: ModelVariant
  private stopping = false

  constructor(
    private opts: EngineOptions,
    model: ModelVariant
  ) {
    super()
    this.model = model
  }

  getStatus(): EngineStatus {
    return this.status
  }

  start(): void {
    if (this.proc) return
    this.stopping = false
    this.setStatus('loading')
    const { pythonDir, uvPath, envDir } = this.opts
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1' }
    const args = ['run', '--project', pythonDir]
    if (envDir) {
      // Packaged app: Resources is read-only, so keep the venv elsewhere and never touch the lockfile.
      env.UV_PROJECT_ENVIRONMENT = envDir
      args.push('--frozen')
    }
    args.push('python', join(pythonDir, 'kokoro_server.py'), '--model', MODEL_IDS[this.model])
    if (this.model === 'fp32') args.push('--dtype', 'float32')
    const proc = spawn(uvPath ?? findUv(), args, { cwd: pythonDir, env })
    this.proc = proc

    createInterface({ input: proc.stdout }).on('line', (line) => this.handleLine(line))
    proc.stderr.on('data', (d) => console.error(`[kokoro] ${String(d).trimEnd()}`))
    proc.on('exit', (code) => {
      this.proc = null
      if (this.stopping) {
        this.setStatus('stopped')
        return
      }
      this.setStatus('error')
      this.emit('error', null, `Kokoro engine exited (code ${code}); restarting`)
      setTimeout(() => this.start(), 2000)
    })
  }

  stop(): void {
    this.stopping = true
    this.proc?.kill()
    this.proc = null
  }

  setModel(model: ModelVariant): void {
    if (model === this.model) return
    this.model = model
    this.stop()
    this.start()
  }

  speak(id: string, text: string, voice: string, speed: number, joinLines: boolean, expandWords: boolean): void {
    this.send({ id, cmd: 'speak', text, voice, speed, joinLines, expandWords })
  }

  cancel(id: string): void {
    this.send({ id, cmd: 'cancel' })
  }

  private send(msg: object): void {
    this.proc?.stdin.write(JSON.stringify(msg) + '\n')
  }

  private setStatus(s: EngineStatus): void {
    this.status = s
    this.emit('status', s)
  }

  private handleLine(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    switch (msg.type) {
      case 'ready':
        this.setStatus('ready')
        break
      case 'chunk':
        this.emit('chunk', msg as Chunk)
        break
      case 'done':
        this.emit('done', msg.id)
        break
      case 'error':
        this.emit('error', msg.id, msg.message)
        break
    }
  }
}
