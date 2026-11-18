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
  if (process.platform === 'win32') return 'uv.exe'
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
  /** Per-user storage for the Windows model cache and managed Python. */
  dataDir?: string
}

/**
 * Manages the Python synthesis sidecar. Emits:
 *   'status' (EngineStatus), 'chunk' (Chunk), 'done' (id), 'error' (id | null, message)
 */
export class KokoroEngine extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private status: EngineStatus = 'stopped'
  private model: ModelVariant
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retried = false

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
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.setStatus('loading')
    const { pythonDir, uvPath, envDir, dataDir } = this.opts
    const windows = process.platform === 'win32'
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1' }
    const args = ['run', '--project', windows ? join(pythonDir, 'windows') : pythonDir]
    if (envDir) {
      // Packaged app: Resources is read-only, so keep the venv elsewhere and never touch the lockfile.
      env.UV_PROJECT_ENVIRONMENT = envDir
      args.push('--frozen')
    }
    if (windows) {
      env.PYTHONIOENCODING = 'utf-8'
      env.HF_HUB_DISABLE_TELEMETRY = '1'
      env.HF_HUB_ETAG_TIMEOUT = '2'
      if (dataDir) env.HF_HOME = join(dataDir, 'models')
      if (envDir && dataDir) {
        env.UV_CACHE_DIR = join(dataDir, 'python-cache')
        env.UV_PYTHON_INSTALL_DIR = join(dataDir, 'python-runtime')
      }
      args.push('--managed-python', 'python', join(pythonDir, 'kokoro_windows.py'))
    } else {
      args.push('python', join(pythonDir, 'kokoro_server.py'), '--model', MODEL_IDS[this.model])
      if (this.model === 'fp32') args.push('--dtype', 'float32')
    }
    const proc = spawn(uvPath ?? findUv(), args, { cwd: pythonDir, env, windowsHide: true })
    this.proc = proc

    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (this.proc === proc) this.handleLine(line)
    })
    let launchError: Error | undefined
    proc.on('error', (error) => { launchError = error })
    proc.stdin.on('error', (error) => console.error(`[kokoro] engine stdin: ${error.message}`))
    proc.stderr.on('data', (d) => console.error(`[kokoro] ${String(d).trimEnd()}`))
    proc.on('close', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      const retry = !windows || !this.retried
      if (retry) {
        this.retried = true
        this.retryTimer = setTimeout(() => this.start(), 2000)
      }
      this.setStatus('error')
      const detail = launchError?.message ?? `exit code ${code}`
      this.emit('error', null, `Kokoro engine stopped (${detail}). ${retry ? 'Restarting…' : 'Read again to retry.'}`)
    })
  }

  stop(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const proc = this.proc
    this.proc = null
    if (process.platform === 'win32' && proc?.pid) {
      // uv launches a separate Python process on Windows. Terminate the entire sidecar tree.
      const kill = spawn('taskkill.exe', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      kill.on('error', () => proc.kill())
    } else {
      proc?.kill()
    }
  }

  setModel(model: ModelVariant): void {
    if (model === this.model) return
    this.model = model
    this.stop()
    this.start()
  }

  speak(id: string, text: string, voice: string, speed: number, joinLines: boolean, expandWords: boolean, startSeq = 0): void {
    if (!this.proc) {
      this.retried = false
      this.start()
    }
    this.send({ id, cmd: 'speak', text, voice, speed, joinLines, expandWords, startSeq })
  }

  setSpeed(id: string, speed: number): void {
    this.send({ id, cmd: 'speed', speed })
  }

  cancel(id: string): void {
    this.send({ id, cmd: 'cancel' })
  }

  private send(msg: object): void {
    const stdin = this.proc?.stdin
    if (stdin?.writable) stdin.write(JSON.stringify(msg) + '\n')
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
        this.retried = false
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
