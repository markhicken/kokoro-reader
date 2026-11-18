import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [task, ...args] = process.argv.slice(2)
const windows = process.platform === 'win32' && process.arch === 'x64'
const mac = process.platform === 'darwin' && process.arch === 'arm64'
if (!windows && !mac) throw new Error('Build on Windows x64 or Apple Silicon macOS.')

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout
}

const bin = join('build', 'bin')
switch (task) {
  case 'install':
    run(process.execPath, ['node_modules/electron/install.js'])
    run(windows ? 'uv.exe' : 'uv', ['sync', '--project', windows ? 'python/windows' : 'python', '--locked',
      ...(windows ? ['--managed-python'] : [])])
    break
  case 'native':
    mkdirSync(bin, { recursive: true })
    if (windows) run('cmd.exe', ['/d', '/c', 'scripts\\build-windows.cmd'])
    else run('swiftc', ['-O', 'native/helper.swift', '-o', join(bin, 'kokoro-helper')])
    break
  case 'dist': {
    run(process.execPath, [process.env.npm_execpath, 'run', 'build'])
    const uv = (windows ? run('where.exe', ['uv.exe'], true) : run('/bin/sh', ['-c', 'command -v uv'], true))
      .trim().split(/\r?\n/)[0]
    copyFileSync(uv, join(bin, windows ? 'uv.exe' : 'uv'))
    run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', windows ? '--win' : '--mac', ...args])
    break
  }
  default:
    throw new Error(`Unknown build task: ${task}`)
}
