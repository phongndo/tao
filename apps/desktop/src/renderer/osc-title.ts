const OSC = '\x1b]'
const ESC = '\x1b'
const BEL = '\x07'
const ST = '\x1b\\'

const MAX_TITLE_CHARS = 80
const MAX_OSC_BUFFER_CHARS = 4096
const UNSAFE_TITLE_FORMATTING_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

export function sanitizeTerminalTitle(rawTitle: string): string | null {
  let withoutControls = ''
  let lastCopyStart = 0
  for (let index = 0; index < rawTitle.length; index++) {
    const code = rawTitle.charCodeAt(index)
    if (code >= 32 && code !== 127) continue

    withoutControls += rawTitle.slice(lastCopyStart, index) + ' '
    lastCopyStart = index + 1
  }

  if (lastCopyStart === 0) {
    withoutControls = rawTitle
  } else {
    withoutControls += rawTitle.slice(lastCopyStart)
  }

  const title = withoutControls
    .replace(UNSAFE_TITLE_FORMATTING_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (title.length === 0) return null
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title
}

export function createOscTitleScanner(onTitle: (title: string) => void): (chunk: string) => void {
  let buffer = ''

  return (chunk) => {
    if (chunk.length === 0) return

    if (buffer.length === 0) {
      const start = chunk.indexOf(OSC)
      if (start === -1) {
        buffer = chunk.endsWith(ESC) ? ESC : ''
        return
      }
      buffer = chunk.slice(start)
    } else {
      buffer += chunk
    }

    while (buffer.length > 0) {
      const start = buffer.indexOf(OSC)
      if (start === -1) {
        buffer = buffer.endsWith(ESC) ? ESC : ''
        return
      }

      if (start > 0) {
        buffer = buffer.slice(start)
      }

      const belEnd = buffer.indexOf(BEL, OSC.length)
      const stEnd = buffer.indexOf(ST, OSC.length)
      const usesBel = belEnd !== -1 && (stEnd === -1 || belEnd < stEnd)
      const end = usesBel ? belEnd : stEnd

      if (end === -1) {
        if (buffer.length > MAX_OSC_BUFFER_CHARS) {
          const nextEscape = buffer.lastIndexOf(ESC)
          buffer = nextEscape > 0 ? buffer.slice(nextEscape) : ''
        }
        return
      }

      const body = buffer.slice(OSC.length, end)
      buffer = buffer.slice(end + (usesBel ? BEL.length : ST.length))

      const separator = body.indexOf(';')
      if (separator <= 0) continue

      const command = body.slice(0, separator)
      if (command !== '0' && command !== '1' && command !== '2') continue

      const title = sanitizeTerminalTitle(body.slice(separator + 1))
      if (title) onTitle(title)
    }
  }
}
