const MAC_MODIFIERS: Record<string, string> = { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' }
const WINDOWS_MODIFIERS: Record<string, string> = { Control: 'Ctrl', Super: 'Win' }

export function formatHotkey(accelerator: string, windows: boolean): string {
  const parts = accelerator.split('+')
  if (windows) return parts.map((part) => WINDOWS_MODIFIERS[part] ?? part).join(' + ')
  const key = parts.pop() ?? ''
  const modifiers = parts.map((part) => MAC_MODIFIERS[part] ?? part).join('')
  return modifiers ? `${modifiers} ${key}` : key
}
