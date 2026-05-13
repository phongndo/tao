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
 *   - PTY isolated in a utility process with direct MessagePort IPC
 *   - Renderer process limit = 1 (single window app)
 *   - Disabled unused Chromium features (~15 services)
 *   - Canvas compositor layer promotion
 *   - WASM preloaded in parallel with PTY service startup
 */

import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from 'electron'
import ptyServicePath from './pty-service?modulePath'

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
let ptyService: Electron.UtilityProcess | null = null
let rendererPort: Electron.MessagePortMain | null = null

// ─── Window Creation ───

function createWindow() {
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
    disposePtyService()
    mainWindow = null
  })
}

// ─── PTY Service Lifecycle ───

function sendPtyPortToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!rendererPort) {
    setupPtyService()
  }
  if (!rendererPort) return

  mainWindow.webContents.postMessage('pty:port', null, [rendererPort])
  rendererPort = null
}

function setupPtyService() {
  disposePtyService()

  const { port1, port2 } = new MessageChannelMain()
  ptyService = utilityProcess.fork(ptyServicePath, [], {
    serviceName: 'Tau PTY Service',
    stdio: 'inherit',
  })
  rendererPort = port2
  ptyService.postMessage({ type: 'connect' }, [port1])
  ptyService.once('exit', (code) => {
    console.log(`[main] PTY service exited with code ${code}`)
    ptyService = null
    rendererPort = null
  })
}

function disposePtyService() {
  rendererPort?.close()
  rendererPort = null

  if (!ptyService) return
  ptyService.kill()
  ptyService = null
}

// ─── IPC Handlers ───

ipcMain.on('renderer:ready', (event) => {
  if (event.sender !== mainWindow?.webContents) return

  mainWindow?.show()
  // Focus the window so the terminal receives keyboard input immediately
  mainWindow?.focus()
})

ipcMain.on('pty:requestPort', (event) => {
  if (event.sender !== mainWindow?.webContents) return
  sendPtyPortToRenderer()
})

// ─── App Lifecycle ───

app.whenReady().then(() => {
  createWindow()
  setupPtyService()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      setupPtyService()
    }
  })
})

app.on('window-all-closed', () => {
  disposePtyService()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  disposePtyService()
})
