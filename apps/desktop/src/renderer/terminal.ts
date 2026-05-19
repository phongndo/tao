import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
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
const OUTPUT_BATCH_MAX_CHARS = 256 * 1024
const taoSymbolsFontFamily = 'Tao Symbols Nerd Font Mono'
const taoSymbolsFontProbe = '\ue0a0\uf07b\ue7a8'
const warnedSnapshotBackends = new Set<string>()

const MIN_TERMINAL_COLS = 2
const MIN_TERMINAL_ROWS = 1

let terminalFontsLoad: Promise<void> | null = null

const terminalFitAddons = new WeakMap<Terminal, FitAddon>()
const terminalWebglAddons = new WeakMap<Terminal, WebglAddon>()

function updateStatus(msg: string) {
  if (window.location.protocol !== 'file:') {
    console.debug(`[terminal] ${msg}`)
  }
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

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getContainerContentSize(container: HTMLElement): { width: number; height: number } {
  const style = window.getComputedStyle(container)
  return {
    width: container.clientWidth - cssPixels(style.paddingLeft) - cssPixels(style.paddingRight),
    height: container.clientHeight - cssPixels(style.paddingTop) - cssPixels(style.paddingBottom),
  }
}

function fitTerminalToContainer(container: HTMLElement, term: Terminal): boolean {
  const fitAddon = terminalFitAddons.get(term)
  if (!fitAddon) return false

  const { width, height } = getContainerContentSize(container)
  if (width <= 0 || height <= 0) return false

  const dimensions = fitAddon.proposeDimensions()
  if (!dimensions) return false

  const cols = Math.max(MIN_TERMINAL_COLS, dimensions.cols)
  const rows = Math.max(MIN_TERMINAL_ROWS, dimensions.rows)
  if (cols === term.cols && rows === term.rows) return false

  fitAddon.fit()
  return true
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

function writeAndRefresh(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, () => {
      forceTerminalRender(term)
      resolve()
    })
  })
}

async function tryApplyCurrentScreenSnapshot(
  term: Terminal,
  frame: CurrentScreenSnapshotFrame,
): Promise<number> {
  if (frame.live === false) return 0

  try {
    const envelope = decodeCurrentScreenSnapshot(base64ToBytes(frame.dataBase64))
    if (isGhosttyNativeCurrentScreenSnapshot(envelope)) {
      const snapshot = decodeGhosttyNativeCurrentScreenSnapshotPayload(envelope.payload)
      if (snapshot.cols !== envelope.cols || snapshot.rows !== envelope.rows) return 0

      if (term.cols !== snapshot.cols || term.rows !== snapshot.rows) {
        term.resize(snapshot.cols, snapshot.rows)
      }

      await writeAndRefresh(term, ghosttyNativeCurrentScreenSnapshotToAnsi(snapshot))
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
    await writeAndRefresh(term, fallbackCurrentScreenSnapshotToAnsi(snapshot))
    return Math.max(frame.seq, envelope.seq)
  } catch (error) {
    console.warn('[terminal] ignored invalid current-screen snapshot:', error)
    return 0
  }
}

export function forceTerminalRender(term: Terminal): void {
  if (term.rows > 0) term.refresh(0, term.rows - 1)
}

async function revealTerminalAfterStableRender(
  container: HTMLElement,
  term: Terminal,
): Promise<void> {
  forceTerminalRender(term)
  // Show the window, then do one final fit/render before making the terminal surface visible.
  await window.electronAPI.signalReady()
  fitTerminalToContainer(container, term)
  forceTerminalRender(term)
  // Wait for Chromium to present the final post-attach resize/render. Without this gate, cold
  // replay can briefly show historical replay dimensions before the current pane fit is applied.
  await nextAnimationFrame()
  await nextAnimationFrame()
  container.classList.remove('terminal-surface-restoring')
}

function observeTerminalResize(container: HTMLElement, term: Terminal): () => void {
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

      fitTerminalToContainer(container, term)
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
  scheduleAnimationFit()

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

function installWebglRenderer(term: Terminal): void {
  const webglAddon = new WebglAddon()
  const contextLoss = webglAddon.onContextLoss(() => {
    console.warn(
      '[terminal] WebGL renderer context lost; falling back to xterm.js default renderer',
    )
    contextLoss.dispose()
    terminalWebglAddons.delete(term)
    webglAddon.dispose()
    forceTerminalRender(term)
  })

  try {
    term.loadAddon(webglAddon)
    terminalWebglAddons.set(term, webglAddon)
  } catch (error) {
    contextLoss.dispose()
    webglAddon.dispose()
    console.warn('[terminal] WebGL renderer unavailable; using xterm.js default renderer:', error)
  }
}

function binaryStringToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length)
  for (let index = 0; index < data.length; index++) {
    bytes[index] = data.charCodeAt(index) & 0xff
  }
  return bytes
}

