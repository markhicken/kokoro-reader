import { nativeImage, type NativeImage } from 'electron'

const TURN = 2 * Math.PI

function spinnerTrail(angle: number, x: number, y: number): number {
  const distance = (angle - Math.atan2(y, x) + TURN * 2) % TURN / TURN
  return (1 - distance) ** 2
}

/** Draw a high-contrast spinner badge over the lower-right of the Windows tray icon. */
export function createWindowsSpinnerFrames(icon: NativeImage, count: number): NativeImage[] {
  if (icon.isEmpty()) return []
  const { width, height } = icon.getSize()
  const base = icon.toBitmap()
  const radius = Math.min(width, height) * 0.32
  const centerX = width - radius - 1
  const centerY = height - radius - 1

  return Array.from({ length: count }, (_, frame) => {
    const bitmap = Buffer.from(base)
    const angle = frame * TURN / count
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x + 0.5 - centerX
        const dy = y + 0.5 - centerY
        const distance = Math.hypot(dx, dy)
        if (distance >= radius) continue
        const brightness = distance > radius * 0.43 && distance < radius * 0.85
          ? 70 + Math.round(185 * spinnerTrail(angle, dx, dy)) : 28
        const offset = (y * width + x) * 4
        bitmap.fill(brightness, offset, offset + 3)
        bitmap[offset + 3] = 255
      }
    }
    return nativeImage.createFromBitmap(bitmap, { width, height })
  })
}

/** Match the menu-bar icon's 18-point footprint with template images for each display scale. */
export function createMacSpinnerFrames(count: number): NativeImage[] {
  return Array.from({ length: count }, (_, frame) => {
    const image = nativeImage.createEmpty()
    const angle = frame * TURN / count

    for (const scaleFactor of [1, 2]) {
      const size = 18 * scaleFactor
      const bitmap = Buffer.alloc(size * size * 4)
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = (x + 0.5) / scaleFactor - 9
          const dy = (y + 0.5) / scaleFactor - 9
          const distance = Math.abs(Math.hypot(dx, dy) - 6)
          const coverage = Math.max(0, Math.min(1, (1.1 - distance) * scaleFactor + 0.5))
          const opacity = 0.18 + 0.82 * spinnerTrail(angle, dx, dy)
          bitmap[(y * size + x) * 4 + 3] = Math.round(255 * coverage * opacity)
        }
      }
      image.addRepresentation({ scaleFactor, width: size, height: size, buffer: bitmap })
    }

    image.setTemplateImage(true)
    return image
  })
}
