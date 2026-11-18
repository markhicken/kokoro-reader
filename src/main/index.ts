import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, Tray, type NativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { format } from 'node:util'
import { join } from 'node:path'
import type { EngineStatus, Settings } from '../shared/types'
import { KokoroEngine, type EngineOptions } from './engine'
import { AccessibilityHelper } from './helper'
import { isAccessibilityTrusted, openAccessibilitySettings, requestAccessibility, watchAccessibility } from './permissions'
import { getSettings, updateSettings } from './settings'
import { createMacSpinnerFrames, createWindowsSpinnerFrames } from './tray-spinner'
import { showWindowsHighlight } from './windows-highlight'

const PREVIEW_TEXT = 'Hello! This is how I sound at the current speed.'
const PREPARING_DELAY_MS = 300
const SPINNER_FRAME_COUNT = 10
const windows = process.platform === 'win32'
const APP_ID = 'local.kokoro-gui.reader'

let tray: Tray | null = null
let trayIcon: NativeImage
let traySpinnerFrames: NativeImage[] = []
let readerWin: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let preparingWin: BrowserWindow | null = null
let preparingTimer: ReturnType<typeof setTimeout> | undefined
let engine: KokoroEngine
let helper: AccessibilityHelper
let currentId: string | null = null
/** Whether the current read can be highlighted in the source app. */
let currentSourceHighlight = false
let capturing = false
let firstRun = false
type ReadStatus = 'idle' | 'preparing' | 'reading' | 'failed'
let readStatus: ReadStatus = 'idle'
let spinnerTimer: ReturnType<typeof setInterval> | undefined
let spinnerFrame = 0

function loadRenderer(win: BrowserWindow, page: 'settings' | 'reader' | 'preparing'): void {
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
    ...(!windows && { vibrancy: 'hud', visualEffectState: 'active' }),
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    // The panel also drives playback/highlight timing while hidden.
    webPreferences: { ...webPreferences(), backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true, 'floating')
  if (!windows) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const saveBounds = () => updateSettings({ panelBounds: win.getBounds() })
  win.on('moved', saveBounds)
  win.on('resized', saveBounds)
  win.on('closed', () => {
    readerWin = null
    if (currentId) stopReading(false)
  })
  loadRenderer(win, 'reader')
  return win
}

function openSettings(): void {
  if (settingsWin) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  settingsWin = new BrowserWindow({
    show: false,
    width: 460,
    height: Math.min(800, workArea.height),
    useContentSize: true,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: 'Kokoro Reader Settings',
    ...(!windows && {
      titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000'
    }),
    webPreferences: webPreferences()
  })
  settingsWin.on('closed', () => (settingsWin = null))
  loadRenderer(settingsWin, 'settings')
  // Fit window to content so no scrolling is needed (capped to the display).
  const win = settingsWin
  win.webContents.once('did-finish-load', async () => {
    try {
      const contentHeight: number = await win.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)')
      const bounds = win.getBounds()
      const area = screen.getDisplayMatching(bounds).workArea
      const frameHeight = bounds.height - win.getContentBounds().height
      const maxHeight = Math.max(1, area.height - frameHeight - 16)
      win.setContentSize(460, Math.min(Math.max(contentHeight, 400), maxHeight))
      const resized = win.getBounds()
      const y = Math.min(Math.max(resized.y, area.y), area.y + area.height - resized.height)
      if (resized.y !== y) win.setPosition(resized.x, y)
    } catch {
      /* window closed before load finished */
    }
    if (win.isDestroyed()) return
    win.show()
    if (!windows) app.focus({ steal: true })
  })
}

function createPreparingWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: webPreferences()
  })
  win.setIgnoreMouseEvents(true)
  if (!windows) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('closed', () => { preparingWin = null })
  loadRenderer(win, 'preparing')
  return win
}

function updatePreparationShortcut(win: BrowserWindow): void {
  const { hotkey } = getSettings()
  safeSend(win, 'preparing:shortcut', globalShortcut.isRegistered(hotkey) ? hotkey : null)
}

