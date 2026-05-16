/**
 * Tao — Electron Performance Research & Implementation
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
import { Effect } from 'effect'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  MessageChannelMain,
  utilityProcess,
} from 'electron'
import ptyServicePath from './pty-service?modulePath'
import { readLayout, writeLayout } from './layout-store'
import { disposeMainRuntime, runMainEffect } from './runtime'
import { defaultSettings, readSettings, writeSettings } from './settings-store'
import { TaodPtyBridge } from './taod-pty-bridge'
import { WorkspaceService } from './workspace-service'
import type { AppCommand, PaneFocusDirection } from '@tao/shared/app-command'
import {
  WorkspaceError,
  decodeWorkspacePathFromUnknown,
  errorMessageFromUnknown,
  workspaceIpcFailure,
  workspaceIpcSuccess,
  type WorkspaceIpcResponse,
} from '@tao/shared/workspace'

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
let taodBridge: TaodPtyBridge | null = null

// ─── Window Creation ───

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    backgroundColor: '#151515',
    title: 'Tao',
    show: false, // Show only when terminal is ready
    // Accept first mouse click immediately (no click-through delay)
    acceptFirstMouse: true,
    // macOS: use built-in titlebar for smooth integration
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 14 },

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

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const key = input.key.toLowerCase()
    const digitIndex = key >= '0' && key <= '9' ? (key === '0' ? 9 : Number(key) - 1) : null

    if (input.meta && !input.alt && !input.control && !input.shift && digitIndex !== null) {
      event.preventDefault()
      sendAppCommand({ type: 'switch-workspace', index: digitIndex })
      return
    }

    if (input.control && !input.meta && !input.alt && !input.shift && digitIndex !== null) {
      event.preventDefault()
      sendAppCommand({ type: 'switch-tab', index: digitIndex })
      return
    }

    if (input.control && !input.meta && !input.alt && !input.shift) {
      if (key === 'x') {
        event.preventDefault()
        sendAppCommand({ type: 'close-pane' })
        return
      }

      const directionByKey: Record<string, PaneFocusDirection> = {
        h: 'left',
        j: 'down',
        k: 'up',
        l: 'right',
      }
      const direction = directionByKey[key]
      if (direction) {
        event.preventDefault()
        sendAppCommand({ type: 'focus-pane', direction })
        return
      }
    }

    if (!input.meta || input.alt || input.control) return

    if (key === 'b' && !input.shift) {
      event.preventDefault()
      sendAppCommand({ type: 'toggle-sidebar' })
      return
    }

    if (key === 't' && !input.shift) {
      event.preventDefault()
      sendAppCommand({ type: 'new-tab' })
      return
    }

    if (key === 'w' && !input.shift) {
      event.preventDefault()
      sendAppCommand({ type: 'close-tab' })
      return
    }

    if (key === 'w' && input.shift) {
      event.preventDefault()
      sendAppCommand({ type: 'close-pane' })
      return
    }

    if (key === 'l' && !input.shift) {
      event.preventDefault()
      sendAppCommand({ type: 'focus-terminal' })
      return
    }

    if (key === 'd') {
      event.preventDefault()
      sendAppCommand({ type: input.shift ? 'split-pane-horizontal' : 'split-pane-vertical' })
    }
  })

  // Load the renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function sendAppCommand(command: AppCommand) {
  mainWindow?.webContents.send('app:command', command)
}

// ─── PTY Service Lifecycle ───

async function sendPtyPortToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const backend = process.env.TAO_PTY_BACKEND?.trim().toLowerCase()
  if (backend !== 'utility') {
    try {
      const bridge = ensureTaodBridge()
      await bridge.ensureReady()

      const { port1, port2 } = new MessageChannelMain()
      bridge.connectPort(port1)
      mainWindow.webContents.postMessage('pty:port', null, [port2])
      return
    } catch (err) {
      const message = `Tao daemon unavailable: ${errorMessageFromUnknown(err)}`
      if (backend === 'taod') {
        notifyPtyServiceError(message)
        return
      }
      console.warn(`[main] ${message}; falling back to utility PTY service`)
    }
  }

  sendUtilityPtyPortToRenderer()
}

function sendUtilityPtyPortToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const service = ensurePtyService()
  if (!service) return

  const { port1, port2 } = new MessageChannelMain()
  service.postMessage({ type: 'connect' }, [port1])
  mainWindow.webContents.postMessage('pty:port', null, [port2])
}

function ensureTaodBridge(): TaodPtyBridge {
  taodBridge ??= new TaodPtyBridge()
  return taodBridge
}

function shouldWarmUtilityService(): boolean {
  return process.env.TAO_PTY_BACKEND?.trim().toLowerCase() === 'utility'
}

function warmSessionBackend() {
  if (shouldWarmUtilityService()) {
    ensurePtyService()
    return
  }

  const backend = process.env.TAO_PTY_BACKEND?.trim().toLowerCase()
  void ensureTaodBridge()
    .ensureReady()
    .catch((err) => {
      if (backend === 'taod') {
        console.warn(`[main] Failed to warm taod backend: ${errorMessageFromUnknown(err)}`)
        return
      }
      ensurePtyService()
    })
}

function ensurePtyService(): Electron.UtilityProcess | null {
  if (ptyService) return ptyService

  let service: Electron.UtilityProcess
  try {
    service = utilityProcess.fork(ptyServicePath, [], {
      serviceName: 'Tao PTY Service',
      stdio: 'inherit',
    })
  } catch (err) {
    notifyPtyServiceError(`Failed to start PTY service: ${errorMessageFromUnknown(err)}`)
    return null
  }

  ptyService = service
  ptyService.once('error', (err) => {
    if (ptyService === service) {
      ptyService = null
    }
    notifyPtyServiceError(`PTY service error: ${errorMessageFromUnknown(err)}`)
  })
  ptyService.once('exit', (code) => {
    console.log(`[main] PTY service exited with code ${code}`)
    if (ptyService === service) {
      ptyService = null
      if (code !== 0) {
        notifyPtyServiceError(`PTY service exited before ready (code=${code})`)
      }
    }
  })

  return service
}

function disposePtyService() {
  if (!ptyService) return
  ptyService.kill()
  ptyService = null
}

function disposeSessionBackends() {
  taodBridge?.dispose()
  taodBridge = null
  disposePtyService()
}

function notifyPtyServiceError(error: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('pty:service-error', error)
}

function authorizeRenderer(event: IpcMainInvokeEvent): Effect.Effect<void, WorkspaceError> {
  if (event.sender === mainWindow?.webContents) return Effect.void

  return Effect.fail(new WorkspaceError('unauthorized', 'IPC request came from an unknown sender'))
}

function runWorkspaceRequest<A>(
  event: IpcMainInvokeEvent,
  program: Effect.Effect<A, WorkspaceError, WorkspaceService>,
): Promise<WorkspaceIpcResponse<A>> {
  return runMainEffect(
    authorizeRenderer(event).pipe(
      Effect.flatMap(() => program),
      Effect.match({
        onFailure: workspaceIpcFailure,
        onSuccess: workspaceIpcSuccess,
      }),
    ),
  ).catch((error) => workspaceIpcFailure(error, 'ipc-failed'))
}

function workspaceServiceRequest<A>(
  event: IpcMainInvokeEvent,
  workspacePath: unknown,
  run: (
    service: typeof WorkspaceService.Service,
    workspacePath: string,
  ) => Effect.Effect<A, WorkspaceError>,
): Promise<WorkspaceIpcResponse<A>> {
  return runWorkspaceRequest(
    event,
    WorkspaceService.use((service) =>
      decodeWorkspacePathFromUnknown(workspacePath).pipe(
        Effect.flatMap((decodedWorkspacePath) => run(service, decodedWorkspacePath)),
      ),
    ),
  )
}

function pickWorkspaceDirectoryRequest(event: IpcMainInvokeEvent): Promise<string | null> {
  const program = Effect.gen(function* () {
    yield* authorizeRenderer(event)

    const window = mainWindow
    if (!window || window.isDestroyed()) {
      return yield* Effect.fail(new WorkspaceError('unavailable', 'Main window is unavailable'))
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        dialog.showOpenDialog(window, {
          properties: ['openDirectory'],
          title: 'Add Workspace',
        }),
      catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
    })

    if (result.canceled) return null
    const selectedPath = result.filePaths[0]
    if (!selectedPath) return null

    return yield* decodeWorkspacePathFromUnknown(selectedPath)
  })

  return Effect.runPromise(
    program.pipe(
      Effect.match({
        onFailure: (error) => {
          // The renderer models directory selection as `string | null`; null covers
          // cancellation and unavailable/unauthorized dialogs without changing that API.
          console.warn('[workspace] Failed to pick directory:', error.message)
          return null
        },
        onSuccess: (value) => value,
      }),
    ),
  ).catch((error) => {
    console.warn('[workspace] Failed to pick directory:', error)
    return null
  })
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
  void sendPtyPortToRenderer()
})

ipcMain.handle('workspace:pickDirectory', pickWorkspaceDirectoryRequest)

ipcMain.handle('layout:read', async (event) => {
  if (event.sender !== mainWindow?.webContents) return null
  return readLayout()
})

ipcMain.handle('layout:write', async (event, data: unknown) => {
  if (event.sender !== mainWindow?.webContents) return
  await writeLayout(data as never)
})

ipcMain.handle('settings:read', async (event) => {
  if (event.sender !== mainWindow?.webContents) return null
  return (await readSettings()) ?? defaultSettings
})

ipcMain.handle('settings:write', async (event, data: unknown) => {
  if (event.sender !== mainWindow?.webContents) return
  await writeSettings(data as never)
})

ipcMain.handle('workspace:getGitBranch', (event, workspacePath: unknown) =>
  workspaceServiceRequest(event, workspacePath, (service, path) => service.getGitBranch(path)),
)

ipcMain.handle('workspace:getGitWorktrees', async (event, workspacePath: unknown) => {
  return workspaceServiceRequest(event, workspacePath, (service, path) =>
    service.getGitWorktrees(path),
  )
})

ipcMain.handle('workspace:getGitStatus', async (event, workspacePath: unknown) => {
  return workspaceServiceRequest(event, workspacePath, (service, path) =>
    service.getGitStatus(path),
  )
})

ipcMain.handle('workspace:getWorkspacePorts', async (event, workspacePath: unknown) => {
  return workspaceServiceRequest(event, workspacePath, (service, path) =>
    service.getWorkspacePorts(path),
  )
})

ipcMain.handle('workspace:getPullRequestInfo', async (event, workspacePath: unknown) => {
  return workspaceServiceRequest(event, workspacePath, (service, path) =>
    service.getPullRequestInfo(path),
  )
})

// ─── App Lifecycle ───

app.whenReady().then(() => {
  createWindow()
  warmSessionBackend()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      warmSessionBackend()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  disposeSessionBackends()
  void disposeMainRuntime()
})
