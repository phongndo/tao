import { FitAddon, Ghostty, Terminal } from 'ghostty-web'
import {
  decodeCurrentScreenSnapshot,
  decodeFallbackCurrentScreenSnapshotPayload,
  decodeGhosttyNativeCurrentScreenSnapshotPayload,
  fallbackCurrentScreenSnapshotToAnsi,
  ghosttyNativeCurrentScreenSnapshotToAnsi,
  isGhosttyNativeCurrentScreenSnapshot,
  isFallbackCurrentScreenSnapshot,
} from '@tao/shared/current-screen-snapshot'
import type {
  AttachSessionResult,
  CurrentScreenSnapshotFrame,
  OutputFrame,
} from '@tao/shared/taod-protocol'
import { createOscTitleScanner } from './osc-title'

type CreateTerminalOptions = {
  readonly terminalId?: string
  readonly cwd?: string
  readonly onTitle?: (title: string) => void
  readonly onArchived?: () => void
  readonly onAttach?: (result: AttachSessionResult) => void
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
const STARTUP_OUTPUT_BUFFER_MAX_CHARS = 1024 * 1024
const taoSymbolsFontFamily = 'Tao Symbols Nerd Font Mono'
const taoSymbolsFontProbe = '\ue0a0\uf07b\ue7a8'
const warnedSnapshotBackends = new Set<string>()

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

function base64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function warnUnsupportedSnapshotBackend(backendName: string) {
  if (warnedSnapshotBackends.has(backendName)) return
  warnedSnapshotBackends.add(backendName)
  console.warn(`[terminal] current-screen snapshot backend is not renderable yet: ${backendName}`)
}

function tryApplyCurrentScreenSnapshot(term: Terminal, frame: CurrentScreenSnapshotFrame): number {
  if (frame.live === false) return 0

  try {
    const envelope = decodeCurrentScreenSnapshot(base64ToBytes(frame.dataBase64))
    if (isGhosttyNativeCurrentScreenSnapshot(envelope)) {
      const snapshot = decodeGhosttyNativeCurrentScreenSnapshotPayload(envelope.payload)
      if (snapshot.cols !== envelope.cols || snapshot.rows !== envelope.rows) return 0

      if (term.cols !== snapshot.cols || term.rows !== snapshot.rows) {
        term.resize(snapshot.cols, snapshot.rows)
      }

      term.write(ghosttyNativeCurrentScreenSnapshotToAnsi(snapshot))
      forceTerminalRender(term)
      return Math.max(frame.seq, envelope.seq)
    }

    if (!isFallbackCurrentScreenSnapshot(envelope)) {
      warnUnsupportedSnapshotBackend(envelope.backendName)
      return 0
    }

    const snapshot = decodeFallbackCurrentScreenSnapshotPayload(envelope.payload)
    if (snapshot.cols !== envelope.cols || snapshot.rows !== envelope.rows) return 0

    if (term.cols !== snapshot.cols || term.rows !== snapshot.rows) {
      term.resize(snapshot.cols, snapshot.rows)
    }

    // This consumes only the daemon's live current-screen frame. It is deliberately not event-log
    // scrollback replay, and the daemon cold-start path does not feed persisted snapshots into it.
    term.write(fallbackCurrentScreenSnapshotToAnsi(snapshot))
    forceTerminalRender(term)
    return Math.max(frame.seq, envelope.seq)
  } catch (error) {
    console.warn('[terminal] ignored invalid current-screen snapshot:', error)
    return 0
  }
}

export function forceTerminalRender(term: Terminal): void {
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
    void window.electronAPI.killSession(sessionId)
    renderTerminalError(container, err)
    throw err
  }

  if (!term) {
    void window.electronAPI.killSession(sessionId)
    throw new Error('Terminal failed to initialize')
  }
  const openedTerm = term

  // Step 4: Wire IPC
  updateStatus('Wiring IPC...')

  const scanTitle = options.onTitle ? createOscTitleScanner(options.onTitle) : null
  const fitAddon = new FitAddon()
  let stopResizeObserver: (() => void) | null = null
  let archived = false
  let bufferingStartupOutput = true
  let bufferedStartupChars = 0
  let pendingStartupSnapshot: CurrentScreenSnapshotFrame | null = null
  let suppressOutputThroughSeq = 0
  const bufferedStartupOutput: OutputFrame[] = []

  term.loadAddon(fitAddon)
  await nextAnimationFrame()
  fitAddon.fit()

  function writePtyData(data: string) {
    if (scanTitle) {
      try {
        scanTitle(data)
      } catch (error) {
        console.error('[terminal] title scanner error:', error)
      }
    }
    openedTerm.write(data)
  }

  function bufferStartupFrame(frame: OutputFrame) {
    if (frame.data.length === 0) return
    bufferedStartupOutput.push(frame)
    bufferedStartupChars += frame.data.length

    while (
      bufferedStartupChars > STARTUP_OUTPUT_BUFFER_MAX_CHARS &&
      bufferedStartupOutput.length > 1
    ) {
      bufferedStartupChars -= bufferedStartupOutput.shift()?.data.length ?? 0
    }

    if (
      bufferedStartupChars > STARTUP_OUTPUT_BUFFER_MAX_CHARS &&
      bufferedStartupOutput.length === 1
    ) {
      bufferedStartupOutput[0] = {
        ...bufferedStartupOutput[0]!,
        data: bufferedStartupOutput[0]!.data.slice(-STARTUP_OUTPUT_BUFFER_MAX_CHARS),
      }
      bufferedStartupChars = bufferedStartupOutput[0]!.data.length
    }
  }

  function flushStartupOutput(skipThroughSeq: number) {
    bufferingStartupOutput = false
    if (bufferedStartupOutput.length === 0) return

    const data = bufferedStartupOutput
      .filter((frame) => frame.seq <= 0 || frame.seq > skipThroughSeq)
      .map((frame) => frame.data)
      .join('')
    bufferedStartupOutput.length = 0
    bufferedStartupChars = 0
    if (data.length > 0) writePtyData(data)
  }

  const unsubSessionOutput = window.electronAPI.onSessionOutput(sessionId, (frame) => {
    if (suppressOutputThroughSeq > 0 && frame.seq > 0 && frame.seq <= suppressOutputThroughSeq) {
      return
    }

    if (bufferingStartupOutput) {
      bufferStartupFrame(frame)
      return
    }

    writePtyData(frame.data)
  })

  const unsubSessionSnapshot = window.electronAPI.onSessionSnapshot(sessionId, (frame) => {
    if (!bufferingStartupOutput || archived) return
    pendingStartupSnapshot = frame
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
    window.electronAPI.writeSessionInput(sessionId, new TextEncoder().encode(data))
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
        window.electronAPI.resizeSession(sessionId, nextResize.cols, nextResize.rows)
      }
    })
  })

  const unsubSessionError = window.electronAPI.onSessionError(sessionId, (error: string) => {
    console.error('[terminal] Session error:', error)
    term.write(`\r\n\x1b[31m[Session Error: ${error}]\x1b[0m\r\n`)
  })

  const unsubSessionExit = window.electronAPI.onSessionExit(
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
    options.onAttach?.(attachedSession)
    const initialPtySize = { cols: attachedSession.cols, rows: attachedSession.rows }
    if (initialPtySize.cols !== term.cols || initialPtySize.rows !== term.rows) {
      term.resize(initialPtySize.cols, initialPtySize.rows)
    }
    fitAddon.fit()
    // Startup output can arrive between attach:ok and the final fit above. Writing it before the
    // final resize makes Ghostty preserve/reflow the early shell prompt at the wrong screen origin,
    // which presents as a blank terminal until the next input-triggered repaint. Flush only after
    // the terminal dimensions have settled for first paint.
    await nextAnimationFrame()
    if (!archived && pendingStartupSnapshot) {
      suppressOutputThroughSeq = tryApplyCurrentScreenSnapshot(term, pendingStartupSnapshot)
      pendingStartupSnapshot = null
    }
    flushStartupOutput(suppressOutputThroughSeq)
    await revealTerminalAfterStableRender(container, term)
  } catch (err) {
    unsubSessionOutput()
    unsubSessionSnapshot()
    unsubSessionResize()
    unsubSessionError()
    unsubSessionExit()
    fitAddon.dispose()
    term.dispose()
    void window.electronAPI.killSession(sessionId)
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
    unsubSessionOutput()
    unsubSessionSnapshot()
    unsubSessionResize()
    unsubSessionError()
    unsubSessionExit()
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
