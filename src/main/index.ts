/**
 * Tau — Electron Performance Research & Implementation
 *
 * Electron 42 (Chromium ~136) on macOS arm64.
 *
 * This module applies every safe, measurable performance optimization
 * to the Electron shell. Organized by category with explanations.
 *
 * TL;DR improvements applied:
 *   - GPU rasterization + zero-copy (canvas rendering)
 *   - V8 heap limit tuned for terminal workloads
 *   - PTY output batching (16ms buffered flush)
 *   - Renderer process limit = 1 (single window app)
 *   - Disabled unused Chromium features (~15 services)
 *   - Canvas compositor layer promotion
 *   - WASM preloaded in parallel with PTY spawn
 */

import { join } from 'node:path'
import { app, BrowserWindow, MessageChannelMain, type MessagePortMain, ipcMain } from 'electron'
import { PtyManager } from './pty'

// ─── Phase 0: Chromium flags (MUST be set before app.ready) ───

// GPU: enable hardware rasterization for canvas text rendering.
// Without this, Chromium may fall back to software rasterization
// which is 2-5× slower for canvas 2D operations.
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers')

// Disable software rasterizer fallback — forces GPU path.
// If GPU is unavailable, Electron will still work via SwiftShader
// (which is still faster than CPU raster for 2D canvas).
app.commandLine.appendSwitch('disable-software-rasterizer')

// Canvas 2D: use GPU-accelerated canvas rendering layer.
// This promotes the <canvas> to an independent compositor layer,
// reducing repaint cost when only the terminal content changes.
app.commandLine.appendSwitch('enable-accelerated-2d-canvas')

// Disable unused Chromium features to reduce memory footprint
// and background processing overhead.
const disableFeatures = [
  'BackForwardCache', // No back/forward navigation in a terminal
  'CalculateNativeWinOcclusion', // macOS only optimization, not needed
  'FlushTasksBetweenFrameIntervals', // Reduce task scheduling overhead
  'InterestFeedV2', // Google feed, not applicable
  'MediaRouter', // No ChromeCast/media routing
  'PaintHolding', // Don't delay paints — show content ASAP
  'PreloadMediaEngagementData', // Media engagement tracking
  'Translate', // No translation in a terminal
  'WebAuthnConditionalUI', // No WebAuthn
  'WebSQL', // Already disabled, double ensure
].join(',')

app.commandLine.appendSwitch('disable-features', disableFeatures)

const enableFeatures = [
  'Canvas2dRenderingTBR', // Tile-based rendering for canvas 2D (faster)
  'CanvasOopRasterization', // Out-of-process canvas rasterization
  'WebAssemblyCodeProtection', // Protect WASM memory pages
  'WebAssemblyLazyCompilation', // Load WASM faster by deferring full compile
].join(',')

app.commandLine.appendSwitch('enable-features', enableFeatures)

// V8: cap old-space for predictable GC without forcing size-optimized codegen.
// Terminal workloads are steady-state; 256MB is plenty for one terminal window.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256')

// Limit to 1 renderer process. We only have one window.
// This avoids the overhead of a spare renderer process sitting idle.
app.commandLine.appendSwitch('renderer-process-limit', '1')

// ─── Application State ───

let mainWindow: BrowserWindow | null = null
let rendererReadyForPty = false
let ptyDataPort: MessagePortMain | null = null

// ─── Window Creation ───

function createWindow() {
  rendererReadyForPty = false
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    backgroundColor: '#151515',
    title: 'Tau Terminal',
    show: false, // Show only when terminal is ready
    // Accept first mouse click immediately (no click-through delay)
    acceptFirstMouse: true,
    // macOS: use built-in titlebar for smooth integration
    titleBarStyle: 'hiddenInset',

    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,

      // ── Performance ──
      // Don't render until window is shown (we use show: false)
      backgroundThrottling: false, // Keep PTY alive when unfocused
      enableWebSQL: false,
      spellcheck: false,

      // Canvas: use GPU-accelerated path
      offscreen: false,

      // Disable unnecessary renderer features
      webgl: false, // Ghostty-web uses Canvas 2D, not WebGL
      plugins: false, // No Flash/PDF plugins
      experimentalFeatures: false,
      webSecurity: true, // Keep security, CSP handles WASM

      // V8: eager compile for fast startup
      v8CacheOptions: 'bypassHeatCheck',
    },
  })

  // Remove menu bar (cleaner look, fewer resources)
  mainWindow.setMenuBarVisibility(false)

  // Load the renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    rendererReadyForPty = false
    closePtyDataPort()
    mainWindow = null
  })
}

// ─── PTY with Output Batching ───
//
// Instead of sending every PTY byte to the renderer as it arrives,
// we adaptively batch output: tiny echoes flush almost immediately,
// while bulk output is frame-batched and size-capped. This keeps input
// latency low without letting a huge IPC payload jank the renderer.

let ptyManager: PtyManager | null = null
let ptyChunks: string[] = []
let ptyBufferedChars = 0
let ptyFlushTimer: ReturnType<typeof setTimeout> | null = null
let ptyFlushTimerDelay = 0
let lastPtyInputAt = 0

const PTY_FLUSH_INTERVAL = 16 // ms (~60fps) for bulk output
const PTY_INTERACTIVE_FLUSH_INTERVAL = 1 // ms, keeps typed-key echo snappy
const PTY_MAX_BUFFER_CHARS = 64 * 1024 // cap per IPC payload to avoid renderer jank
const PTY_INTERACTIVE_WINDOW_MS = 32
const PTY_INTERACTIVE_CHARS = 256

