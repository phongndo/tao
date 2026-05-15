import { FitAddon, Ghostty, Terminal } from 'ghostty-web'
import { createOscTitleScanner } from './osc-title'

type CreateTerminalOptions = {
  readonly cwd?: string
  readonly onTitle?: (title: string) => void
}

/**
 * Tau Default — based on Mellow by @kvparik (shipped with Ghostty).
 * https://github.com/ghostty-org/ghostty
 */
const THEME = {
  background: '#151515',
  foreground: '#c9c7cd',
  cursor: '#cac9dd',
  cursorAccent: '#151515',
  selectionBackground: '#2a2a2d',
  selectionForeground: '#c1c0d4',
  black: '#27272a',
  red: '#f5a191',
  green: '#90b99f',
  yellow: '#e6b99d',
  blue: '#aca1cf',
  magenta: '#e29eca',
  cyan: '#ea83a5',
  white: '#c1c0d4',
  brightBlack: '#424246',
  brightRed: '#ffae9f',
  brightGreen: '#9dc6ac',
  brightYellow: '#f0c5a9',
  brightBlue: '#b9aeda',
  brightMagenta: '#ecaad6',
  brightCyan: '#f591b2',
  brightWhite: '#cac9dd',
}

const terminalFontFamily =
  '"SF Mono", Menlo, Monaco, "JetBrains Mono", "JetBrainsMono Nerd Font Mono", "Tau Symbols Nerd Font Mono", "Symbols Nerd Font Mono", monospace'

const tauSymbolsFontFamily = 'Tau Symbols Nerd Font Mono'
const tauSymbolsFontProbe = '\ue0a0\uf07b\ue7a8'

let terminalFontsLoad: Promise<void> | null = null

let ghosttyLoad: Promise<Ghostty> | null = null

function updateStatus(msg: string) {
  if (window.location.protocol !== 'file:') {
    console.debug(`[terminal] ${msg}`)
  }
}

function loadGhostty(wasmUrl: string): Promise<Ghostty> {
  ghosttyLoad ??= Ghostty.load(wasmUrl).catch((error) => {
    ghosttyLoad = null
    throw error
  })

  return ghosttyLoad
}

async function loadTerminalFonts(): Promise<void> {
  if (!('fonts' in document) || typeof FontFace === 'undefined') return

  terminalFontsLoad ??= (async () => {
    const source = new URL('fonts/nerd-fonts/SymbolsNerdFontMono-Regular.ttf', window.location.href)
      .href
    const descriptor = `14px "${tauSymbolsFontFamily}"`
    let tauSymbolsFontFace = Array.from(document.fonts).find(
      (fontFace) => fontFace.family === tauSymbolsFontFamily,
    )

    if (!tauSymbolsFontFace) {
      tauSymbolsFontFace = new FontFace(tauSymbolsFontFamily, `url(${source})`, {
        style: 'normal',
        weight: '400',
        display: 'block',
      })

      document.fonts.add(tauSymbolsFontFace)
    }

    await tauSymbolsFontFace.load()
    await document.fonts.load(descriptor, tauSymbolsFontProbe)

    if (tauSymbolsFontFace.status !== 'loaded') {
      console.warn(`[terminal] bundled Nerd Font status: ${tauSymbolsFontFace.status}`)
    }
  })().catch((error) => {
    terminalFontsLoad = null
    console.warn('[terminal] failed to load bundled Nerd Font:', error)
  })

  return terminalFontsLoad
}

function renderTerminalError(container: HTMLElement, err: unknown) {
  const errorNode = document.createElement('div')
  errorNode.style.color = '#f7768e'
  errorNode.style.padding = '2rem'
  errorNode.style.fontFamily = 'monospace'
  errorNode.textContent = `Error opening terminal: ${String(err)}`
  container.replaceChildren(errorNode)
}

export function setTerminalCursorVisible(term: Terminal, visible: boolean) {
  term.renderer?.setTheme({
    ...THEME,
    cursor: visible ? THEME.cursor : THEME.background,
    cursorAccent: visible ? THEME.cursorAccent : THEME.background,
  })

  if (term.renderer && term.wasmTerm) {
    term.renderer.render(term.wasmTerm, true, term.viewportY, term)
  }
}

