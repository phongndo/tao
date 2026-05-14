const TERMINAL_FONT_FALLBACK = [
  'monospace',
  '"Symbols Nerd Font Mono"',
  '"Symbols Nerd Font"',
].join(', ')

function quoteFontFamily(fontFamily: string): string {
  const trimmedFontFamily = fontFamily.trim()
  if (trimmedFontFamily.length === 0) return ''
  if (trimmedFontFamily.includes(',')) return trimmedFontFamily
  if (/^["'].*["']$/.test(trimmedFontFamily)) return trimmedFontFamily
  return `"${trimmedFontFamily.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function getTerminalFontFamily(preferredFontFamily?: string): string {
  const preferred = preferredFontFamily ? quoteFontFamily(preferredFontFamily) : ''
  return preferred ? `${preferred}, ${TERMINAL_FONT_FALLBACK}` : TERMINAL_FONT_FALLBACK
}