function createBatchedTerminalWriter(term: Terminal): {
  write(data: string): void
  flush(): void
  dispose(): void
} {
  let chunks: string[] = []
  let queuedChars = 0
  let flushTimer: number | null = null
  let disposed = false

  function clearFlushTimer() {
    if (flushTimer === null) return
    window.clearTimeout(flushTimer)
    flushTimer = null
  }

  function flush() {
    clearFlushTimer()
    if (disposed || chunks.length === 0) return

    const data = chunks.join('')
    chunks = []
    queuedChars = 0
    term.write(data)
  }

  function scheduleFlush() {
    if (flushTimer !== null) return
    flushTimer = window.setTimeout(flush, 0)
  }

  return {
    write(data: string) {
      if (disposed || data.length === 0) return
      chunks.push(data)
      queuedChars += data.length
      if (queuedChars >= OUTPUT_BATCH_MAX_CHARS) {
        flush()
        return
      }
      scheduleFlush()
    },
    flush,
    dispose() {
      flush()
      disposed = true
      clearFlushTimer()
      chunks = []
      queuedChars = 0
    },
  }
}

export function setTerminalCursorVisible(term: Terminal, visible: boolean) {
  term.options = {
    cursorInactiveStyle: visible ? 'outline' : 'none',
    theme: {
      ...THEME,
      cursor: visible ? THEME.cursor : THEME.background,
      cursorAccent: visible ? THEME.cursorAccent : THEME.background,
    },
  }
  forceTerminalRender(term)
}

