import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'docs', 'images', 'screenshot.png')

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Screenshot command failed (${result.signal ?? result.status}): ${command}`)
}

if (!process.versions.electron) {
  run(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'])
  const { default: electron } = await import('electron')
  const profile = mkdtempSync(join(tmpdir(), 'kokoro-screenshot-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    run(electron, [fileURLToPath(import.meta.url), profile], env)
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
} else {
  const { app, BrowserWindow, ipcMain, nativeTheme } = await import('electron')
  app.setPath('userData', process.argv[2])
  app.setPath('sessionData', process.argv[2])
  app.commandLine.appendSwitch('force-device-scale-factor', '2')
  app.disableHardwareAcceleration()

  const windows = process.platform === 'win32'
  // A fixed preview, not the user's saved settings or a running speech engine.
  const settings = {
    voice: 'af_heart',
    speed: 1,
    model: windows ? 'fp32' : 'bf16',
    hotkey: windows ? 'Control+Alt+Space' : 'Alt+Shift+Space',
    autoClosePanel: true,
    showPanel: true,
    showPreparingOverlay: true,
    showPlaybackControls: true,
    playbackControlsPosition: null,
    highlightInSource: true,
    joinLines: true,
    expandWords: true
  }
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('status:get', () => 'ready')

  let win
  let exitCode = 0
  let stage = 'starting Electron'
  const timeout = setTimeout(() => {
    console.error(`Timed out ${stage}.`)
    app.exit(1)
  }, 30_000)
  // Awaiting readiness at module scope would block Electron's ESM startup.
  void app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = 'dark'
      win = new BrowserWindow({
        width: 460,
        height: 800,
        useContentSize: true,
        enableLargerThanScreen: true,
        frame: false,
        show: false,
        title: 'Kokoro Reader Settings',
        backgroundColor: '#1e1e1e',
        webPreferences: {
          preload: join(root, 'out/preload/index.js'),
          contextIsolation: true,
          sandbox: false,
          backgroundThrottling: false
        }
      })
      win.webContents.on('render-process-gone', (_event, details) => {
        console.error(`Screenshot renderer exited: ${details.reason}`)
        app.exit(1)
      })
      stage = 'loading the settings UI'
      await win.loadFile(join(root, 'out/renderer/settings/index.html'))
      // Renderer captures exclude OS chrome. Draw matching chrome without capturing the desktop.
      await win.webContents.insertCSS(`
        *, *::before, *::after { animation: none !important; transition: none !important; }
        body {
          background: #1e1e1e;
          border: 1px solid rgba(255, 255, 255, 0.22);
          border-radius: ${windows ? 8 : 12}px;
          overflow: hidden;
        }
        .titlebar { position: relative; }
        body:not(.windows) .titlebar::before {
          content: '';
          position: absolute;
          top: 14px;
          left: 14px;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #ff5f57;
          box-shadow: 20px 0 #febc2e, 40px 0 #28c840;
        }
        .screenshot-caption {
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 32px;
          padding-left: 12px;
          font: 12px 'Segoe UI', sans-serif;
          color: rgba(255, 255, 255, 0.85);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .screenshot-caption-controls { display: flex; height: 100%; }
        .screenshot-caption-controls span { display: grid; place-items: center; width: 46px; }
        .screenshot-caption-controls svg { width: 12px; height: 12px; fill: none; stroke: currentColor; }
      `)
      if (windows) {
        await win.webContents.executeJavaScript(`
          const caption = document.createElement('div')
          caption.className = 'screenshot-caption'
          caption.innerHTML = 'Kokoro Reader Settings<div class="screenshot-caption-controls">' +
            '<span><svg viewBox="0 0 12 12"><path d="M1 6h10"/></svg></span>' +
            '<span><svg viewBox="0 0 12 12"><path d="M1.5 1.5h9v9h-9z"/></svg></span>' +
            '<span><svg viewBox="0 0 12 12"><path d="m1 1 10 10M1 11 11 1"/></svg></span></div>'
          document.body.prepend(caption)
        `)
      }
      stage = 'waiting for the settings preview'
      const height = await win.webContents.executeJavaScript(`
        (async () => {
          await new Promise((resolve) => {
            const ready = () => {
              if (document.getElementById('voice').value &&
                  document.getElementById('speedValue').textContent &&
                  document.getElementById('hotkey').textContent &&
                  document.getElementById('status').dataset.status === 'ready') resolve()
              else setTimeout(ready, 20)
            }
            ready()
          })
          await document.fonts.ready
          return Math.ceil(document.body.getBoundingClientRect().height)
        })()
      `)
      stage = 'laying out the settings preview'
      win.setContentSize(460, height)
      await win.webContents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
      )
      stage = 'capturing the settings preview'
      const image = await win.webContents.capturePage(undefined, { stayHidden: true })
      if (image.isEmpty()) throw new Error('Captured an empty settings screenshot.')
      const size = image.getSize()
      if (size.width !== 920 || size.height !== height * 2) {
        throw new Error(`Unexpected screenshot dimensions: ${size.width}x${size.height}`)
      }
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, image.toPNG())
      console.log('Updated docs/images/screenshot.png')
    } catch (error) {
      console.error(error)
      exitCode = 1
    } finally {
      clearTimeout(timeout)
      win?.destroy()
      app.exit(exitCode)
    }
  })
}
