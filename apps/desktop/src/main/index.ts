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
 *   - PTY isolated in taod with direct MessagePort IPC to the renderer bridge
 *   - Renderer process limit = 1 (single window app)
 *   - Disabled unused Chromium features (~15 services)
 *   - Canvas compositor layer promotion
 */

import { join } from 'node:path'
import { Effect, Schema } from 'effect'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  MessageChannelMain,
} from 'electron'
import { readLayout, writeLayout } from './layout-store'
import { disposeMainRuntime, runMainEffect } from './runtime'
import { defaultSettings, readSettings, writeSettings } from './settings-store'
import { TaodPtyBridge } from './taod-pty-bridge'
import { WorkspaceService } from './workspace-service'
import type { AppCommand, PaneFocusDirection } from '@tao/shared/app-command'
import {
  PaneLayoutDataSchema,
  SettingsDataSchema,
  type PaneLayoutData,
  type SettingsData,
} from '@tao/shared/session'
import {
  WorkspaceError,
  decodeWorkspacePathFromUnknown,
  errorMessageFromUnknown,
  workspaceIpcFailure,
  workspaceIpcSuccess,
  type WorkspaceIpcResponse,
} from '@tao/shared/workspace'

// ─── Phase 0: Chromium flags (MUST be set before app.ready) ───

// GPU: enable hardware rasterization for terminal renderer layers.
// Without this, Chromium may fall back to software rasterization
// which is slower for WebGL canvas composition and fallback rendering.
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers')

// Leave Chromium's software rasterizer fallback available so WebGL can recover
// on machines without a working hardware context.

// Keep the accelerated 2D canvas path available for xterm.js fallback rendering.
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
].join(',')

app.commandLine.appendSwitch('enable-features', enableFeatures)

function decodePaneLayoutData(data: unknown): PaneLayoutData {
  const decoded = Schema.decodeUnknownOption(PaneLayoutDataSchema)(data)
  if (decoded._tag === 'None') throw new Error('Invalid pane layout data')
  return decoded.value
}

function decodeSettingsData(data: unknown): SettingsData {
  const decoded = Schema.decodeUnknownOption(SettingsDataSchema)(data)
  if (decoded._tag === 'None') throw new Error('Invalid settings data')
  return decoded.value
}

// V8: cap old-space for predictable GC without forcing size-optimized codegen.
// Terminal workloads are steady-state; 256MB is plenty for one terminal window.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256')

// Limit to 1 renderer process. We only have one window.
// This avoids the overhead of a spare renderer process sitting idle.
app.commandLine.appendSwitch('renderer-process-limit', '1')

// ─── Application State ───

let mainWindow: BrowserWindow | null = null
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

      // xterm.js WebGL renderer needs Chromium's GPU path.
      offscreen: false,

      // Disable unnecessary renderer features
      webgl: true,
      plugins: false, // No Flash/PDF plugins
      experimentalFeatures: false,
      webSecurity: true,

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

    if (key === 'f' && !input.shift) {
      event.preventDefault()
      sendAppCommand({ type: 'search-terminal' })
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

// ─── Session Backend Lifecycle ───

async function sendPtyPortToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return

  try {
    const bridge = ensureTaodBridge()
    await bridge.ensureReady()

    const { port1, port2 } = new MessageChannelMain()
    bridge.connectPort(port1)
    mainWindow.webContents.postMessage('pty:port', null, [port2])
  } catch (err) {
    console.warn(`[main] Tao daemon unavailable: ${errorMessageFromUnknown(err)}`)
  }
}

function ensureTaodBridge(): TaodPtyBridge {
  taodBridge ??= new TaodPtyBridge()
  return taodBridge
}

function warmSessionBackend() {
  void ensureTaodBridge()
    .ensureReady()
    .catch((err) => {
      console.warn(`[main] Failed to warm taod backend: ${errorMessageFromUnknown(err)}`)
    })
}

function disposeSessionBackends() {
  taodBridge?.dispose()
  taodBridge = null
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
  event.sender.send('renderer:shown')
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
  await writeLayout(decodePaneLayoutData(data))
})

ipcMain.handle('settings:read', async (event) => {
  if (event.sender !== mainWindow?.webContents) return null
  return (await readSettings()) ?? defaultSettings
})

ipcMain.handle('settings:write', async (event, data: unknown) => {
  if (event.sender !== mainWindow?.webContents) return
  const settings = decodeSettingsData(data)
  await writeSettings(settings)
  await taodBridge?.syncPersistenceSettings(settings)
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
