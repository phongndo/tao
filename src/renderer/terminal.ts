import { FitAddon, Ghostty, Terminal } from 'ghostty-web'

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
  '"Symbols Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "SF Mono", Menlo, Monaco, monospace'

function updateStatus(msg: string) {
  console.log(`[terminal] ${msg}`)
}

function renderTerminalError(container: HTMLElement, err: unknown) {
  const errorNode = document.createElement('div')
  errorNode.style.color = '#f7768e'
  errorNode.style.padding = '2rem'
  errorNode.style.fontFamily = 'monospace'
  errorNode.textContent = `Error opening terminal: ${String(err)}`
  container.replaceChildren(errorNode)
}

export async function createTerminal(container: HTMLElement, sessionId: string): Promise<Terminal> {
  // Step 1: Load Ghostty WASM and PTY metadata in parallel.
  updateStatus('Loading Ghostty WASM...')
  const wasmUrl = new URL('ghostty-vt.wasm', window.location.href).href
  console.log(`[terminal] Loading Ghostty WASM from ${wasmUrl}...`)

  const t0 = performance.now()
  const ptyReady = window.electronAPI.spawnPty(sessionId, 80, 24)
  let term: Terminal | null = null

  try {
    const [ghostty, { cols: initialCols, rows: initialRows }] = await Promise.all([
      Ghostty.load(wasmUrl),
      ptyReady,
    ])
    console.log(
      `[terminal] Ghostty WASM + PTY metadata loaded in ${(performance.now() - t0).toFixed(0)}ms`,
    )
    console.log(`[terminal] PTY size: ${initialCols}x${initialRows}`)

    // Step 2: Create terminal instance (with pre-loaded Ghostty)
    updateStatus('Creating terminal...')
    console.log('[terminal] Creating Terminal instance...')

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
    console.log('[terminal] Opening terminal...')

    // Clear any previous content (status messages, old terminal instances)
    while (container.firstChild) {
      container.removeChild(container.firstChild)
    }

    term.open(container)
    console.log('[terminal] Terminal opened')
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
  console.log('[terminal] Wiring IPC...')

  const unsubPtyData = window.electronAPI.onPtyData(sessionId, (data: string) => {
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
      console.log(`[terminal] ${msg}`)
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
    window.electronAPI.killPty(sessionId)
    fitAddon.dispose()
    originalDispose()
  }

  term.focus()
  console.log('[terminal] Setup complete ✓')
  return term
}