function updatePreparingOverlay(): void {
  clearTimeout(preparingTimer)
  preparingTimer = undefined
  if (readStatus !== 'preparing' || !getSettings().showPreparingOverlay) {
    preparingWin?.hide()
    return
  }

  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = Math.min(360, workArea.width)
  const height = Math.min(112, workArea.height)
  const timer = setTimeout(() => {
    preparingWin ??= createPreparingWindow()
    const win = preparingWin
    const show = () => {
      if (timer !== preparingTimer || win.isDestroyed()) return
      win.setBounds({
        x: workArea.x + Math.round((workArea.width - width) / 2),
        y: workArea.y + Math.round((workArea.height - height) / 2),
        width,
        height
      })
      updatePreparationShortcut(win)
      win.showInactive()
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', show)
    else show()
  }, PREPARING_DELAY_MS)
  preparingTimer = timer
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
  setReadStatus('preparing')
  rebuildMenu()

  if (!readerWin) readerWin = createReaderWindow()
  const win = readerWin
  const start = () => {
    if (currentId !== id) return
    safeSend(win, 'reader:start', { id, text })
    engine.speak(id, text, voice, speed, joinLines, expandWords)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', start)
  else start()
  if (showPanel) win.showInactive()
  else win.hide()
}

const NEEDS_ACCESSIBILITY =
  'Kokoro Reader needs Accessibility permission to read your selection. ' +
  'Turn it on in the dialog (or System Settings → Privacy & Security → Accessibility), then press the hotkey again.'

async function readSelection(fromTray = false): Promise<void> {
  if (capturing) return
  if (!windows && !isAccessibilityTrusted()) {
    showMessage(NEEDS_ACCESSIBILITY)
    await requestAccessibility()
    return
  }
  capturing = true
  try {
    if (windows && currentId) stopReading()
    const { text, sourceHighlight } = await helper.capture(fromTray)
    readText(text, sourceHighlight)
  } catch (e) {
    console.error('[kokoro] read selection failed:', (e as Error).message)
    if (!windows && (e as { code?: string }).code === 'untrusted') {
      // macOS reports us as trusted but the grant is stale (e.g. after a rebuild): reset and re-prompt.
      showMessage(NEEDS_ACCESSIBILITY)
      await requestAccessibility(true)
      return
    }
    showMessage((e as Error).message)
  } finally {
    capturing = false
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

function updateTrayIcon(): void {
  if (!tray) return
  tray.setImage(readStatus === 'preparing' ? traySpinnerFrames[spinnerFrame] ?? trayIcon : trayIcon)
}

function setReadStatus(status: ReadStatus): void {
  if (readStatus === status) return
  readStatus = status
  updatePreparingOverlay()
  clearInterval(spinnerTimer)
  spinnerTimer = undefined
  if (status === 'preparing' && traySpinnerFrames.length) {
    spinnerFrame = 0
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % traySpinnerFrames.length
      updateTrayIcon()
    }, 100)
  }
}

function clearRead(status: 'idle' | 'failed' = 'idle'): void {
  // Only clear when a read was in progress: right after a capture, `clear` would also
  // switch the source app's accessibility tree back off before we highlight in it.
  if (currentId) helper.clear()
  currentId = null
  currentSourceHighlight = false
  setReadStatus(status)
}

function stopReading(hide = true): void {
  if (currentId) engine.cancel(currentId)
  clearRead()
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
  const name = windows ? 'kokoro-helper.exe' : 'kokoro-helper'
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
  const dataDir = app.getPath('userData')
  if (!app.isPackaged) return { pythonDir: join(app.getAppPath(), 'python'), dataDir }
  const envDir = join(dataDir, 'python-env')
  firstRun = !existsSync(envDir)
  return {
    pythonDir: join(process.resourcesPath, 'python'),
    uvPath: join(process.resourcesPath, 'bin', windows ? 'uv.exe' : 'uv'),
    envDir,
    dataDir
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
  const idleLabel = status === 'loading' && firstRun ? 'Setting up engine (first launch, a few minutes)…' : STATUS_LABEL[status]
  const label = { idle: idleLabel, preparing: 'Preparing audio…', reading: 'Reading', failed: 'Read failed' }[readStatus]
  updateTrayIcon()
  tray.setToolTip(`Kokoro Reader · ${label}`)
  if (!windows) {
    if (readStatus === 'preparing') tray.setTitle('')
    else if (trayIcon.isEmpty()) tray.setTitle('K')
    else tray.setTitle(status === 'ready' ? '' : '…')
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `Kokoro — ${label}`,
        enabled: false
      },
      { type: 'separator' },
      ...(windows || isAccessibilityTrusted()
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
      { label: 'Read Selection', accelerator: hotkey, registerAccelerator: false, click: () => void readSelection(true) },
      { label: 'Stop', enabled: currentId !== null, click: () => stopReading() },
      { type: 'separator' },
      { label: 'Settings…', click: openSettings },
      { label: 'Quit', role: 'quit' }
    ])
  )
}

function createTray(): void {
  const path = windows
    ? (app.isPackaged ? join(process.resourcesPath, 'tray-windows.png') : join(app.getAppPath(), 'build', 'icon.png'))
    : join(__dirname, '../../resources/trayTemplate.png')
  const image = nativeImage.createFromPath(path)
  if (!windows) image.setTemplateImage(true)
  trayIcon = windows ? image.resize({ width: 32, height: 32 }) : image
  traySpinnerFrames = windows
    ? createWindowsSpinnerFrames(trayIcon, SPINNER_FRAME_COUNT)
    : createMacSpinnerFrames(SPINNER_FRAME_COUNT)
  tray = new Tray(trayIcon)
  if (windows) tray.on('click', () => tray?.popUpContextMenu())
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
    if (next.model !== prev.model) {
      if (currentId) stopReading()
      engine.setModel(next.model)
    }
    if (patch.showPanel === false && currentId) readerWin?.hide()
    if (next.showPreparingOverlay !== prev.showPreparingOverlay) updatePreparingOverlay()
    if (preparingWin?.isVisible()) updatePreparationShortcut(preparingWin)
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
    if (preparingWin?.isVisible()) updatePreparationShortcut(preparingWin)
  })
  ipcMain.on('stop', () => stopReading())
  ipcMain.on('reader:playback-started', (_e, id: string) => {
    if (id !== currentId || readStatus !== 'preparing') return
    setReadStatus('reading')
    rebuildMenu()
  })
  ipcMain.on('reader:playback-failed', (_e, id: string, message: string) => {
    if (id !== currentId) return
    console.error('[kokoro] playback failed:', message)
    engine.cancel(id)
    clearRead('failed')
    rebuildMenu()
  })
  ipcMain.on('reader:word', (_e, id: string, from: number, to: number, text: string) => {
    if (id === currentId && currentSourceHighlight) helper.highlight(from, to, text)
  })
  ipcMain.on('reader:finished', (_e, id: string) => {
    if (id !== currentId) return
    clearRead()
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
    if (id === currentId) safeSend(readerWin, 'reader:done', id)
  })
  engine.on('error', (id: string | null, message: string) => {
    console.error('[kokoro]', message)
    if (id === null || id === currentId) {
      if (currentId) {
        clearRead('failed')
        rebuildMenu()
      }
      safeSend(readerWin, 'reader:error', message)
    }
  })
}

