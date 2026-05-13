import { Ghostty, Terminal, FitAddon } from 'ghostty-web'

/**
 * Tokyo Night Storm theme.
 */
const THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#364A82',
  selectionForeground: '#c0caf5',
  black: '#32344a',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#ad8ee6',
  cyan: '#449dab',
  white: '#9699a8',
  brightBlack: '#444b6a',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#bb9af7',
  brightCyan: '#0db9d7',
  brightWhite: '#acb0d0',
}

function updateStatus(msg: string) {
  const container = document.getElementById('terminal-container')
  if (container && !container.querySelector('canvas')) {
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;font-family:monospace;padding:2rem;">
        <pre style="color:#9ece6a;text-align:center;max-width:90%;overflow:auto;">${msg}</pre>
        <p style="margin-top:1rem;color:#9699a8;font-size:12px;">Tau Terminal — Ghostty WASM + node-pty</p>
      </div>
    `
  }
}

export async function createTerminal(container: HTMLElement): Promise<Terminal> {
  // Step 1: Load Ghostty WASM explicitly from the public path
  updateStatus('Loading Ghostty WASM...')
  console.log('[terminal] Loading Ghostty WASM from /ghostty-vt.wasm...')

  let t0 = performance.now()
  const ghostty = await Ghostty.load('/ghostty-vt.wasm')
  console.log(`[terminal] Ghostty WASM loaded in ${(performance.now() - t0).toFixed(0)}ms`)

  // Step 2: Get PTY dimensions
  console.log('[terminal] Getting initial PTY dimensions...')
  const { cols: initialCols, rows: initialRows } =
    await window.electronAPI.getInitialColsRows()
  console.log(`[terminal] PTY size: ${initialCols}x${initialRows}`)

  // Step 3: Create terminal instance (with pre-loaded Ghostty)
  updateStatus('Creating terminal...')
  console.log('[terminal] Creating Terminal instance...')

  const term = new Terminal({
    ghostty, // Pass the pre-loaded Ghostty instance for instant open
    cols: initialCols,
    rows: initialRows,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: THEME,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    allowTransparency: false,
  })

  // Step 4: Clear container and open terminal
  updateStatus('Opening terminal...')
  console.log('[terminal] Opening terminal...')

  // Clear any previous content (status messages, old terminal instances)
  while (container.firstChild) {
    container.removeChild(container.firstChild)
  }

  try {
    term.open(container)
    console.log('[terminal] Terminal opened')
  } catch (err) {
    console.error('[terminal] term.open() threw:', err)
    container.innerHTML = `<div style="color:#f7768e;padding:2rem;font-family:monospace;">Error opening terminal: ${err}</div>`
    throw err
  }

  // Step 5: Wire IPC
  console.log('[terminal] Wiring IPC...')

  const unsubPtyData = window.electronAPI.onPtyData((data: string) => {
    term.write(data)
  })

  term.onData((data: string) => {
    window.electronAPI.sendPtyInput(data)
  })

  term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
    window.electronAPI.resizePty(cols, rows)
  })

  const unsubPtyError = window.electronAPI.onPtyError((error: string) => {
    console.error('[terminal] PTY error:', error)
    term.write(`\r\n\x1b[31m[PTY Error: ${error}]\x1b[0m\r\n`)
  })

  const unsubPtyExit = window.electronAPI.onPtyExit(
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
    unsubPtyData()
    unsubPtyError()
    unsubPtyExit()
    fitAddon.dispose()
    originalDispose()
  }

  term.focus()
  console.log('[terminal] Setup complete ✓')
  return term
}
