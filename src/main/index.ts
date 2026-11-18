import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, Tray, type BrowserWindowConstructorOptions, type NativeImage, type Rectangle } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { format } from 'node:util'
import { join } from 'node:path'
import type { CenteredOverlay, EngineStatus, PlaybackCommand, Settings } from '../shared/types'
import { KokoroEngine, type EngineOptions } from './engine'
import { AccessibilityHelper } from './helper'
import {
  isAccessibilityTrusted,
  openAccessibilitySettings,
  requestAccessibility,
  resetGrantForNewBuild,
  watchAccessibility
} from './permissions'
import { getSettings, updateSettings } from './settings'
import { createMacSpinnerFrames, createWindowsSpinnerFrames } from './tray-spinner'
import { showWindowsHighlight } from './windows-highlight'
import { attachWindowsOverlayBackdrop } from './windows-overlay-backdrop'

const PREVIEW_TEXT = 'Hello! This is how I sound at the current speed.'
const TRAY_READ_DELAY_MS = 1000
const PREPARING_DELAY_MS = 300
const NO_SELECTION_NOTICE_MS = 3000
const SPINNER_FRAME_COUNT = 10
const WINDOW_MARGIN = 24
const PLAYBACK_CONTROLS_SIZE = { width: 216, height: 54 }
const windows = process.platform === 'win32'
const APP_ID = 'local.kokoro-gui.reader'

let tray: Tray | null = null
let trayIcon: NativeImage
let traySpinnerFrames: NativeImage[] = []
let readerWin: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let centeredWin: BrowserWindow | null = null
let playbackWin: BrowserWindow | null = null
let playbackReady = false
let playbackPaused = false
let centeredRequest: { kind: CenteredOverlay['kind']; timer?: ReturnType<typeof setTimeout> } | undefined
let engine: KokoroEngine
let helper: AccessibilityHelper
let currentId: string | null = null
let speech: { generationId: string; text: string; voice: string; joinLines: boolean; expandWords: boolean } | null = null
/** Whether the current read can be highlighted in the source app. */
let currentSourceHighlight = false
let capturing = false
let trayReadTimer: ReturnType<typeof setTimeout> | undefined
let firstRun = false
type ReadStatus = 'idle' | 'preparing' | 'reading' | 'failed'
let readStatus: ReadStatus = 'idle'
let spinnerTimer: ReturnType<typeof setInterval> | undefined
let spinnerFrame = 0