export async function createTerminal(
  container: HTMLElement,
  sessionId: string,
  options: CreateTerminalOptions = {},
): Promise<Terminal> {
  // Step 1: Load terminal fonts before starting the shell. The PTY must be
  // spawned at the fitted terminal size, otherwise shell prompts with right-side content
  // render against the initial 80x24 size and leave stale fragments after pane splits.
  updateStatus('Loading terminal fonts...')

  const t0 = performance.now()
  const fontsReady = loadTerminalFonts()
  let term: Terminal | null = null

  try {
    await fontsReady
    updateStatus(`Terminal fonts ready in ${(performance.now() - t0).toFixed(0)}ms`)

    // Step 2: Create the xterm.js terminal and its fit addon.
    updateStatus('Creating terminal...')

    term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: 14,
      fontFamily: terminalFontFamily,
      theme: THEME,
      cursorBlink: false,
      cursorStyle: 'block',
      cursorInactiveStyle: 'none',
      scrollback: 10000,
      allowTransparency: false,
      convertEol: false,
      customGlyphs: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      minimumContrastRatio: 1,
      rescaleOverlappingGlyphs: false,
      screenReaderMode: false,
      smoothScrollDuration: 0,
      allowProposedApi: false,
      logLevel: 'warn',
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    terminalFitAddons.set(term, fitAddon)

    // Step 3: Clear container and open terminal
    updateStatus('Opening terminal...')

    // Clear any previous content (status messages, old terminal instances)
    while (container.firstChild) {
      container.removeChild(container.firstChild)
    }

    container.classList.add('terminal-surface-restoring')
    term.open(container)
    installWebglRenderer(term)
  } catch (err) {
    console.error('[terminal] term.open() threw:', err)
    term?.dispose()
    renderTerminalError(container, err)
    throw err
  }

  if (!term) {
    throw new Error('Terminal failed to initialize')
  }
  const openedTerm = term

  // Step 4: Wire IPC
  updateStatus('Wiring IPC...')

  const outputWriter = createBatchedTerminalWriter(openedTerm)
  const titleSubscription = options.onTitle ? openedTerm.onTitleChange(options.onTitle) : null
  let stopResizeObserver: (() => void) | null = null
  let archived = false
  let bufferingStartupOutput = true
  let bufferedStartupChars = 0
  let pendingStartupSnapshot: CurrentScreenSnapshotFrame | null = null
  let suppressOutputThroughSeq = 0
  const bufferedStartupOutput: OutputFrame[] = []

  await nextAnimationFrame()
  fitTerminalToContainer(container, term)

  function writePtyData(data: string) {
    outputWriter.write(data)
  }

  async function writePtyDataAndWait(data: string): Promise<void> {
    outputWriter.flush()
    await writeAndRefresh(openedTerm, data)
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

  async function flushStartupOutput(skipThroughSeq: number): Promise<void> {
    bufferingStartupOutput = false
    if (bufferedStartupOutput.length === 0) return

    const data = bufferedStartupOutput
      .filter((frame) => frame.seq <= 0 || frame.seq > skipThroughSeq)
      .map((frame) => frame.data)
      .join('')
    bufferedStartupOutput.length = 0
    bufferedStartupChars = 0
    if (data.length > 0) await writePtyDataAndWait(data)
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

  term.onBinary((data: string) => {
    if (archived) return
    window.electronAPI.writeSessionInput(sessionId, binaryStringToBytes(data))
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
    outputWriter.flush()
    term.write(`\r\n\x1b[31m[Session Error: ${error}]\x1b[0m\r\n`)
  })

  const unsubSessionExit = window.electronAPI.onSessionExit(
    sessionId,
    (info: { exitCode: number; signal?: number }) => {
      const msg =
        info.signal != null
          ? `Shell killed by signal ${info.signal}`
          : `Shell exited with code ${info.exitCode}`
      outputWriter.flush()
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
    fitTerminalToContainer(container, term)
    // Startup output can arrive between attach:ok and the final fit above. Writing it before the
    // final resize makes the renderer preserve/reflow the early shell prompt at the wrong origin,
    // which presents as a blank terminal until the next input-triggered repaint. Flush only after
    // the terminal dimensions have settled for first paint.
    await nextAnimationFrame()
    // Fresh shells do not need a current-screen restore: the renderer already buffered all startup
    // output before attach completes. Applying the daemon snapshot here can capture/replay an
    // in-progress prompt restore (notably zsh/starship right-prompt cursor movement), leaving the
    // visible cursor far to the right in brand-new tabs. Keep snapshots for live/resumed attaches,
    // where they are needed to hydrate an existing screen without replaying full scrollback.
    if (pendingStartupSnapshot) {
      if (!archived && attachedSession.attachMode !== 'fresh') {
        suppressOutputThroughSeq = await tryApplyCurrentScreenSnapshot(term, pendingStartupSnapshot)
      }
      pendingStartupSnapshot = null
    }
    await flushStartupOutput(suppressOutputThroughSeq)
    await revealTerminalAfterStableRender(container, term)
  } catch (err) {
    unsubSessionOutput()
    unsubSessionSnapshot()
    unsubSessionResize()
    unsubSessionError()
    unsubSessionExit()
    titleSubscription?.dispose()
    outputWriter.dispose()
    term.dispose()
    container.classList.remove('terminal-surface-restoring')
    renderTerminalError(container, err)
    throw err
  }

  stopResizeObserver = observeTerminalResize(container, term)

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
    titleSubscription?.dispose()
    outputWriter.dispose()
    void window.electronAPI.detachSession(sessionId)
    stopResizeObserver?.()
    stopResizeObserver = null
    terminalFitAddons.delete(term)
    terminalWebglAddons.delete(term)
    container.classList.remove('terminal-surface-restoring')
    originalDispose()
  }

  updateStatus('Setup complete')
  return term
}
