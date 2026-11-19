import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const windows = process.platform === 'win32'
const dev = process.argv.includes('--dev')
const windowsDir = process.arch === 'x64' ? 'win-unpacked' : `win-${process.arch}-unpacked`
const resources = resolve(windows ? `dist/${windowsDir}/resources` : 'dist/mac-arm64/Kokoro Reader.app/Contents/Resources')
const pythonDir = dev ? resolve('python') : join(resources, 'python')
const uv = dev ? (windows ? 'uv.exe' : 'uv') : join(resources, 'bin', windows ? 'uv.exe' : 'uv')
mkdirSync('build/bin', { recursive: true })
const scratch = realpathSync('build/bin')
const temp = mkdtempSync(join(scratch, 'smoke-'))

async function runEngine(offline, exercise) {
  let stderr = ''
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    HF_HOME: process.env.HF_HOME ?? join(temp, 'models'),
    HF_HUB_DISABLE_TELEMETRY: '1',
    ...(offline && { HF_HUB_OFFLINE: '1', UV_OFFLINE: '1' })
  }
  if (!dev) env.UV_PROJECT_ENVIRONMENT = join(temp, 'python-env')
  if (!dev && windows) {
    env.UV_CACHE_DIR = process.env.UV_CACHE_DIR ?? join(temp, 'python-cache')
    env.UV_PYTHON_INSTALL_DIR = process.env.UV_PYTHON_INSTALL_DIR ?? join(temp, 'python-runtime')
  }
  const args = ['run', '--project', windows ? join(pythonDir, 'windows') : pythonDir, '--frozen']
  if (windows) args.push('--managed-python')
  args.push('python', join(pythonDir, windows ? 'kokoro_windows.py' : 'kokoro_server.py'))
  const proc = spawn(uv, args, { cwd: pythonDir, env, windowsHide: true })
  proc.stdin.on('error', (error) => { stderr += `\n${error.message}` })
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000) })
  proc.on('error', (error) => { stderr += `\n${error.message}` })
  const closed = new Promise((resolve) => proc.on('close', resolve))
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]()
  const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n')
  const next = async () => {
    const line = await lines.next()
    assert(!line.done, 'The sidecar exited before returning the expected message.')
    const msg = JSON.parse(line.value)
    assert.notEqual(msg.type, 'error', msg.message)
    return msg
  }
  const timer = setTimeout(() => {
    if (windows && proc.pid) spawn('taskkill.exe', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true })
    else proc.kill()
  }, 8 * 60_000)
  try {
    const ready = await next()
    assert.equal(ready.type, 'ready')
    assert.equal(ready.sr, 24000)
    await exercise(send, next)
    proc.stdin.end()
    assert.equal(await closed, 0, 'Expected the sidecar to shut down cleanly.')
  } catch (error) {
    proc.stdin.end()
    await closed
    throw new Error(`${error.message}\n${stderr}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

function checkChunk(message, id, seq) {
  assert.equal(message.type, 'chunk')
  assert.equal(message.id, id)
  assert.equal(message.seq, seq)
  assert(Number.isFinite(message.speed) && message.speed > 0)
  assert.equal(message.sr, 24000)
  const pcm = Buffer.from(message.pcm, 'base64')
  assert(pcm.length > 0 && pcm.length % 4 === 0)
  let audible = false
  for (let offset = 0; offset < pcm.length; offset += 4) {
    const sample = pcm.readFloatLE(offset)
    assert(Number.isFinite(sample))
    if (Math.abs(sample) > 0.0001) audible = true
  }
  assert(audible, 'Expected non-silent audio')
  assert(message.words.length > 0, 'Expected word timings')
  let previous = 0
  for (const word of message.words) {
    assert(word.text.length > 0 && Number.isFinite(word.start) && Number.isFinite(word.end))
    assert(word.start >= previous && word.end >= word.start, 'Expected ordered word timings')
    previous = word.start
  }
}

async function readAll(send, next, id, text, voice) {
  send({ cmd: 'speak', id, text, voice, speed: 1 })
  let chunks = 0
  for (let message = await next(); message.type !== 'done'; message = await next()) {
    checkChunk(message, id, chunks++)
  }
  assert(chunks > 0, 'Expected streamed audio')
  return chunks
}

try {
  const english = 'Dr. Lee said, “The café opens at nine.”'
  await runEngine(false, async (send, next) => {
    const longText = Array(12).fill(english).join('\n\n')
    send({ cmd: 'speak', id: 'cancel', text: longText, voice: 'af_heart' })
    checkChunk(await next(), 'cancel', 0)
    send({ cmd: 'cancel', id: 'cancel' })
    let message = await next()
    let chunks = 1
    while (message.type === 'chunk') {
      checkChunk(message, 'cancel', chunks++)
      message = await next()
    }
    assert.equal(message.id, 'cancel')
    assert.equal(message.type, 'done')
    assert(chunks < 12, 'Cancellation must stop a long selection before it finishes.')
    assert.equal(await readAll(send, next, 'after-cancel', `${english}\n\nThe end.`, 'af_heart'), 2)
    send({ cmd: 'speak', id: 'live-speed', text: longText, voice: 'af_heart', speed: 1 })
    const first = await next()
    checkChunk(first, 'live-speed', 0)
    assert.equal(first.speed, 1)
    send({ cmd: 'speed', id: 'live-speed', speed: 1.5 })
    let seq = 1
    let fast = false
    for (let message = await next(); message.type !== 'done'; message = await next()) {
      checkChunk(message, 'live-speed', seq++)
      if (message.speed === 1.5 && !fast) {
        assert(Buffer.from(message.pcm, 'base64').length < Buffer.from(first.pcm, 'base64').length)
        fast = true
        send({ cmd: 'cancel', id: 'live-speed' })
      }
    }
    assert(fast, 'An active request should use the updated speed for a later chunk')
    send({ cmd: 'speak', id: 'regenerate', text: longText, voice: 'af_heart', speed: 1.25, startSeq: 10 })
    for (const seq of [10, 11]) {
      const regenerated = await next()
      checkChunk(regenerated, 'regenerate', seq)
      assert.equal(regenerated.speed, 1.25)
    }
    assert.deepEqual(await next(), { type: 'done', id: 'regenerate' })
    const plainText = 'The café charges $12 for coffee.'
    send({ cmd: 'speak', id: 'plain', text: plainText, voice: 'af_heart' })
    const plain = await next()
    checkChunk(plain, 'plain', 0)
    assert.deepEqual(await next(), { type: 'done', id: 'plain' })
    send({ cmd: 'speak', id: 'decorated', text: '▪ • The café■charges $12 for coffee. · ☑️', voice: 'af_heart' })
    const decorated = await next()
    checkChunk(decorated, 'decorated', 0)
    assert.deepEqual(decorated.words.map((word) => word.text), plain.words.map((word) => word.text))
    assert.deepEqual(await next(), { type: 'done', id: 'decorated' })
    send({ cmd: 'speak', id: 'symbols-only', text: '• ■ · ☑️', voice: 'af_heart' })
    assert.deepEqual(await next(), { type: 'done', id: 'symbols-only' })
    if (windows) await readAll(send, next, 'spanish', '¿Cómo estás? La música empieza a las nueve.', 'ef_dora')
  })
  await runEngine(true, (send, next) => readAll(send, next, 'offline', english, 'af_heart'))
  console.log('Verified timed speech, streaming, cancellation, live speed changes, chunk regeneration, symbol filtering, and offline relaunch.')
} finally {
  if (dirname(realpathSync(temp)) === scratch) rmSync(temp, { recursive: true, force: true })
}