export async function createTerminal(
  container: HTMLElement,
  sessionId: string,
  options: CreateTerminalOptions = {},
): Promise<Terminal> {
  // Step 1: Load Ghostty WASM and PTY metadata in parallel.
  updateStatus('Loading Ghostty WASM...')
  const wasmUrl = new URL('ghostty-vt.wasm', window.location.href).href

  const t0 = performance.now()
  const ptyReady = window.electronAPI.spawnPty(sessionId, 80, 24, options.cwd)
  const fontsReady = loadTerminalFonts()
  let term: Terminal | null = null

  try {
    const [ghostty, { cols: initialCols, rows: initialRows }] = await Promise.all([
      loadGhostty(wasmUrl),
      ptyReady,
      fontsReady,
    ])
    updateStatus(`Ghostty WASM + PTY metadata ready in ${(performance.now() - t0).toFixed(0)}ms`)

    // Step 2: Create terminal instance (with pre-loaded Ghostty)
    updateStatus('Creating terminal...')

    term = new Terminal({
      ghostty, // Pass the pre-loaded Ghostty instance for instant open
      cols: initialCols,
      rows: initialRows,
      fontSize: 14,
      fontFamily: terminalFontFamily,
      theme: THEME,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 10000,
      allowTransparency: false,
    })

    // Step 3: Clear container and open terminal
    updateStatus('Opening terminal...')

    // Clear any previous content (status messages, old terminal instances)
    while (container.firstChild) {
      container.removeChild(container.firstChild)
    }

    term.open(container)
  } catch (err) {
    console.error('[terminal] term.open() threw:', err)
    term?.dispose()
    window.electronAPI.killPty(sessionId)
    renderTerminalError(container, err)
    throw err
  }

  if (!term) {
    window.electronAPI.killPty(sessionId)
    throw new Error('Terminal failed to initialize')
  }

  // Step 4: Wire IPC
  updateStatus('Wiring IPC...')

  const scanTitle = options.onTitle ? createOscTitleScanner(options.onTitle) : null

  const unsubPtyData = window.electronAPI.onPtyData(sessionId, (data: string) => {
    if (scanTitle) {
      try {
        scanTitle(data)
      } catch (error) {
        console.error('[terminal] title scanner error:', error)
      }
    }
    term.write(data)
  })

  // Terminal input → PTY (no debug overhead)
  term.onData((data: string) => {
    window.electronAPI.sendPtyInput(sessionId, data)
  })

  let pendingResize: { cols: number; rows: number } | null = null
  let resizeFrame: number | null = null

  term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
    pendingResize = { cols, rows }
    if (resizeFrame !== null) return

    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null
      const nextResize = pendingResize
      pendingResize = null
      if (nextResize) {
        window.electronAPI.resizePty(sessionId, nextResize.cols, nextResize.rows)
      }
    })
  })

  const unsubPtyError = window.electronAPI.onPtyError(sessionId, (error: string) => {
    console.error('[terminal] PTY error:', error)
    term.write(`\r\n\x1b[31m[PTY Error: ${error}]\x1b[0m\r\n`)
  })

  const unsubPtyExit = window.electronAPI.onPtyExit(
    sessionId,
    (info: { exitCode: number; signal?: number }) => {
      const msg =
        info.signal != null
          ? `Shell killed by signal ${info.signal}`
          : `Shell exited with code ${info.exitCode}`
      term.write(`\r\n\x1b[33m[${msg}]\x1b[0m\r\n`)
    },
  )

  // FitAddon
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  fitAddon.fit()
  fitAddon.observeResize()

  // Cleanup
  const originalDispose = term.dispose.bind(term)
  term.dispose = () => {
    if (resizeFrame !== null) {
      window.cancelAnimationFrame(resizeFrame)
      resizeFrame = null
    }
    pendingResize = null
    unsubPtyData()
    unsubPtyError()
    unsubPtyExit()
    fitAddon.dispose()
    originalDispose()
  }

  updateStatus('Setup complete')
  return term
}