function start(): void {
  if (app.isPackaged) logToFile()
  if (windows) {
    Menu.setApplicationMenu(null)
    app.setAppUserModelId(APP_ID)
  } else {
    app.dock?.hide()
  }
  const settings = getSettings()
  engine = new KokoroEngine(engineOptions(), settings.model)
  helper = new AccessibilityHelper(helperPath(), windows ? showWindowsHighlight : undefined)
  helper.start()
  wireEngine()
  wireIpc()
  createTray()
  if (!registerHotkey(settings.hotkey)) notify('Hotkey unavailable', `Could not register ${settings.hotkey}.`)
  engine.start()
  readerWin = createReaderWindow()

  if (windows) return
  watchAccessibility((trusted) => {
    console.log(`[kokoro] accessibility ${trusted ? 'granted' : 'revoked'}`)
    rebuildMenu()
    if (trusted) {
      notify('Accessibility enabled', `Press ${getSettings().hotkey} with text selected to read it aloud.`)
      if (readerWin?.isVisible() && !currentId) readerWin.hide()
    }
  })
  if (!isAccessibilityTrusted()) void requestAccessibility()
}

if (app.requestSingleInstanceLock()) {
  void app.whenReady().then(start)
  // Tray app: keep running with no windows open.
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => {
    clearInterval(spinnerTimer)
    clearTimeout(preparingTimer)
    globalShortcut.unregisterAll()
    engine?.stop()
    helper?.stop()
  })
} else {
  app.quit()
}
