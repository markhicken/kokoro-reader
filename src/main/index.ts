import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { format } from 'node:util'
import { join } from 'node:path'
import type { EngineStatus, Settings } from '../shared/types'
import { KokoroEngine, type EngineOptions } from './engine'
import { AccessibilityHelper } from './helper'
import { isAccessibilityTrusted, openAccessibilitySettings, requestAccessibility, watchAccessibility } from './permissions'
import { getSettings, updateSettings } from './settings'

const PREVIEW_TEXT = 'Hello! This is how I sound at the current speed.'

let tray: Tray | null = null
let readerWin: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let engine: KokoroEngine
let helper: AccessibilityHelper
let currentId: string | null = null
/** Whether the current read can be highlighted in the source app. */
let currentSourceHighlight = false
let firstRun = false
/** True from the moment a read is requested until the engine has finished generating its audio. */
let generating = false
let spinnerTimer: ReturnType<typeof setInterval> | undefined
let spinnerFrame = 0
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function loadRenderer(win: BrowserWindow, page: 'settings' | 'reader'): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}/index.html`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
  }
}

const webPreferences = () => ({
  preload: join(__dirname, '../preload/index.js'),
  sandbox: false,
  contextIsolation: true
})

function createReaderWindow(): BrowserWindow {
  const { panelBounds } = getSettings()
  const area = screen.getPrimaryDisplay().workArea
  const width = 460
  const height = 240
  const win = new BrowserWindow({
    width,
    height,
    x: panelBounds?.x ?? area.x + area.width - width - 24,
    y: panelBounds?.y ?? area.y + area.height - height - 24,
    ...(panelBounds && { width: panelBounds.width, height: panelBounds.height }),
    minWidth: 260,
    minHeight: 120,
    show: false,
    frame: false,
    transparent: true,
    vibrancy: 'hud',
    visualEffectState: 'active',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    // The panel also drives playback/highlight timing while hidden.
    webPreferences: { ...webPreferences(), backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const saveBounds = () => updateSettings({ panelBounds: win.getBounds() })
  win.on('moved', saveBounds)
  win.on('resized', saveBounds)
  win.on('closed', () => (readerWin = null))
  loadRenderer(win, 'reader')
  return win
}

function openSettings(): void {
  if (settingsWin) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 760,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: 'Kokoro Reader Settings',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: webPreferences()
  })
  settingsWin.on('closed', () => (settingsWin = null))
  loadRenderer(settingsWin, 'settings')
  // Fit window to content so no scrolling is needed (capped to the display).
  const win = settingsWin
  win.webContents.once('did-finish-load', async () => {
    try {
      const h: number = await win.webContents.executeJavaScript('document.documentElement.scrollHeight')
      const max = screen.getDisplayMatching(win.getBounds()).workArea.height - 40
      win.setContentSize(460, Math.min(Math.max(h, 400), max))
    } catch {
      /* window closed before load finished */
    }
  })
  app.focus({ steal: true })
}

/**
 * Read `text` aloud. The text is passed through untrimmed so the word offsets the
 * reader reports line up with the source app's selection for in-place highlighting.
 */
function readText(text: string, sourceHighlight = false): void {
  if (!text.trim()) {
    showMessage('Nothing to read — select some text first.')
    return
  }
  stopReading(false)
  const { voice, speed, showPanel, highlightInSource, joinLines, expandWords } = getSettings()
  const id = randomUUID()
  currentId = id
  currentSourceHighlight = sourceHighlight && highlightInSource

  if (!readerWin) readerWin = createReaderWindow()
  const win = readerWin
  const send = () => safeSend(win, 'reader:start', { id, text })
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
  if (showPanel) win.showInactive()
  else win.hide()

  setGenerating(true)
  engine.speak(id, text, voice, speed, joinLines, expandWords)
  rebuildMenu()
}

const NEEDS_ACCESSIBILITY =
  'Kokoro Reader needs Accessibility permission to read your selection. ' +
  'Turn it on in the dialog (or System Settings → Privacy & Security → Accessibility), then press the hotkey again.'

async function readSelection(): Promise<void> {
  if (!isAccessibilityTrusted()) {
    showMessage(NEEDS_ACCESSIBILITY)
    await requestAccessibility()
    return
  }
  try {
    const { text, sourceHighlight } = await helper.capture()
    readText(text, sourceHighlight)
  } catch (e) {
    console.error('[kokoro] read selection failed:', (e as Error).message)
    showMessage((e as Error).message)
  }
}

/** Send to a window only if it and its frame are still alive (they can be torn down mid-event). */
function safeSend(win: BrowserWindow | null | undefined, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, ...args)
  } catch (e) {
    console.error(`[kokoro] send ${channel} failed:`, (e as Error).message)
  }
}

function updateTrayTitle(): void {
  if (!tray) return
  if (generating) tray.setTitle(SPINNER_FRAMES[spinnerFrame])
  else tray.setTitle(engine.getStatus() === 'ready' ? '' : '…')
}

/** Animate the menu-bar icon while audio is being generated. */
function setGenerating(value: boolean): void {
  if (generating === value) return
  generating = value
  clearInterval(spinnerTimer)
  spinnerTimer = undefined
  if (value) {
    spinnerFrame = 0
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length
      updateTrayTitle()
    }, 100)
  }
  updateTrayTitle()
}

function stopReading(hide = true): void {
  // Only clear when a read was in progress: right after a capture, `clear` would also
  // switch the source app's accessibility tree back off before we highlight in it.
  if (currentId) {
    engine.cancel(currentId)
    helper?.clear()
  }
  currentId = null
  currentSourceHighlight = false
  setGenerating(false)
  if (hide) {
    safeSend(readerWin, 'reader:stop')
    readerWin?.hide()
  }
  rebuildMenu()
}

/** Show a status/error message in the reader panel (notifications may be disabled). */
function showMessage(message: string): void {
  stopReading(false)
  if (!readerWin) readerWin = createReaderWindow()
  const win = readerWin
  const send = () => safeSend(win, 'reader:message', message)
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
  win.showInactive()
}

function helperPath(): string {
  const name = 'kokoro-helper'
  return app.isPackaged ? join(process.resourcesPath, 'bin', name) : join(app.getAppPath(), 'build', 'bin', name)
}

/** Packaged app has no terminal: mirror console output to a log file in userData. */
function logToFile(): void {
  const file = join(app.getPath('userData'), 'kokoro.log')
  for (const level of ['log', 'error'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      orig(...args)
      try {
        appendFileSync(file, `${new Date().toISOString()} ${format(...args)}\n`)
      } catch {}
    }
  }
}

function notify(title: string, body: string): void {
  new Notification({ title, body }).show()
}

function registerHotkey(hotkey: string): boolean {
  globalShortcut.unregisterAll()
  let ok = false
  try {
    ok = globalShortcut.register(hotkey, () => {
      console.log(`[kokoro] hotkey ${hotkey} pressed`)
      // Pressing the hotkey while reading stops, so it works even with the panel hidden.
      if (currentId) stopReading()
      else void readSelection()
    })
  } catch {}
  console.log(`[kokoro] register hotkey ${hotkey}: ${ok ? 'ok' : 'FAILED'}`)
  return ok
}

function engineOptions(): EngineOptions {
  if (!app.isPackaged) return { pythonDir: join(app.getAppPath(), 'python') }
  const envDir = join(app.getPath('userData'), 'python-env')
  firstRun = !existsSync(envDir)
  return {
    pythonDir: join(process.resourcesPath, 'python'),
    uvPath: join(process.resourcesPath, 'bin', 'uv'),
    envDir
  }
}

const STATUS_LABEL: Record<EngineStatus, string> = {
  stopped: 'Engine stopped',
  loading: 'Loading model…',
  ready: 'Ready',
  error: 'Engine error'
}

function rebuildMenu(): void {
  if (!tray) return
  const status = engine.getStatus()
  const { hotkey } = getSettings()
  updateTrayTitle()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `Kokoro — ${status === 'loading' && firstRun ? 'Setting up engine (first launch, a few minutes)…' : STATUS_LABEL[status]}`,
        enabled: false
      },
      { type: 'separator' },
      ...(isAccessibilityTrusted()
        ? []
        : [
            {
              label: '⚠️ Grant Accessibility Permission…',
              click: async () => {
                await requestAccessibility()
                openAccessibilitySettings()
              }
            },
            { type: 'separator' as const }
          ]),
      { label: 'Read Selection', accelerator: hotkey, registerAccelerator: false, click: () => void readSelection() },
      { label: 'Stop', enabled: currentId !== null, click: () => stopReading() },
      { type: 'separator' },
      { label: 'Settings…', click: openSettings },
      { label: 'Quit', role: 'quit' }
    ])
  )
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  if (icon.isEmpty()) tray.setTitle('K')
  tray.setToolTip('Kokoro TTS')
  rebuildMenu()
}

function wireIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const prev = getSettings()
    const next = updateSettings(patch)
    if (patch.hotkey && patch.hotkey !== prev.hotkey && !registerHotkey(next.hotkey)) {
      notify('Hotkey unavailable', `Could not register ${next.hotkey}; reverting.`)
      registerHotkey(prev.hotkey)
      return updateSettings({ hotkey: prev.hotkey })
    }
    if (patch.model) engine.setModel(next.model)
    if (patch.showPanel === false && currentId) readerWin?.hide()
    if (patch.highlightInSource === false) {
      currentSourceHighlight = false
      helper.clear()
    }
    rebuildMenu()
    return next
  })
  ipcMain.handle('status:get', () => engine.getStatus())
  ipcMain.on('preview', () => readText(PREVIEW_TEXT))
  ipcMain.on('hotkey:suspend', (_e, suspend: boolean) => {
    if (suspend) globalShortcut.unregisterAll()
    else registerHotkey(getSettings().hotkey)
  })
  ipcMain.on('stop', () => stopReading())
  ipcMain.on('reader:word', (_e, id: string, from: number, to: number, text: string) => {
    if (id === currentId && currentSourceHighlight) helper.highlight(from, to, text)
  })
  ipcMain.on('reader:finished', (_e, id: string) => {
    if (id !== currentId) return
    currentId = null
    currentSourceHighlight = false
    helper.clear()
    rebuildMenu()
    const { showPanel, autoClosePanel } = getSettings()
    if (!showPanel || autoClosePanel) readerWin?.hide()
  })
}

function wireEngine(): void {
  engine.on('status', (s: EngineStatus) => {
    rebuildMenu()
    for (const w of BrowserWindow.getAllWindows()) safeSend(w, 'status', s)
  })
  engine.on('chunk', (chunk) => {
    if (chunk.id === currentId) safeSend(readerWin, 'reader:chunk', chunk)
  })
  engine.on('done', (id: string) => {
    if (id === currentId) {
      setGenerating(false)
      safeSend(readerWin, 'reader:done', id)
    }
  })
  engine.on('error', (id: string | null, message: string) => {
    console.error('[kokoro]', message)
    if (id === null || id === currentId) {
      setGenerating(false)
      safeSend(readerWin, 'reader:error', message)
    }
  })
}

app.whenReady().then(() => {
  if (app.isPackaged) logToFile()
  app.dock?.hide()
  const settings = getSettings()
  engine = new KokoroEngine(engineOptions(), settings.model)
  helper = new AccessibilityHelper(helperPath())
  helper.start()
  wireEngine()
  wireIpc()
  createTray()
  if (!registerHotkey(settings.hotkey)) notify('Hotkey unavailable', `Could not register ${settings.hotkey}.`)
  engine.start()
  readerWin = createReaderWindow()

  watchAccessibility((trusted) => {
    console.log(`[kokoro] accessibility ${trusted ? 'granted' : 'revoked'}`)
    rebuildMenu()
    if (trusted) {
      notify('Accessibility enabled', `Press ${getSettings().hotkey} with text selected to read it aloud.`)
      if (readerWin?.isVisible() && !currentId) readerWin.hide()
    }
  })
  if (!isAccessibilityTrusted()) void requestAccessibility()
})

// Menu-bar app: keep running with no windows open.
app.on('window-all-closed', () => {})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  engine?.stop()
  helper?.stop()
})
