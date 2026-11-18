import { BrowserWindow, screen, type Rectangle } from 'electron'

let overlay: BrowserWindow | undefined

export function showWindowsHighlight(bounds: Rectangle | null): void {
  if (!bounds) {
    overlay?.hide()
    return
  }

  if (!overlay) {
    overlay = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      focusable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      resizable: false,
      enableLargerThanScreen: true
    })
    overlay.setIgnoreMouseEvents(true)
    const html = '<!doctype html><html style="background:#ffda3760"></html>'
    void overlay.loadURL(`data:text/html,${encodeURIComponent(html)}`)
    overlay.on('closed', () => { overlay = undefined })
  }

  const paddedBounds = { x: bounds.x - 2, y: bounds.y - 1, width: bounds.width + 4, height: bounds.height + 2 }
  const windowBounds = screen.screenToDipRect(null, paddedBounds)
  overlay.setBounds(windowBounds)
  // Windows can enlarge small windows. Clip the overlay to the requested size.
  const { width, height } = windowBounds
  overlay.setShape([{ x: 0, y: 0, width, height }])
  overlay.showInactive()
}
