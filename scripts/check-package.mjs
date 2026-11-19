import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const windows = process.platform === 'win32'
const arch = process.arch
const artifacts = readdirSync('dist')
assert(artifacts.some((name) => name.endsWith(windows ? `-${arch}-setup.exe` : '-arm64.dmg')), 'Installer missing')
const contents = join('dist', 'mac-arm64', 'Kokoro Reader.app', 'Contents')
const windowsDir = join('dist', arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`)
const resources = windows ? join(windowsDir, 'resources') : join(contents, 'Resources')
const macOnly = ['bin/kokoro-helper', 'bin/uv', 'python/pyproject.toml', 'python/uv.lock']
const windowsOnly = ['bin/kokoro-helper.exe', 'bin/uv.exe', 'python/windows/pyproject.toml', 'python/windows/uv.lock',
  'python/kokoro_windows.py', 'tray-windows.png']
for (const path of ['app.asar', 'python/kokoro_server.py', 'licenses/LICENSE', 'licenses/electron-LICENSE',
  'licenses/LICENSES.chromium.html', 'licenses/uv-LICENSE-APACHE', 'licenses/uv-LICENSE-MIT',
  ...(windows ? windowsOnly : macOnly)]) {
  assert(existsSync(join(resources, path)), `Missing packaged resource: ${path}`)
}
for (const path of windows ? macOnly : windowsOnly) {
  assert(!existsSync(join(resources, path)), `Unexpected packaged resource: ${path}`)
}

if (windows) {
  assert(['x64', 'arm64'].includes(arch), `Unsupported Windows architecture: ${arch}`)
  for (const path of [join(windowsDir, 'Kokoro Reader.exe'), join(resources, 'bin/kokoro-helper.exe'),
    join(resources, 'bin/uv.exe')]) {
    const image = readFileSync(path)
    const header = image.readUInt32LE(0x3c)
    assert.equal(image.toString('ascii', header, header + 4), 'PE\0\0', path)
    assert.equal(image.readUInt16LE(header + 4), arch === 'arm64' ? 0xaa64 : 0x8664, `${path} must be ${arch}`)
  }
} else {
  const arch = (path) => execFileSync('lipo', ['-archs', path], { encoding: 'utf8' }).trim()
  const plist = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print:${key}`, join(contents, 'Info.plist')],
    { encoding: 'utf8' }).trim()
  assert.equal(arch(join(contents, 'MacOS', 'Kokoro Reader')), 'arm64')
  assert.equal(arch(join(resources, 'bin', 'kokoro-helper')), 'arm64')
  assert.equal(plist('CFBundleIdentifier'), 'local.kokoro-gui.reader')
  assert.equal(plist('LSUIElement'), 'true')
  execFileSync('codesign', ['--verify', '--deep', join(contents, '..')], { stdio: 'inherit' })
}
console.log('Packaged application resources verified.')