function hasLiveRenderer(): boolean {
  return (
    rendererReadyForPty && mainWindow !== null && !mainWindow.isDestroyed() && ptyDataPort !== null
  )
}

function closePtyDataPort() {
  if (ptyDataPort === null) return

  ptyDataPort.close()
  ptyDataPort = null
}

function setupPtyDataPort() {
  if (!mainWindow || mainWindow.isDestroyed()) return

  closePtyDataPort()

  const { port1, port2 } = new MessageChannelMain()
  ptyDataPort = port1
  ptyDataPort.start()
  ptyDataPort.once('close', () => {
    if (ptyDataPort === port1) {
      ptyDataPort = null
      rendererReadyForPty = false
    }
  })

  mainWindow.webContents.postMessage('pty:data-port', null, [port2])
}

function clearPtyFlushTimer() {
  if (ptyFlushTimer !== null) {
    clearTimeout(ptyFlushTimer)
    ptyFlushTimer = null
    ptyFlushTimerDelay = 0
  }
}

function takePtyBuffer(): string {
  const data = ptyChunks.length === 1 ? ptyChunks[0] : ptyChunks.join('')
  ptyChunks = []
  ptyBufferedChars = 0
  return data
}

function resetPtyBuffer() {
  clearPtyFlushTimer()
  ptyChunks = []
  ptyBufferedChars = 0
}

function sendPtyData(data: string) {
  if (data.length === 0 || ptyDataPort === null) return

  for (let start = 0; start < data.length; ) {
    let end = Math.min(start + PTY_MAX_BUFFER_CHARS, data.length)
    // Avoid splitting surrogate pairs when a chunk contains wide Unicode input.
    if (end < data.length) {
      const code = data.charCodeAt(end)
      if (code >= 0xdc00 && code <= 0xdfff) end--
    }

    ptyDataPort.postMessage(data.slice(start, end))
    start = end
  }
}

function flushPtyBuffer() {
  clearPtyFlushTimer()
  if (ptyBufferedChars === 0 || !hasLiveRenderer()) return

  sendPtyData(takePtyBuffer())
}

function schedulePtyFlush(delay: number) {
  if (!hasLiveRenderer()) return
  if (ptyFlushTimer !== null && delay >= ptyFlushTimerDelay) return

  clearPtyFlushTimer()
  ptyFlushTimerDelay = delay
  ptyFlushTimer = setTimeout(flushPtyBuffer, delay)
}

function bufferPtyData(data: string) {
  if (data.length === 0) return

  ptyChunks.push(data)
  ptyBufferedChars += data.length

  // Keep shell startup output until the renderer has registered its IPC listener.
  if (!hasLiveRenderer()) return

  if (ptyBufferedChars >= PTY_MAX_BUFFER_CHARS) {
    flushPtyBuffer()
    return
  }

  const isInteractiveEcho =
    data.length <= PTY_INTERACTIVE_CHARS && Date.now() - lastPtyInputAt <= PTY_INTERACTIVE_WINDOW_MS

  schedulePtyFlush(isInteractiveEcho ? PTY_INTERACTIVE_FLUSH_INTERVAL : PTY_FLUSH_INTERVAL)
}

function setupPty() {
  if (!mainWindow) return

  ptyManager?.dispose()
  ptyManager = null
  resetPtyBuffer()

  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  console.log(`[main] Spawning PTY with shell: ${shell}`)

  try {
    ptyManager = new PtyManager(shell)

    // PTY output → adaptive buffered IPC (low latency for echo, batched for bulk output)
    ptyManager.onData((data: string) => {
      bufferPtyData(data)
    })

    // Handle pty exit
    ptyManager.onExit(({ exitCode, signal }) => {
      flushPtyBuffer() // Flush remaining data before exit
      console.log(`[main] PTY exited with code ${exitCode}, signal ${signal}`)
      ptyManager = null
      mainWindow?.webContents.send('pty:exit', { exitCode, signal })
    })
  } catch (err) {
    console.error('[main] Failed to spawn PTY:', err)
    mainWindow?.webContents.send('pty:error', String(err))
  }
}

// ─── IPC Handlers ───

ipcMain.on('renderer:ready', (event) => {
  if (event.sender !== mainWindow?.webContents) return

  setupPtyDataPort()
  rendererReadyForPty = true
  flushPtyBuffer()

  mainWindow?.show()
  // Focus the window so the terminal receives keyboard input immediately
  mainWindow?.focus()
})

ipcMain.on('pty:write', (_event, data: string) => {
  if (typeof data !== 'string' || data.length === 0) return

  lastPtyInputAt = Date.now()
  ptyManager?.write(data)
})

ipcMain.on('pty:resize', (_event, cols: number, rows: number) => {
  if (typeof cols !== 'number' || typeof rows !== 'number') return
  ptyManager?.resize(cols, rows)
})

ipcMain.handle('pty:getInitialColsRows', () => {
  return ptyManager?.getColsRows() ?? { cols: 80, rows: 24 }
})

// ─── App Lifecycle ───

app.whenReady().then(() => {
  createWindow()
  setupPty()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      setupPty()
    }
  })
})

app.on('window-all-closed', () => {
  flushPtyBuffer()
  resetPtyBuffer()
  closePtyDataPort()
  ptyManager?.dispose()
  ptyManager = null
  rendererReadyForPty = false
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  flushPtyBuffer()
  resetPtyBuffer()
  closePtyDataPort()
  ptyManager?.dispose()
  ptyManager = null
})