function loadRenderer(win: BrowserWindow, page: 'settings' | 'reader' | 'preparing' | 'playback'): void {
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

const overlayOptions: BrowserWindowConstructorOptions = {
  show: false,
  frame: false,
  // Windows acrylic paints behind the renderer's transparent corners.
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  ...(windows ? {} : { vibrancy: 'hud', visualEffectState: 'active' })
}

function configureOverlay(win: BrowserWindow): void {
  if (windows) attachWindowsOverlayBackdrop(win)
  else win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
}

function defaultReaderBounds(): Rectangle {
  const { showPlaybackControls, playbackControlsPosition } = getSettings()
  const area = screen.getPrimaryDisplay().workArea
  const width = 460
  const height = 240
  const reservedHeight = showPlaybackControls && !playbackControlsPosition ? PLAYBACK_CONTROLS_SIZE.height + 12 : 0
  return {
    x: area.x + area.width - width - WINDOW_MARGIN,
    y: Math.max(area.y, area.y + area.height - height - WINDOW_MARGIN - reservedHeight),
    width,
    height
  }
}

function positionDefaultReader(): void {
  if (!readerWin || getSettings().panelBounds) return
  const { x, y } = defaultReaderBounds()
  readerWin.setPosition(x, y)
}

function createReaderWindow(): BrowserWindow {
  const { panelBounds } = getSettings()
  const win = new BrowserWindow({
    ...overlayOptions,
    ...(panelBounds ?? defaultReaderBounds()),
    minWidth: 260,
    minHeight: 120,
    hasShadow: !windows,
    // The panel also drives playback/highlight timing while hidden.
    webPreferences: { ...webPreferences(), backgroundThrottling: false }
  })
  configureOverlay(win)
  win.setAlwaysOnTop(true, 'floating')
  const saveBounds = () => {
    const bounds = win.getBounds()
    const preferred = defaultReaderBounds()
    if (!getSettings().panelBounds && bounds.width === preferred.width && bounds.height === preferred.height &&
      Math.abs(bounds.x - preferred.x) <= 1 && Math.abs(bounds.y - preferred.y) <= 1) return
    updateSettings({ panelBounds: bounds })
  }
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
    resizable: true,
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
  // Fit the initial height to the contents and leave vertical resizing available.
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
      win.setMinimumSize(resized.width, Math.min(360, resized.height))
      win.setMaximumSize(resized.width, Math.max(...screen.getAllDisplays().map((display) => display.workArea.height)))
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

function playbackBounds(): Rectangle {
  const { playbackControlsPosition: position } = getSettings()
  const { width, height } = PLAYBACK_CONTROLS_SIZE
  const display = position ? screen.getDisplayMatching({ ...position, width, height }) : screen.getPrimaryDisplay()
  const area = display.workArea
  const right = area.x + area.width - width
  const bottom = area.y + area.height - height
  return {
    x: Math.max(area.x, Math.min(position?.x ?? right - WINDOW_MARGIN, right)),
    y: Math.max(area.y, Math.min(position?.y ?? bottom - WINDOW_MARGIN, bottom)),
    width,
    height
  }
}

function createPlaybackWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...overlayOptions,
    ...playbackBounds(),
    resizable: false,
    focusable: false,
    // A non-activating panel keeps the source app focused (and its highlight alive) when clicked.
    ...(!windows && { type: 'panel' }),
    acceptFirstMouse: true,
    hasShadow: false,
    webPreferences: webPreferences()
  })
  configureOverlay(win)
  win.on('moved', () => {
    const [x, y] = win.getPosition()
    const preferred = playbackBounds()
    if (Math.abs(x - preferred.x) <= 1 && Math.abs(y - preferred.y) <= 1) return
    const wasDefault = !getSettings().playbackControlsPosition
    updateSettings({ playbackControlsPosition: { x, y } })
    if (wasDefault) positionDefaultReader()
  })
  win.on('closed', () => {
    playbackWin = null
    playbackReady = false
  })
  win.webContents.once('did-finish-load', () => {
    playbackReady = true
    updatePlaybackControls()
  })
  loadRenderer(win, 'playback')
  return win
}

function updatePlaybackControls(): void {
  if (readStatus !== 'reading' || !getSettings().showPlaybackControls) {
    playbackWin?.hide()
    return
  }
  const win = playbackWin ??= createPlaybackWindow()
  if (!playbackReady) return
  safeSend(win, 'playback-controls:paused', playbackPaused)
  if (!win.isVisible()) {
    win.setBounds(playbackBounds())
    win.showInactive()
  }
}

function createCenteredWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...overlayOptions,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: webPreferences()
  })
  configureOverlay(win)
  win.setIgnoreMouseEvents(true)
  win.on('closed', () => {
    centeredWin = null
    hideCenteredOverlay()
  })
  loadRenderer(win, 'preparing')
  return win
}

function updatePreparationShortcut(win: BrowserWindow): void {
  if (centeredRequest?.kind !== 'preparing') return
  const { hotkey } = getSettings()
  const overlay: CenteredOverlay = { kind: 'preparing', hotkey: globalShortcut.isRegistered(hotkey) ? hotkey : null }
  safeSend(win, 'centered-overlay:show', overlay)
}

function hideCenteredOverlay(): void {
  clearTimeout(centeredRequest?.timer)
  centeredRequest = undefined
  centeredWin?.hide()
}

