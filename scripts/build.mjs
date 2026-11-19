import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
// `npm run build -- <options>` passes electron-builder options straight through.
const task = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'build'
const args = task === argv[0] ? argv.slice(1) : argv
const windows = process.platform === 'win32' && ['x64', 'arm64'].includes(process.arch)
const mac = process.platform === 'darwin' && process.arch === 'arm64'
if (!windows && !mac) throw new Error('Build on Windows x64/ARM64 or Apple Silicon macOS.')

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

function buildNative() {
  mkdirSync(bin, { recursive: true })
  if (windows) run('cmd.exe', ['/d', '/c', 'scripts\\build-windows.cmd', process.arch])
  else run('swiftc', ['-O', 'native/helper.swift', '-o', join(bin, 'kokoro-helper')])
}

switch (task) {
  case 'install':
    run(process.execPath, ['node_modules/electron/install.js'])
    run(windows ? 'uv.exe' : 'uv', ['sync', '--project', windows ? 'python/windows' : 'python', '--locked',
      ...(windows ? ['--managed-python'] : [])])
    break
  case 'native': // only for `npm run dev`, which needs the helper before starting
    buildNative()
    break
  case 'build': {
    buildNative()
    run(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
    const uv = (windows ? run('where.exe', ['uv.exe'], true) : run('/bin/sh', ['-c', 'command -v uv'], true))
      .trim().split(/\r?\n/)[0]
    copyFileSync(uv, join(bin, windows ? 'uv.exe' : 'uv'))
    // Building must never upload anything; releases are published by the release workflow.
    const publish = args.some((arg) => arg === '-p' || arg.startsWith('--publish')) ? [] : ['--publish', 'never']
    run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', windows ? '--win' : '--mac', ...publish, ...args])
    break
  }
  default:
    throw new Error(`Unknown build task: ${task}`)
}
