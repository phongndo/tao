import { FitAddon, Ghostty, Terminal } from 'ghostty-web'
import { createOscTitleScanner } from './osc-title'

type CreateTerminalOptions = {
  readonly terminalId?: string
  readonly cwd?: string
  readonly onTitle?: (title: string) => void
  readonly onArchived?: () => void
}

/**
 * Tao Default — based on Mellow by @kvparik (shipped with Ghostty).
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
  '"SF Mono", Menlo, Monaco, "JetBrains Mono", "JetBrainsMono Nerd Font Mono", "Tao Symbols Nerd Font Mono", "Symbols Nerd Font Mono", monospace'

const SIDEBAR_RESIZE_FIT_DELAY_MS = 80
const taoSymbolsFontFamily = 'Tao Symbols Nerd Font Mono'
const taoSymbolsFontProbe = '\ue0a0\uf07b\ue7a8'

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
    const descriptor = `14px "${taoSymbolsFontFamily}"`
    let taoSymbolsFontFace = Array.from(document.fonts).find(
      (fontFace) => fontFace.family === taoSymbolsFontFamily,
    )

    if (!taoSymbolsFontFace) {
      taoSymbolsFontFace = new FontFace(taoSymbolsFontFamily, `url(${source})`, {
        style: 'normal',
        weight: '400',
        display: 'block',
      })

      document.fonts.add(taoSymbolsFontFace)
    }

    await taoSymbolsFontFace.load()
    await document.fonts.load(descriptor, taoSymbolsFontProbe)

    if (taoSymbolsFontFace.status !== 'loaded') {
      console.warn(`[terminal] bundled Nerd Font status: ${taoSymbolsFontFace.status}`)
    }
  })().catch((error) => {
    terminalFontsLoad = null
    console.warn('[terminal] failed to load bundled Nerd Font:', error)
  })

  return terminalFontsLoad
}

function renderTerminalError(container: HTMLElement, err: unknown) {
  container.classList.remove('terminal-surface-restoring')
  const errorNode = document.createElement('div')
  errorNode.style.color = '#f7768e'
  errorNode.style.padding = '2rem'
  errorNode.style.fontFamily = 'monospace'
  errorNode.textContent = `Error opening terminal: ${String(err)}`
  container.replaceChildren(errorNode)
}

function nextAnimationFrame(): Promise<void> {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
}

function forceTerminalRender(term: Terminal): void {
  if (term.renderer && term.wasmTerm) {
    term.renderer.render(term.wasmTerm, true, term.viewportY, term)
  }
}

async function revealTerminalAfterStableRender(
  container: HTMLElement,
  term: Terminal,
): Promise<void> {
  forceTerminalRender(term)
  // Wait for Chromium to present the final post-replay resize/render. Without this gate, cold replay
  // can briefly show historical replay dimensions before the current pane fit is applied.
  await nextAnimationFrame()
  await nextAnimationFrame()
  container.classList.remove('terminal-surface-restoring')
}

function observeTerminalResize(
  container: HTMLElement,
  term: Terminal,
  fitAddon: FitAddon,
): () => void {
  let resizeFrame: number | null = null
  let resizeSettleTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let lastWidth = container.clientWidth
  let lastHeight = container.clientHeight

  function scheduleAnimationFit() {
    if (resizeFrame !== null) return
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null
      if (disposed) return

      fitAddon.fit()
      forceTerminalRender(term)
    })
  }

  function scheduleFit() {
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer)
      resizeSettleTimer = null
    }

    if (document.body.classList.contains('sidebar-resizing')) {
      resizeSettleTimer = setTimeout(() => {
        resizeSettleTimer = null
        scheduleAnimationFit()
      }, SIDEBAR_RESIZE_FIT_DELAY_MS)
      return
    }

    scheduleAnimationFit()
  }

  const observer = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    const width = rect?.width ?? container.clientWidth
    const height = rect?.height ?? container.clientHeight
    if (width === lastWidth && height === lastHeight) return

    lastWidth = width
    lastHeight = height
    scheduleFit()
  })
  observer.observe(container)

  return () => {
    disposed = true
    observer.disconnect()
    if (resizeFrame !== null) {
      window.cancelAnimationFrame(resizeFrame)
      resizeFrame = null
    }
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer)
      resizeSettleTimer = null
    }
    container.classList.remove('terminal-surface-layout-pending')
  }
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
  // Step 1: Load Ghostty WASM/font metadata before starting the shell. The PTY must be
  // spawned at the fitted terminal size, otherwise shell prompts with right-side content
  // render against the initial 80x24 size and leave stale fragments after pane splits.
  updateStatus('Loading Ghostty WASM...')
  const wasmUrl = new URL('ghostty-vt.wasm', window.location.href).href

  const t0 = performance.now()
  const fontsReady = loadTerminalFonts()
  let term: Terminal | null = null

  try {
    const [ghostty] = await Promise.all([loadGhostty(wasmUrl), fontsReady])
    updateStatus(`Ghostty WASM + fonts ready in ${(performance.now() - t0).toFixed(0)}ms`)

    // Step 2: Create terminal instance (with pre-loaded Ghostty)
    updateStatus('Creating terminal...')

    term = new Terminal({
      ghostty, // Pass the pre-loaded Ghostty instance for instant open
      cols: 80,
      rows: 24,
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

    container.classList.add('terminal-surface-restoring')
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
  const fitAddon = new FitAddon()
  let stopResizeObserver: (() => void) | null = null
  let archived = false

  term.loadAddon(fitAddon)
  await nextAnimationFrame()
  fitAddon.fit()

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

  let applyingReplayResize = false
  const unsubSessionResize = window.electronAPI.onSessionResize(sessionId, (cols, rows) => {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
    if (cols === term.cols && rows === term.rows) return

    applyingReplayResize = true
    try {
      term.resize(Math.floor(cols), Math.floor(rows))
    } finally {
      applyingReplayResize = false
    }
  })

  // Terminal input → PTY (no debug overhead)
  term.onData((data: string) => {
    if (archived) return
    window.electronAPI.sendPtyInput(sessionId, data)
  })

  let pendingResize: { cols: number; rows: number } | null = null
  let resizeFrame: number | null = null

  term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
    if (applyingReplayResize) return

    pendingResize = { cols, rows }
    if (resizeFrame !== null) return

    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null
      const nextResize = pendingResize
      pendingResize = null
      if (nextResize && !archived) {
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

  try {
    const attachedSession = await window.electronAPI.attachSession({
      sessionId,
      terminalId: options.terminalId,
      cols: term.cols,
      rows: term.rows,
      cwd: options.cwd,
    })
    if (attachedSession.archived) {
      archived = true
      options.onArchived?.()
    }
    const initialPtySize = { cols: attachedSession.cols, rows: attachedSession.rows }
    if (initialPtySize.cols !== term.cols || initialPtySize.rows !== term.rows) {
      term.resize(initialPtySize.cols, initialPtySize.rows)
    }
    fitAddon.fit()
    await revealTerminalAfterStableRender(container, term)
  } catch (err) {
    unsubPtyData()
    unsubSessionResize()
    unsubPtyError()
    unsubPtyExit()
    fitAddon.dispose()
    term.dispose()
    window.electronAPI.killPty(sessionId)
    container.classList.remove('terminal-surface-restoring')
    renderTerminalError(container, err)
    throw err
  }

  stopResizeObserver = observeTerminalResize(container, term, fitAddon)

  // Cleanup
  const originalDispose = term.dispose.bind(term)
  term.dispose = () => {
    if (resizeFrame !== null) {
      window.cancelAnimationFrame(resizeFrame)
      resizeFrame = null
    }
    pendingResize = null
    unsubPtyData()
    unsubSessionResize()
    unsubPtyError()
    unsubPtyExit()
    void window.electronAPI.detachSession(sessionId)
    stopResizeObserver?.()
    stopResizeObserver = null
    container.classList.remove('terminal-surface-restoring')
    fitAddon.dispose()
    originalDispose()
  }

  updateStatus('Setup complete')
  return term
}