function showCenteredOverlay(kind: CenteredOverlay['kind']): void {
  hideCenteredOverlay()
  const request: NonNullable<typeof centeredRequest> = { kind }
  centeredRequest = request
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = Math.min(360, workArea.width)
  const height = Math.min(112, workArea.height)
  const open = () => {
    const win = centeredWin ??= createCenteredWindow()
    const show = () => {
      if (centeredRequest !== request || win.isDestroyed()) return
      win.setBounds({
        x: workArea.x + Math.round((workArea.width - width) / 2),
        y: workArea.y + Math.round((workArea.height - height) / 2),
        width,
        height
      })
      if (kind === 'preparing') updatePreparationShortcut(win)
      else {
        const overlay: CenteredOverlay = { kind: 'no-selection' }
        safeSend(win, 'centered-overlay:show', overlay)
        request.timer = setTimeout(hideCenteredOverlay, NO_SELECTION_NOTICE_MS)
      }
      win.showInactive()
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', show)
    else show()
  }
  if (kind === 'preparing') request.timer = setTimeout(open, PREPARING_DELAY_MS)
  else open()
}

function updatePreparingOverlay(): void {
  if (readStatus === 'preparing' && getSettings().showPreparingOverlay) showCenteredOverlay('preparing')
  else if (readStatus === 'preparing' || centeredRequest?.kind === 'preparing') hideCenteredOverlay()
}

function showNoSelectionNotice(): void {
  stopReading(currentId !== null)
  showCenteredOverlay('no-selection')
}

/**
 * Read `text` aloud. The text is passed through untrimmed so the word offsets the
 * reader reports line up with the source app's selection for in-place highlighting.
 */
function readText(text: string, sourceHighlight = false): void {
  if (!text.trim()) {
    showNoSelectionNotice()
    return
  }
  stopReading(false)
  const { voice, showPanel, highlightInSource, joinLines, expandWords } = getSettings()
  const id = randomUUID()
  currentId = id
  speech = { generationId: id, text, voice, joinLines, expandWords }
  currentSourceHighlight = sourceHighlight && highlightInSource
  setReadStatus('preparing')
  rebuildMenu()

  if (!readerWin) readerWin = createReaderWindow()
  const win = readerWin
  const start = () => {
    if (currentId !== id) return
    const { speed } = getSettings()
    safeSend(win, 'reader:start', { id, text, speed })
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

/** Cached result of checkAccessibility(); drives the tray menu warning. */
let accessibilityOk = true

/** Trusted by macOS *and* actually usable by the helper (a stale grant reads as trusted). */
async function checkAccessibility(): Promise<boolean> {
  return isAccessibilityTrusted() && (await helper.checkTrusted())
}

/** Tell the user the grant is missing, revoked or stale, and ask for a new one. */
async function warnAccessibilityMissing(): Promise<void> {
  notify('Accessibility permission needed', NEEDS_ACCESSIBILITY)
  showMessage(NEEDS_ACCESSIBILITY)
  // macOS only reports a stale grant as trusted; reset it so the prompt appears again.
  await requestAccessibility(isAccessibilityTrusted())
}

function cancelTrayRead(): void {
  clearTimeout(trayReadTimer)
  trayReadTimer = undefined
}

function scheduleTrayRead(): void {
  if (capturing) return
  cancelTrayRead()
  // Give focus a chance to return to the source app after the tray menu closes.
  trayReadTimer = setTimeout(() => void readSelection(true), TRAY_READ_DELAY_MS)
}

async function readSelection(fromTray = false): Promise<void> {
  cancelTrayRead()
  if (capturing) return
  if (!windows && !isAccessibilityTrusted()) {
    accessibilityOk = false
    rebuildMenu()
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
    const { code } = e as { code?: string }
    if (code === 'noselection') {
      showNoSelectionNotice()
      return
    }
    if (!windows && code === 'untrusted') {
      // macOS reports us as trusted but the grant is stale (e.g. after a rebuild): reset and re-prompt.
      accessibilityOk = false
      rebuildMenu()
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
  if (status !== 'reading') playbackPaused = false
  updatePreparingOverlay()
  updatePlaybackControls()
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
  speech = null
  currentSourceHighlight = false
  setReadStatus(status)
}

function stopReading(hide = true): void {
  cancelTrayRead()
  if (speech) engine.cancel(speech.generationId)
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
  hideCenteredOverlay()
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
      ...(windows || accessibilityOk
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
      { label: 'Read Selection', accelerator: hotkey, registerAccelerator: false, click: scheduleTrayRead },
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
    if (speech && next.speed !== prev.speed) {
      engine.setSpeed(speech.generationId, next.speed)
      safeSend(readerWin, 'reader:speed', currentId, next.speed)
    }
    if (patch.showPanel === false && currentId) readerWin?.hide()
    if (next.showPreparingOverlay !== prev.showPreparingOverlay) updatePreparingOverlay()
    if ('playbackControlsPosition' in patch) playbackWin?.setBounds(playbackBounds())
    if (next.showPlaybackControls !== prev.showPlaybackControls || 'playbackControlsPosition' in patch) {
      positionDefaultReader()
      updatePlaybackControls()
    }
    if (centeredWin?.isVisible()) updatePreparationShortcut(centeredWin)
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
    if (centeredWin?.isVisible()) updatePreparationShortcut(centeredWin)
  })
  ipcMain.on('stop', () => stopReading())
  ipcMain.on('reader:playback-started', (_e, id: string) => {
    if (id !== currentId || readStatus !== 'preparing') return
    setReadStatus('reading')
    rebuildMenu()
  })
  ipcMain.on('reader:playback-paused', (_e, id: string, paused: boolean) => {
    if (id !== currentId || readStatus !== 'reading') return
    playbackPaused = paused
    updatePlaybackControls()
  })
  ipcMain.on('playback-controls:command', (event, command: PlaybackCommand) => {
    if (event.sender !== playbackWin?.webContents || !currentId || readStatus !== 'reading') return
    helper.refocus()
    if (command === 'stop') stopReading()
    else if (command === 'rewind' || command === 'forward' || command === 'toggle') {
      safeSend(readerWin, 'reader:command', currentId, command)
    }
  })
  ipcMain.on('reader:playback-failed', (_e, id: string, message: string) => {
    if (id !== currentId) return
    console.error('[kokoro] playback failed:', message)
    if (speech) engine.cancel(speech.generationId)
    clearRead('failed')
    rebuildMenu()
  })
  ipcMain.on('reader:regenerate', (event, id: string, generationId: string, startSeq: number) => {
    if (event.sender !== readerWin?.webContents || !speech || id !== currentId || readStatus !== 'reading' ||
      !Number.isSafeInteger(startSeq) || startSeq < 0) return
    engine.cancel(speech.generationId)
    speech.generationId = generationId
    engine.speak(generationId, speech.text, speech.voice, getSettings().speed, speech.joinLines, speech.expandWords, startSeq)
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
    if (chunk.id === speech?.generationId) {
      safeSend(readerWin, 'reader:chunk', { ...chunk, id: currentId, generationId: chunk.id })
    }
  })
  engine.on('done', (id: string) => {
    if (id === speech?.generationId) safeSend(readerWin, 'reader:done', currentId, id)
  })
  engine.on('error', (id: string | null, message: string) => {
    console.error('[kokoro]', message)
    if (id === null || id === speech?.generationId) {
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
  void resetGrantForNewBuild(helperPath()).then(checkAccessibility).then((ok) => {
    accessibilityOk = ok
    rebuildMenu()
    if (!ok) void warnAccessibilityMissing()
    watchAccessibility(ok, checkAccessibility, (trusted) => {
      console.log(`[kokoro] accessibility ${trusted ? 'granted' : 'revoked or invalid'}`)
      const alreadyFlagged = !accessibilityOk // a failed capture may have flagged it and prompted already
      accessibilityOk = trusted
      rebuildMenu()
      if (trusted) {
        helper.restart()
        notify('Accessibility enabled', `Press ${getSettings().hotkey} with text selected to read it aloud.`)
        if (readerWin?.isVisible() && !currentId) readerWin.hide()
      } else if (!alreadyFlagged) {
        void warnAccessibilityMissing()
      }
    })
  })
}

if (app.requestSingleInstanceLock()) {
  void app.whenReady().then(start)
  // Tray app: keep running with no windows open.
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => {
    cancelTrayRead()
    clearInterval(spinnerTimer)
    clearTimeout(centeredRequest?.timer)
    globalShortcut.unregisterAll()
    engine?.stop()
    helper?.stop()
  })
} else {
  app.quit()
}
