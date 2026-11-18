import { BaseWindow, nativeTheme, type BrowserWindow } from 'electron'
import { release } from 'node:os'

const BACKDROP_INSET = 8

export function attachWindowsOverlayBackdrop(win: BrowserWindow): void {
  // Electron's acrylic material is available starting with Windows 11 22H2.
  if (Number(release().split('.')[2]) < 22621) return

  let backdrop: BaseWindow | undefined
  const getBackdropBounds = () => {
    const { x, y, width, height } = win.getContentBounds()
    return {
      x: x + BACKDROP_INSET,
      y: y + BACKDROP_INSET,
      width: width - BACKDROP_INSET * 2,
      height: height - BACKDROP_INSET * 2
    }
  }
  const hide = () => {
    if (backdrop && !backdrop.isDestroyed()) backdrop.hide()
  }
  const show = () => {
    if (!win.isVisible() || win.isMinimized()) return
    if (nativeTheme.prefersReducedTransparency || nativeTheme.shouldUseHighContrastColors) {
      hide()
      return
    }
    const bounds = getBackdropBounds()
    if (bounds.width <= 0 || bounds.height <= 0) {
      hide()
      return
    }
    if (!backdrop || backdrop.isDestroyed()) {
      backdrop = new BaseWindow({
        ...bounds,
        show: false,
        frame: false,
        thickFrame: false,
        transparent: true,
        backgroundMaterial: 'acrylic',
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false
      })
      backdrop.setIgnoreMouseEvents(true)
    }
    backdrop.setBounds(bounds)
    if (backdrop.isVisible()) return
    backdrop.showInactive()
    backdrop.moveTop()
    win.moveAbove(backdrop.getMediaSourceId())
  }
  const syncBounds = () => {
    if (!backdrop || backdrop.isDestroyed() || !backdrop.isVisible()) return
    const bounds = getBackdropBounds()
    if (bounds.width > 0 && bounds.height > 0) backdrop.setBounds(bounds)
    else hide()
  }

  win.on('show', show)
  win.on('hide', hide)
  win.on('minimize', hide)
  win.on('restore', show)
  // Hide the separate blur surface during a native drag so it cannot trail the panel.
  win.on('will-move', hide)
  win.on('will-resize', hide)
  win.on('moved', show)
  win.on('resized', show)
  win.on('move', syncBounds)
  win.on('resize', syncBounds)
  win.once('closed', () => {
    if (backdrop && !backdrop.isDestroyed()) backdrop.destroy()
  })
}
