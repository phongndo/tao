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

import { execFile } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Effect, Schema } from 'effect'
import {
  app,
  BrowserWindow,
  contentTracing,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  MessageChannelMain,
} from 'electron'
import { readLayout, writeLayout } from './layout-store'
import { disposeMainRuntime, runMainEffect } from './runtime'
import { defaultSettings, readSettings, writeSettings } from './settings-store'
import { TaodPtyBridge } from './taod-pty-bridge'
import { TaodClient } from './taod-client'
import { GitStateWatcher } from './git-state-watcher'
import type { AppCommand, PaneFocusDirection } from '@tao/shared/app-command'
import {
  PaneLayoutDataSchema,
  SettingsDataSchema,
  type PaneLayoutData,
  type SettingsData,
} from '@tao/shared/session'
import {
  TaodLifecycleRecoveryInputSchema,
  type TaodLifecycleRecoveryInput,
} from '@tao/shared/taod-protocol'
import {
  WorkspaceError,
  WorkspaceAddInputSchema,
  WorkspaceDiffPatchInputSchema,
  WorkspaceGitPathActionInputSchema,
  WorkspaceRefreshInputSchema,
  WorkspaceRemoveInputSchema,
  WorktreeCreateInputSchema,
  WorktreeRefreshInputSchema,
  WorktreeRemoveInputSchema,
  decodeWorkspacePathFromUnknown,
  errorMessageFromUnknown,
  workspaceIpcFailure,
  workspaceIpcSuccess,
  type WorkspaceErrorKind,
  type WorkspaceRecord,
  type WorkspaceIpcResponse,
  type WorkspaceWorktree,
} from '@tao/shared/workspace'

const execFileAsync = promisify(execFile)

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
let mainWindowLoadPromise: Promise<void> | null = null
let taodBridge: TaodPtyBridge | null = null
let taodClient: TaodClient | null = null
let gitStateWatcher: GitStateWatcher | null = null

// ─── Window Creation ───

function createWindow(): BrowserWindow {
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
      // Preload intentionally imports Electron's clipboard, shell, ipcRenderer,
      // and MessagePort APIs. Keep the exposed renderer API narrow while this is false.
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
      sendAppCommand({ type: 'toggle-right-sidebar' })
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
  mainWindowLoadPromise = process.env.ELECTRON_RENDERER_URL
    ? mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    : mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
    mainWindowLoadPromise = null
  })

  return mainWindow
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
  taodBridge ??= new TaodPtyBridge({ client: ensureTaodClient() })
  return taodBridge
}

function ensureTaodClient(): TaodClient {
  taodClient ??= new TaodClient({ detachDaemon: !isElectronSmoke() })
  return taodClient
}

function ensureGitStateWatcher(): GitStateWatcher {
  gitStateWatcher ??= new GitStateWatcher(ensureTaodClient, (workspace) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('workspace:changed', workspace)
  })
  return gitStateWatcher
}

async function disposeSessionBackends(): Promise<void> {
  gitStateWatcher?.dispose()
  gitStateWatcher = null
  taodBridge?.dispose()
  taodBridge = null
  const client = taodClient
  taodClient = null
  await client?.dispose()
}

function authorizeRenderer(event: IpcMainInvokeEvent): Effect.Effect<void, WorkspaceError> {
  if (event.sender === mainWindow?.webContents) return Effect.void

  return Effect.fail(new WorkspaceError('unauthorized', 'IPC request came from an unknown sender'))
}

function runWorkspaceRequest<A>(
  event: IpcMainInvokeEvent,
  program: Effect.Effect<A, WorkspaceError, never>,
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

async function runTaodWorkspaceRequest<A>(
  event: IpcMainInvokeEvent,
  run: (client: TaodClient) => Promise<A>,
): Promise<WorkspaceIpcResponse<A>> {
  if (event.sender !== mainWindow?.webContents) {
    return workspaceIpcFailure(
      new WorkspaceError('unauthorized', 'IPC request came from an unknown sender'),
    )
  }

  try {
    const client = ensureTaodClient()
    const value = await run(client)
    return workspaceIpcSuccess(value)
  } catch (error) {
    return workspaceIpcFailure(error, 'ipc-failed')
  }
}

function decodeWorkspaceIpcInput<S extends Schema.Decoder<unknown, any>>(
  schema: S,
  input: unknown,
  fallbackKind: WorkspaceErrorKind,
): S['Type'] {
  try {
    return Schema.decodeUnknownSync(schema as unknown as Schema.Decoder<unknown>)(
      input,
    ) as S['Type']
  } catch (error) {
    throw new WorkspaceError(fallbackKind, errorMessageFromUnknown(error))
  }
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

ipcMain.handle('workspace:list', async (event) => {
  const response = await runTaodWorkspaceRequest<readonly WorkspaceRecord[]>(event, (client) =>
    client.listWorkspaces(),
  )
  if (response.ok) ensureGitStateWatcher().syncWorkspaces(response.value)
  return response
})

ipcMain.handle('workspace:add', async (event, input: unknown) => {
  const response = await runTaodWorkspaceRequest<WorkspaceRecord>(event, (client) => {
    const data = decodeWorkspaceIpcInput(WorkspaceAddInputSchema, input, 'invalid-workspace')
    return client.addWorkspace(data)
  })
  if (response.ok) ensureGitStateWatcher().trackWorkspace(response.value)
  return response
})

ipcMain.handle('workspace:refresh', async (event, workspaceId: unknown) => {
  const response = await runTaodWorkspaceRequest<WorkspaceRecord>(event, (client) =>
    client.refreshWorkspace(
      decodeWorkspaceIpcInput(WorkspaceRefreshInputSchema, workspaceId, 'invalid-workspace'),
    ),
  )
  if (response.ok) ensureGitStateWatcher().trackWorkspace(response.value)
  return response
})

ipcMain.handle('workspace:remove', async (event, workspaceId: unknown) => {
  let id: string | undefined
  const response = await runTaodWorkspaceRequest<void>(event, (client) =>
    client.removeWorkspace(
      (id = decodeWorkspaceIpcInput(WorkspaceRemoveInputSchema, workspaceId, 'invalid-workspace')),
    ),
  )
  if (response.ok && id) ensureGitStateWatcher().untrackWorkspace(id)
  return response
})

ipcMain.handle('worktree:create', async (event, input: unknown) => {
  let workspaceId: string | undefined
  const response = await runTaodWorkspaceRequest<WorkspaceWorktree>(event, (client) => {
    const data = decodeWorkspaceIpcInput(WorktreeCreateInputSchema, input, 'invalid-worktree')
    workspaceId = data.workspaceId
    return client.createWorktree(data)
  })
  if (response.ok && workspaceId) ensureGitStateWatcher().refreshWorkspaceSoon(workspaceId)
  return response
})

ipcMain.handle('worktree:refresh', (event, worktreeId: unknown) =>
  runTaodWorkspaceRequest<WorkspaceWorktree>(event, (client) =>
    client.refreshWorktree(
      decodeWorkspaceIpcInput(WorktreeRefreshInputSchema, worktreeId, 'invalid-worktree'),
    ),
  ),
)

ipcMain.handle('worktree:remove', async (event, input: unknown) => {
  let workspaceId: string | undefined
  const response = await runTaodWorkspaceRequest<void>(event, async (client) => {
    const data = decodeWorkspaceIpcInput(WorktreeRemoveInputSchema, input, 'invalid-worktree')
    const worktreeId = data.worktreeId
    try {
      const worktree = await client.refreshWorktree(worktreeId)
      workspaceId = worktree.workspaceId
    } catch (error) {
      // The worktree may already be missing; removal below is still authoritative.
      console.warn(`[worktree:remove] Failed to refresh worktree ${worktreeId}:`, error)
    }
    return client.removeWorktree({
      worktreeId,
      force: data.force === true,
      deleteBranch: data.deleteBranch === true,
    })
  })
  if (response.ok && workspaceId) ensureGitStateWatcher().refreshWorkspaceSoon(workspaceId)
  return response
})

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

ipcMain.handle('taod:getDiagnostics', async (event) => {
  if (event.sender !== mainWindow?.webContents) return null
  return (await taodClient?.refreshLifecycleDiagnostics()) ?? null
})

ipcMain.handle('taod:getPtyBridgeDiagnostics', (event) => {
  if (event.sender !== mainWindow?.webContents) return null
  return taodBridge?.getDiagnostics() ?? null
})

ipcMain.handle('taod:recover', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) return null
  const action = Schema.decodeUnknownSync(
    TaodLifecycleRecoveryInputSchema as unknown as Schema.Decoder<unknown>,
  )(input) as TaodLifecycleRecoveryInput
  return await ensureTaodClient().applyLifecycleRecovery(action)
})

ipcMain.handle('workspace:getWatcherDiagnostics', (event) => {
  if (event.sender !== mainWindow?.webContents) return null
  return gitStateWatcher?.getDiagnostics() ?? null
})

ipcMain.handle('workspace:getGitBranch', async (event, workspacePath: unknown) =>
  runWorkspaceRequest(
    event,
    decodeWorkspacePathFromUnknown(workspacePath).pipe(
      Effect.flatMap((path) =>
        Effect.tryPromise({
          try: () => ensureTaodClient().getGitBranch(path),
          catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
        }),
      ),
    ),
  ),
)

ipcMain.handle('workspace:getGitBranches', async (event, workspacePath: unknown) =>
  runWorkspaceRequest(
    event,
    decodeWorkspacePathFromUnknown(workspacePath).pipe(
      Effect.flatMap((path) =>
        Effect.tryPromise({
          try: () => ensureTaodClient().listBranches(path),
          catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
        }),
      ),
    ),
  ),
)

ipcMain.handle('workspace:getGitWorktrees', async (event, workspacePath: unknown) => {
  return runWorkspaceRequest(
    event,
    decodeWorkspacePathFromUnknown(workspacePath).pipe(
      Effect.flatMap((path) =>
        Effect.tryPromise({
          try: () => ensureTaodClient().getGitWorktrees(path),
          catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
        }),
      ),
    ),
  )
})

ipcMain.handle('workspace:getGitStatus', async (event, workspacePath: unknown) => {
  return runWorkspaceRequest(
    event,
    decodeWorkspacePathFromUnknown(workspacePath).pipe(
      Effect.flatMap((path) =>
        Effect.tryPromise({
          try: () => ensureTaodClient().getGitStatus(path),
          catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
        }),
      ),
    ),
  )
})

ipcMain.handle('workspace:getWorkspaceFileTree', async (event, workspacePath: unknown) => {
  return runWorkspaceRequest(
    event,
    decodeWorkspacePathFromUnknown(workspacePath).pipe(
      Effect.flatMap((path) =>
        Effect.tryPromise({
          try: () => ensureTaodClient().getWorkspaceFileTree(path),
          catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
        }),
      ),
    ),
  )
})

ipcMain.handle('workspace:getWorkspaceDiffPatch', async (event, workspacePath: unknown) => {
  return runWorkspaceRequest(
    event,
    Effect.try({
      try: () =>
        Schema.decodeUnknownSync(WorkspaceDiffPatchInputSchema)(
          typeof workspacePath === 'string' ? { workspacePath } : workspacePath,
        ),
      catch: (error) => new WorkspaceError('invalid-path', errorMessageFromUnknown(error)),
    }).pipe(
      Effect.flatMap((input) =>
        decodeWorkspacePathFromUnknown(input.workspacePath).pipe(
          Effect.flatMap((path) =>
            Effect.tryPromise({
              try: () =>
                ensureTaodClient().getWorkspaceDiffPatch({
                  rootPath: path,
                  scope: input.scope ?? 'all',
                  compareBranch: input.compareBranch,
                }),
              catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
            }),
          ),
        ),
      ),
    ),
  )
})

function workspaceGitPathActionRequest(
  event: IpcMainInvokeEvent,
  inputValue: unknown,
  action: (
    client: TaodClient,
    input: { readonly rootPath: string; readonly path: string | readonly string[] },
  ) => Promise<void>,
) {
  return runWorkspaceRequest(
    event,
    Effect.try({
      try: () => Schema.decodeUnknownSync(WorkspaceGitPathActionInputSchema)(inputValue),
      catch: (error) => new WorkspaceError('invalid-path', errorMessageFromUnknown(error)),
    }).pipe(
      Effect.flatMap((input) =>
        decodeWorkspacePathFromUnknown(input.workspacePath).pipe(
          Effect.flatMap((workspacePath) =>
            Effect.tryPromise({
              try: () => action(ensureTaodClient(), { rootPath: workspacePath, path: input.path }),
              catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
            }),
          ),
        ),
      ),
    ),
  )
}

ipcMain.handle('workspace:stagePath', async (event, input: unknown) =>
  workspaceGitPathActionRequest(event, input, (client, request) => client.stagePath(request)),
)

ipcMain.handle('workspace:unstagePath', async (event, input: unknown) =>
  workspaceGitPathActionRequest(event, input, (client, request) => client.unstagePath(request)),
)

ipcMain.handle('workspace:revertPath', async (event, input: unknown) =>
  workspaceGitPathActionRequest(event, input, (client, request) => client.revertPath(request)),
)

ipcMain.handle('workspace:getWorkspacePorts', async (event, workspacePath: unknown) => {
  return runWorkspaceRequest(
    event,
    decodeWorkspacePathFromUnknown(workspacePath).pipe(
      Effect.flatMap((path) =>
        Effect.tryPromise({
          try: () => ensureTaodClient().getWorkspacePorts(path),
          catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
        }),
      ),
    ),
  )
})

ipcMain.handle('workspace:getPullRequestInfo', async (event, workspacePath: unknown) => {
  return runWorkspaceRequest(
    event,
    decodeWorkspacePathFromUnknown(workspacePath).pipe(
      Effect.flatMap((path) =>
        Effect.tryPromise({
          try: () => ensureTaodClient().getPullRequestInfo(path),
          catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
        }),
      ),
    ),
  )
})

// ─── App Lifecycle ───

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const ELECTRON_SMOKE_TIMEOUT_MS = positiveIntEnv('TAO_ELECTRON_SMOKE_TIMEOUT_MS', 15_000)
const ELECTRON_SMOKE_OUTPUT_BYTES = positiveIntEnv('TAO_ELECTRON_SMOKE_OUTPUT_BYTES', 16 * 1024)
const ELECTRON_SMOKE_OUTPUT_TIMEOUT_MS = positiveIntEnv(
  'TAO_ELECTRON_SMOKE_OUTPUT_TIMEOUT_MS',
  10_000,
)
const ELECTRON_SMOKE_OUTPUT_START_DELAY_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_OUTPUT_START_DELAY_MS',
  0,
)
const ELECTRON_SMOKE_MIN_THROUGHPUT_BYTES_PER_SEC = positiveIntEnv(
  'TAO_ELECTRON_SMOKE_MIN_THROUGHPUT_BYTES_PER_SEC',
  4 * 1024,
)
const ELECTRON_SMOKE_MAX_PENDING_OUTPUT_BYTES = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_PENDING_OUTPUT_BYTES',
  1024 * 1024,
)
const ELECTRON_SMOKE_MAX_TAOD_RSS_GROWTH_KB = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_TAOD_RSS_GROWTH_KB',
  0,
)
const ELECTRON_SMOKE_MAX_TAOD_RSS_KB = nonNegativeIntEnv('TAO_ELECTRON_SMOKE_MAX_TAOD_RSS_KB', 0)
const ELECTRON_SMOKE_MAX_RENDERER_LOAD_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_RENDERER_LOAD_MS',
  0,
)
const ELECTRON_SMOKE_MAX_FIRST_OUTPUT_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_FIRST_OUTPUT_MS',
  0,
)
const ELECTRON_SMOKE_MAX_TOTAL_MS = nonNegativeIntEnv('TAO_ELECTRON_SMOKE_MAX_TOTAL_MS', 0)
const ELECTRON_SMOKE_MAX_INPUT_ECHO_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_INPUT_ECHO_MS',
  0,
)
const ELECTRON_SMOKE_RELOAD = process.env.TAO_ELECTRON_SMOKE_RELOAD === '1'
const ELECTRON_SMOKE_RELOAD_SESSION_COUNT = positiveIntEnv('TAO_ELECTRON_SMOKE_RELOAD_SESSIONS', 1)
const ELECTRON_SMOKE_RELOAD_CYCLES = positiveIntEnv('TAO_ELECTRON_SMOKE_RELOAD_CYCLES', 1)
const ELECTRON_SMOKE_RELOAD_DURATION_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_RELOAD_DURATION_MS',
  0,
)
const ELECTRON_SMOKE_RELOAD_INTERVAL_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_RELOAD_INTERVAL_MS',
  0,
)
const ELECTRON_SMOKE_PROGRESS_INTERVAL_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_PROGRESS_INTERVAL_MS',
  ELECTRON_SMOKE_RELOAD_DURATION_MS > 0 ? 60_000 : 0,
)
const ELECTRON_SMOKE_MAX_RELOAD_MS = nonNegativeIntEnv('TAO_ELECTRON_SMOKE_MAX_RELOAD_MS', 0)
const ELECTRON_SMOKE_MAX_RELOAD_ATTACH_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_RELOAD_ATTACH_MS',
  0,
)
const ELECTRON_SMOKE_MAX_RELOAD_ECHO_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_RELOAD_ECHO_MS',
  0,
)
const ELECTRON_SMOKE_MAX_MAIN_RSS_GROWTH_KB = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_MAIN_RSS_GROWTH_KB',
  0,
)
const ELECTRON_SMOKE_MAX_RENDERER_RSS_GROWTH_KB = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_RENDERER_RSS_GROWTH_KB',
  0,
)
const ELECTRON_SMOKE_MAX_MAIN_RSS_KB = nonNegativeIntEnv('TAO_ELECTRON_SMOKE_MAX_MAIN_RSS_KB', 0)
const ELECTRON_SMOKE_MAX_RENDERER_RSS_KB = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_MAX_RENDERER_RSS_KB',
  0,
)
const ELECTRON_SMOKE_TRACE = process.env.TAO_ELECTRON_SMOKE_TRACE === '1'
const ELECTRON_SMOKE_TRACE_PATH =
  process.env.TAO_ELECTRON_SMOKE_TRACE_PATH ||
  join(process.cwd(), 'out/bench/electron-smoke-trace.json')
const ELECTRON_SMOKE_TRACE_MEMORY = process.env.TAO_ELECTRON_SMOKE_TRACE_MEMORY === '1'
const ELECTRON_SMOKE_TRACE_BUFFER_KB = positiveIntEnv(
  'TAO_ELECTRON_SMOKE_TRACE_BUFFER_KB',
  128 * 1024,
)
const ELECTRON_SMOKE_TRACE_CATEGORIES = (
  process.env.TAO_ELECTRON_SMOKE_TRACE_CATEGORIES ||
  [
    'electron',
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'blink.user_timing',
    'v8',
    'gpu',
    'cc',
    'renderer.scheduler',
    ...(ELECTRON_SMOKE_TRACE_MEMORY ? ['disabled-by-default-memory-infra'] : []),
  ].join(',')
)
  .split(',')
  .map((category) => category.trim())
  .filter(Boolean)

function isElectronSmoke(): boolean {
  return process.env.TAO_ELECTRON_SMOKE === '1'
}

type ElectronSmokeTraceResult = {
  path: string
  sizeBytes: number | null
  categories: readonly string[]
  memory: boolean
}

async function startElectronSmokeTrace(): Promise<boolean> {
  if (!ELECTRON_SMOKE_TRACE) return false

  mkdirSync(dirname(resolve(ELECTRON_SMOKE_TRACE_PATH)), { recursive: true })
  if (ELECTRON_SMOKE_TRACE_MEMORY) {
    await contentTracing.enableHeapProfiling()
  }
  await contentTracing.startRecording({
    enable_argument_filter: true,
    included_categories: ELECTRON_SMOKE_TRACE_CATEGORIES,
    recording_mode: 'record-continuously',
    trace_buffer_size_in_kb: ELECTRON_SMOKE_TRACE_BUFFER_KB,
  })
  return true
}

async function stopElectronSmokeTrace(started: boolean): Promise<ElectronSmokeTraceResult | null> {
  if (!started) return null

  const path = await contentTracing.stopRecording(ELECTRON_SMOKE_TRACE_PATH)
  let sizeBytes: number | null = null
  try {
    sizeBytes = statSync(path).size
  } catch {
    sizeBytes = null
  }
  const result = {
    path,
    sizeBytes,
    categories: ELECTRON_SMOKE_TRACE_CATEGORIES,
    memory: ELECTRON_SMOKE_TRACE_MEMORY,
  }
  console.log('[electron-smoke] trace', JSON.stringify(result))
  return result
}

function electronSmokeScript(input: { cwd: string; token: string; keepSession: boolean }): string {
  const outputChunk = '0123456789abcdef'.repeat(4)
  const outputIterations = Math.ceil(ELECTRON_SMOKE_OUTPUT_BYTES / outputChunk.length)
  const pythonScript = `
import os, select, sys, threading, time, tty
out = sys.stdout.fileno()
inp = sys.stdin.fileno()
try:
    tty.setraw(inp)
except Exception:
    pass
time.sleep(${(ELECTRON_SMOKE_OUTPUT_START_DELAY_MS / 1000).toFixed(3)})
os.write(out, ${JSON.stringify(input.token)}.encode())
chunk = ${JSON.stringify(outputChunk)}.encode()
def flood():
    for _ in range(${outputIterations}):
        os.write(out, chunk)
    time.sleep(2)
threading.Thread(target=flood, daemon=True).start()
buffer = b""
deadline = time.time() + 10
while time.time() < deadline:
    readable, _, _ = select.select([inp], [], [], 0.05)
    if inp not in readable:
        continue
    data = os.read(inp, 4096)
    if not data:
        break
    buffer += data
    while b"\\n" in buffer:
        line, buffer = buffer.split(b"\\n", 1)
        os.write(out, b"\\nECHO:" + line + b"\\n")
`
  const smokeArgv = ['/usr/bin/env', 'python3', '-u', '-c', pythonScript]
  return `
    (async () => {
      const scriptStartedAt = performance.now()
      const api = window.electronAPI
      if (!api) throw new Error('window.electronAPI is unavailable')
      await api.signalReady()
      const rendererReadyMs = performance.now() - scriptStartedAt
      const created = await api.createSession({
        terminalId: 'electron-smoke-terminal',
        workspaceId: 'electron-smoke-workspace',
        cols: 80,
        rows: 24,
        cwd: ${JSON.stringify(input.cwd)},
        argv: ${JSON.stringify(smokeArgv)},
      })
      const createSessionMs = performance.now() - scriptStartedAt
      const sessionId = created.sessionId
      try {
        const startedAt = performance.now()
        let firstOutputMs = null
        let inputEchoMs = null
        await new Promise((resolve, reject) => {
          let outputTail = ''
          let receivedBytes = 0
          let sawToken = false
          let inputSent = false
          let inputSentAt = 0
          const inputEchoToken = 'input-' + Math.random().toString(36).slice(2)
          const inputEchoNeedle = 'ECHO:' + inputEchoToken
          const inputProbeEnabled = ${ELECTRON_SMOKE_MAX_INPUT_ECHO_MS} > 0
          const encoder = new TextEncoder()
          let settled = false
          let offData = () => {}
          let offError = () => {}
          let offExit = () => {}
          const cleanup = () => {
            clearTimeout(timeout)
            offData()
            offError()
            offExit()
          }
          const settle = (fn, value) => {
            if (settled) return
            settled = true
            cleanup()
            fn(value)
          }
          const timeout = setTimeout(
            () => settle(reject, new Error('Timed out waiting for smoke terminal throughput output')),
            ${ELECTRON_SMOKE_OUTPUT_TIMEOUT_MS},
          )
          offError = api.onPtyError(sessionId, (error) => {
            settle(reject, new Error(String(error)))
          })
          offExit = api.onPtyExit(sessionId, (info) => {
            if (!sawToken || receivedBytes < ${ELECTRON_SMOKE_OUTPUT_BYTES}) {
              settle(reject, new Error('Smoke session exited before expected output: ' + JSON.stringify(info)))
            }
          })
          offData = api.onPtyData(sessionId, (data) => {
            if (firstOutputMs === null) firstOutputMs = performance.now() - scriptStartedAt
            outputTail = (outputTail + data).slice(-4096)
            receivedBytes += data.length
            if (outputTail.includes(${JSON.stringify(input.token)})) sawToken = true
            if (inputProbeEnabled && sawToken && !inputSent) {
              inputSent = true
              inputSentAt = performance.now()
              api.writeSessionInput(sessionId, encoder.encode(inputEchoToken + '\\n'))
            }
            if (inputProbeEnabled && inputSent && inputEchoMs === null && outputTail.includes(inputEchoNeedle)) {
              inputEchoMs = performance.now() - inputSentAt
            }
            if (
              sawToken &&
              receivedBytes >= ${ELECTRON_SMOKE_OUTPUT_BYTES} &&
              (!inputProbeEnabled || inputEchoMs !== null)
            ) {
              settle(resolve)
            }
          })
        })
        if (firstOutputMs === null) {
          throw new Error('Smoke did not record first terminal output timing')
        }
        const durationMs = performance.now() - startedAt
        const throughputBytesPerSec = ${ELECTRON_SMOKE_OUTPUT_BYTES} / (durationMs / 1000)
        if (
          ${ELECTRON_SMOKE_MAX_INPUT_ECHO_MS} > 0 &&
          (inputEchoMs === null || inputEchoMs > ${ELECTRON_SMOKE_MAX_INPUT_ECHO_MS})
        ) {
          throw new Error(
            'Smoke input echo above budget: ' +
              (inputEchoMs === null ? 'missing' : Math.round(inputEchoMs) + ' ms'),
          )
        }
        if (
          ${ELECTRON_SMOKE_MAX_FIRST_OUTPUT_MS} > 0 &&
          firstOutputMs > ${ELECTRON_SMOKE_MAX_FIRST_OUTPUT_MS}
        ) {
          throw new Error(
            'Smoke first terminal output above budget: ' +
              Math.round(firstOutputMs) +
              ' ms',
          )
        }
        if (throughputBytesPerSec < ${ELECTRON_SMOKE_MIN_THROUGHPUT_BYTES_PER_SEC}) {
          throw new Error(
            'Smoke terminal throughput below budget: ' +
              Math.round(throughputBytesPerSec) +
              ' B/s',
          )
        }
        const diagnostics = api.getTerminalPreloadDiagnostics()
        if (diagnostics.pendingClientMessages !== 0) {
          throw new Error('Smoke left pending preload client messages: ' + diagnostics.pendingClientMessages)
        }
        if (
          diagnostics.pendingDataDroppedCharsTotal !== 0 ||
          diagnostics.pendingDataTruncatedCharsTotal !== 0 ||
          diagnostics.pendingOutputDroppedCharsTotal !== 0 ||
          diagnostics.pendingOutputTruncatedCharsTotal !== 0
        ) {
          throw new Error('Smoke lost preload terminal output before subscription: ' + JSON.stringify(diagnostics))
        }
        const taodDiagnostics = await api.getTaodDiagnostics()
        if (!taodDiagnostics || !taodDiagnostics.state.endsWith('-live')) {
          throw new Error('Smoke taod diagnostics were not live: ' + JSON.stringify(taodDiagnostics))
        }
        if (
          typeof taodDiagnostics.daemonOwnership !== 'string' ||
          typeof taodDiagnostics.recoveryAction !== 'string'
        ) {
          throw new Error('Smoke taod diagnostics did not include recovery policy: ' + JSON.stringify(taodDiagnostics))
        }
        if (taodDiagnostics.controlRequestCount === 0 || !taodDiagnostics.lastControlRequest) {
          throw new Error('Smoke taod diagnostics did not record control requests')
        }
        if (
          !taodDiagnostics.timing ||
          typeof taodDiagnostics.timing.lastPingDurationMs !== 'number' ||
          typeof taodDiagnostics.timing.lastTransitionAt !== 'number'
        ) {
          throw new Error('Smoke taod diagnostics did not include lifecycle timing')
        }
        if (!taodDiagnostics.streamDiagnostics) {
          throw new Error('Smoke taod diagnostics did not include stream diagnostics')
        }
        if (
          !taodDiagnostics.daemonControlDiagnostics ||
          taodDiagnostics.daemonControlDiagnostics.requestCount === 0 ||
          !taodDiagnostics.daemonControlDiagnostics.lastRequestType ||
          !taodDiagnostics.daemonControlDiagnostics.lastTraceId
        ) {
          throw new Error(
            'Smoke taod diagnostics did not include daemon control trace diagnostics: ' +
              JSON.stringify(taodDiagnostics.daemonControlDiagnostics),
          )
        }
        if (
          ${ELECTRON_SMOKE_MAX_INPUT_ECHO_MS} > 0 &&
          taodDiagnostics.streamDiagnostics.inputBytesTotal === 0
        ) {
          throw new Error('Smoke taod stream diagnostics did not record terminal input bytes')
        }
        if (taodDiagnostics.streamDiagnostics.outputBytesTotal < ${ELECTRON_SMOKE_OUTPUT_BYTES}) {
          throw new Error(
            'Smoke taod stream diagnostics did not record terminal output bytes: ' +
              JSON.stringify(taodDiagnostics.streamDiagnostics),
          )
        }
        if (taodDiagnostics.streamDiagnostics.pendingOutputBytes > ${ELECTRON_SMOKE_MAX_PENDING_OUTPUT_BYTES}) {
          throw new Error(
            'Smoke taod pending output bytes above budget: ' +
              JSON.stringify(taodDiagnostics.streamDiagnostics),
          )
        }
        const bridgeDiagnostics = await api.getTaodPtyBridgeDiagnostics()
        if (!bridgeDiagnostics || !bridgeDiagnostics.portConnected) {
          throw new Error('Smoke taod bridge diagnostics were not connected: ' + JSON.stringify(bridgeDiagnostics))
        }
        if (
          bridgeDiagnostics.postFailuresTotal !== 0 ||
          bridgeDiagnostics.messagesDroppedNoPortTotal !== 0
        ) {
          throw new Error('Smoke taod bridge lost MessagePort posts: ' + JSON.stringify(bridgeDiagnostics))
        }
        if (
          bridgeDiagnostics.dataMessagesPostedTotal === 0 ||
          bridgeDiagnostics.dataCharsPostedTotal < ${ELECTRON_SMOKE_OUTPUT_BYTES}
        ) {
          throw new Error('Smoke taod bridge diagnostics did not record terminal output posts: ' + JSON.stringify(bridgeDiagnostics))
        }
        const rendererTraceEntries =
          typeof window.__TAO_RENDERER_TRACE__?.entries === 'function'
            ? window.__TAO_RENDERER_TRACE__.entries()
            : []
        const rendererTraceNames = new Set(rendererTraceEntries.map((entry) => entry.name))
        for (const requiredTraceName of [
          'tao:ui:app-mounted',
          'tao:ui:layout-loaded',
        ]) {
          if (!rendererTraceNames.has(requiredTraceName)) {
            throw new Error(
              'Smoke renderer trace missing ' +
                requiredTraceName +
                ': ' +
                JSON.stringify(rendererTraceEntries.slice(-24)),
            )
          }
        }
        return {
          sessionId,
          durationMs,
          rendererReadyMs,
          createSessionMs,
          firstOutputMs,
          inputEchoMs,
          throughputBytesPerSec,
          receivedBytes: ${ELECTRON_SMOKE_OUTPUT_BYTES},
          diagnostics,
          taodDiagnostics,
          bridgeDiagnostics,
          rendererTraceEntries,
        }
      } finally {
        if (!${input.keepSession ? 'true' : 'false'}) {
          await api.killSession(sessionId)
        }
      }
    })()
  `
}

function electronSmokeReloadAttachScript(input: { sessionId: string }): string {
  return `
    (async () => {
      const scriptStartedAt = performance.now()
      const api = window.electronAPI
      if (!api) throw new Error('window.electronAPI is unavailable after reload')
      await api.signalReady()
      const attachStartedAt = performance.now()
      const attached = await api.attachSession({
        sessionId: ${JSON.stringify(input.sessionId)},
        terminalId: 'electron-smoke-terminal-reload',
        workspaceId: 'electron-smoke-workspace',
        cols: 80,
        rows: 24,
      })
      const attachMs = performance.now() - attachStartedAt
      const encoder = new TextEncoder()
      const inputEchoToken = 'reload-' + Math.random().toString(36).slice(2)
      const inputEchoNeedle = 'ECHO:' + inputEchoToken
      let inputEchoMs = null
      let outputTail = ''
      let offData = () => {}
      let offError = () => {}
      let offExit = () => {}
      try {
        await new Promise((resolve, reject) => {
          let settled = false
          const cleanup = () => {
            clearTimeout(timeout)
            offData()
            offError()
            offExit()
          }
          const settle = (fn, value) => {
            if (settled) return
            settled = true
            cleanup()
            fn(value)
          }
          const timeout = setTimeout(
            () => settle(reject, new Error('Timed out waiting for reload attach echo')),
            ${ELECTRON_SMOKE_OUTPUT_TIMEOUT_MS},
          )
          const inputSentAt = performance.now()
          offError = api.onPtyError(${JSON.stringify(input.sessionId)}, (error) => {
            settle(reject, new Error(String(error)))
          })
          offExit = api.onPtyExit(${JSON.stringify(input.sessionId)}, (info) => {
            settle(reject, new Error('Smoke reload session exited before echo: ' + JSON.stringify(info)))
          })
          offData = api.onPtyData(${JSON.stringify(input.sessionId)}, (data) => {
            outputTail = (outputTail + data).slice(-4096)
            if (outputTail.includes(inputEchoNeedle)) {
              inputEchoMs = performance.now() - inputSentAt
              settle(resolve)
            }
          })
          api.writeSessionInput(${JSON.stringify(input.sessionId)}, encoder.encode(inputEchoToken + '\\n'))
        })
        if (
          ${ELECTRON_SMOKE_MAX_RELOAD_ATTACH_MS} > 0 &&
          attachMs > ${ELECTRON_SMOKE_MAX_RELOAD_ATTACH_MS}
        ) {
          throw new Error(
            'Smoke reload attach above budget: ' +
              Math.round(attachMs) +
              ' ms',
          )
        }
        if (
          ${ELECTRON_SMOKE_MAX_RELOAD_ECHO_MS} > 0 &&
          (inputEchoMs === null || inputEchoMs > ${ELECTRON_SMOKE_MAX_RELOAD_ECHO_MS})
        ) {
          throw new Error(
            'Smoke reload input echo above budget: ' +
              (inputEchoMs === null ? 'missing' : Math.round(inputEchoMs) + ' ms'),
          )
        }
        const diagnostics = api.getTerminalPreloadDiagnostics()
        if (diagnostics.pendingClientMessages !== 0) {
          throw new Error('Smoke reload left pending preload client messages: ' + diagnostics.pendingClientMessages)
        }
        if (
          diagnostics.pendingDataDroppedCharsTotal !== 0 ||
          diagnostics.pendingDataTruncatedCharsTotal !== 0 ||
          diagnostics.pendingOutputDroppedCharsTotal !== 0 ||
          diagnostics.pendingOutputTruncatedCharsTotal !== 0
        ) {
          throw new Error('Smoke reload lost preload terminal output before subscription: ' + JSON.stringify(diagnostics))
        }
        const taodDiagnostics = await api.getTaodDiagnostics()
        if (!taodDiagnostics || !taodDiagnostics.state.endsWith('-live')) {
          throw new Error('Smoke reload taod diagnostics were not live: ' + JSON.stringify(taodDiagnostics))
        }
        if (
          typeof taodDiagnostics.daemonOwnership !== 'string' ||
          typeof taodDiagnostics.recoveryAction !== 'string'
        ) {
          throw new Error('Smoke reload taod diagnostics did not include recovery policy: ' + JSON.stringify(taodDiagnostics))
        }
        if (
          !taodDiagnostics.timing ||
          typeof taodDiagnostics.timing.lastPingDurationMs !== 'number' ||
          typeof taodDiagnostics.timing.lastTransitionAt !== 'number'
        ) {
          throw new Error('Smoke reload taod diagnostics did not include lifecycle timing')
        }
        const bridgeDiagnostics = await api.getTaodPtyBridgeDiagnostics()
        if (!bridgeDiagnostics || !bridgeDiagnostics.portConnected) {
          throw new Error('Smoke reload taod bridge diagnostics were not connected: ' + JSON.stringify(bridgeDiagnostics))
        }
        if (
          bridgeDiagnostics.postFailuresTotal !== 0 ||
          bridgeDiagnostics.messagesDroppedNoPortTotal !== 0 ||
          bridgeDiagnostics.dataMessagesPostedTotal === 0
        ) {
          throw new Error('Smoke reload taod bridge diagnostics were unhealthy: ' + JSON.stringify(bridgeDiagnostics))
        }
        return {
          sessionId: ${JSON.stringify(input.sessionId)},
          rendererReadyMs: performance.now() - scriptStartedAt,
          attachMs,
          inputEchoMs,
          attached,
          diagnostics,
          taodDiagnostics,
          bridgeDiagnostics,
        }
      } finally {
        await api.killSession(${JSON.stringify(input.sessionId)})
      }
    })()
  `
}

function electronSmokeWorkspaceSetupScript(input: {
  cwd: string
  workspaceId: string
  name: string
}): string {
  return `
    (async () => {
      const api = window.electronAPI
      if (!api) throw new Error('window.electronAPI is unavailable for workspace setup')
      await api.signalReady()
      const addStartedAt = performance.now()
      const added = await api.addWorkspace({
        rootPath: ${JSON.stringify(input.cwd)},
        workspaceId: ${JSON.stringify(input.workspaceId)},
        name: ${JSON.stringify(input.name)},
      })
      const addMs = performance.now() - addStartedAt
      if (!added.ok) {
        throw new Error('Smoke workspace add failed: ' + JSON.stringify(added.error))
      }
      const listed = await api.listWorkspaces()
      if (!listed.ok) {
        throw new Error('Smoke workspace list failed before reload: ' + JSON.stringify(listed.error))
      }
      const found = listed.value.find((workspace) => workspace.id === added.value.id)
      if (!found) {
        throw new Error('Smoke workspace missing before reload: ' + added.value.id)
      }
      const watcherDiagnostics = await api.getWorkspaceWatcherDiagnostics()
      const watcherEntry = watcherDiagnostics?.entries.find((entry) => entry.workspaceId === added.value.id)
      if (!watcherDiagnostics || !watcherEntry || watcherEntry.watcherCount < 1) {
        throw new Error('Smoke workspace watcher diagnostics missing tracked workspace: ' + JSON.stringify(watcherDiagnostics))
      }
      return {
        workspaceId: added.value.id,
        addMs,
        listedCount: listed.value.length,
        watcherDiagnostics: {
          trackedWorkspaces: watcherDiagnostics.trackedWorkspaces,
          totalWatchers: watcherDiagnostics.totalWatchers,
          watcherCount: watcherEntry.watcherCount,
          watcherInstallCount: watcherEntry.watcherInstallCount,
        },
        rootPath: found.rootPath,
        name: found.name,
      }
    })()
  `
}

function electronSmokeWorkspaceReloadScript(input: { workspaceId: string }): string {
  return `
    (async () => {
      const api = window.electronAPI
      if (!api) throw new Error('window.electronAPI is unavailable for workspace reload check')
      await api.signalReady()
      const listStartedAt = performance.now()
      const listed = await api.listWorkspaces()
      const listMs = performance.now() - listStartedAt
      if (!listed.ok) {
        throw new Error('Smoke workspace list failed after reload: ' + JSON.stringify(listed.error))
      }
      const found = listed.value.find((workspace) => workspace.id === ${JSON.stringify(input.workspaceId)})
      if (!found) {
        throw new Error('Smoke workspace missing after reload: ' + ${JSON.stringify(input.workspaceId)})
      }

      const refreshStartedAt = performance.now()
      const refreshed = await api.refreshWorkspace(${JSON.stringify(input.workspaceId)})
      const refreshMs = performance.now() - refreshStartedAt
      if (!refreshed.ok) {
        throw new Error('Smoke workspace refresh failed after reload: ' + JSON.stringify(refreshed.error))
      }

      const removeStartedAt = performance.now()
      const removed = await api.removeWorkspace(${JSON.stringify(input.workspaceId)})
      const removeMs = performance.now() - removeStartedAt
      if (!removed.ok) {
        throw new Error('Smoke workspace remove failed after reload: ' + JSON.stringify(removed.error))
      }
      const afterRemove = await api.listWorkspaces()
      if (afterRemove.ok && afterRemove.value.some((workspace) => workspace.id === ${JSON.stringify(input.workspaceId)})) {
        throw new Error('Smoke workspace still listed after cleanup: ' + ${JSON.stringify(input.workspaceId)})
      }
      const watcherDiagnostics = await api.getWorkspaceWatcherDiagnostics()
      if (watcherDiagnostics?.entries.some((entry) => entry.workspaceId === ${JSON.stringify(input.workspaceId)})) {
        throw new Error('Smoke workspace watcher still tracked after cleanup: ' + JSON.stringify(watcherDiagnostics))
      }

      return {
        workspaceId: ${JSON.stringify(input.workspaceId)},
        listMs,
        refreshMs,
        removeMs,
        listedCount: listed.value.length,
        watcherDiagnostics: watcherDiagnostics
          ? {
              trackedWorkspaces: watcherDiagnostics.trackedWorkspaces,
              totalWatchers: watcherDiagnostics.totalWatchers,
            }
          : null,
        rootPath: found.rootPath,
        name: found.name,
      }
    })()
  `
}

function electronSmokeUiStateSetupScript(input: { workspaceId: string; cwd: string }): string {
  const layout = {
    version: 1,
    workspaces: [
      {
        id: input.workspaceId,
        name: 'Electron Smoke Workspace',
        projectPath: input.cwd,
        order: 0,
        lastActiveTabId: 'electron-smoke-tab',
      },
    ],
    activeWorkspaceId: input.workspaceId,
    lastActiveLocalTabId: null,
    tabs: [
      {
        id: 'electron-smoke-tab',
        workspaceId: input.workspaceId,
        name: 'Smoke Tab',
        layout: {
          direction: 'row',
          first: 'electron-smoke-pane-a',
          second: 'electron-smoke-pane-b',
          splitPercentage: 62,
        },
        lastActivePaneId: 'electron-smoke-pane-b',
        order: 0,
      },
    ],
    panes: [
      {
        id: 'electron-smoke-pane-a',
        terminalId: 'electron-smoke-terminal-a',
        tabId: 'electron-smoke-tab',
        type: 'terminal',
        name: 'Smoke A',
        cwd: input.cwd,
        status: 'idle',
      },
      {
        id: 'electron-smoke-pane-b',
        terminalId: 'electron-smoke-terminal-b',
        tabId: 'electron-smoke-tab',
        type: 'changes',
        name: 'Smoke Changes',
        cwd: input.cwd,
        status: 'review',
      },
    ],
    activeTabId: 'electron-smoke-tab',
    activePaneId: 'electron-smoke-pane-b',
    sidebarExpanded: false,
    sidebarWidth: 288,
    rightSidebarExpanded: true,
    rightSidebarWidth: 360,
  }
  const settings = {
    version: 1,
    persistence: {
      enabled: true,
      retainDays: 7,
      maxSessionBytes: 1024 * 1024,
      persistInput: true,
    },
  }

  return `
    (async () => {
      const api = window.electronAPI
      if (!api) throw new Error('window.electronAPI is unavailable for UI-state setup')
      await api.signalReady()
      const layout = ${JSON.stringify(layout)}
      const settings = ${JSON.stringify(settings)}
      await api.writeLayout(layout)
      await api.writeSettings(settings)
      const readLayout = await api.readLayout()
      const readSettings = await api.readSettings()
      const stable = (value) => {
        if (Array.isArray(value)) return value.map(stable)
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]))
        }
        return value
      }
      const stableJson = (value) => JSON.stringify(stable(value))
      if (stableJson(readLayout) !== stableJson(layout)) {
        throw new Error('Smoke UI layout did not round-trip before reload: ' + JSON.stringify(readLayout))
      }
      if (stableJson(readSettings) !== stableJson(settings)) {
        throw new Error('Smoke settings did not round-trip before reload: ' + JSON.stringify(readSettings))
      }
      return {
        layout,
        settings,
        paneCount: readLayout.panes.length,
        tabCount: readLayout.tabs.length,
        workspaceCount: readLayout.workspaces.length,
      }
    })()
  `
}

function electronSmokeUiStateReloadScript(input: { setupResult: unknown }): string {
  return `
    (async () => {
      const api = window.electronAPI
      if (!api) throw new Error('window.electronAPI is unavailable for UI-state reload check')
      await api.signalReady()
      const expected = ${JSON.stringify(input.setupResult)}
      const readStartedAt = performance.now()
      const layout = await api.readLayout()
      const settings = await api.readSettings()
      const readMs = performance.now() - readStartedAt
      const stable = (value) => {
        if (Array.isArray(value)) return value.map(stable)
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]))
        }
        return value
      }
      const stableJson = (value) => JSON.stringify(stable(value))
      const expectedLayout = expected.layout
      const expectedWorkspace = expectedLayout.workspaces[0]
      const workspace = layout.workspaces.find((item) => item.id === expectedWorkspace.id)
      if (
        !workspace ||
        workspace.name !== expectedWorkspace.name ||
        workspace.projectPath !== expectedWorkspace.projectPath ||
        workspace.lastActiveTabId !== expectedWorkspace.lastActiveTabId
      ) {
        throw new Error('Smoke UI workspace layout did not survive reload: ' + JSON.stringify(layout.workspaces))
      }
      const expectedTab = expectedLayout.tabs[0]
      const tab = layout.tabs.find((item) => item.id === expectedTab.id)
      if (
        !tab ||
        tab.workspaceId !== expectedTab.workspaceId ||
        tab.lastActivePaneId !== expectedTab.lastActivePaneId ||
        stableJson(tab.layout) !== stableJson(expectedTab.layout)
      ) {
        throw new Error('Smoke UI tab layout did not survive reload: ' + JSON.stringify(layout.tabs))
      }
      for (const expectedPane of expectedLayout.panes) {
        const pane = layout.panes.find((item) => item.id === expectedPane.id)
        if (
          !pane ||
          pane.terminalId !== expectedPane.terminalId ||
          pane.tabId !== expectedPane.tabId ||
          pane.type !== expectedPane.type ||
          pane.name !== expectedPane.name ||
          pane.cwd !== expectedPane.cwd ||
          pane.status !== expectedPane.status
        ) {
          throw new Error('Smoke UI pane layout did not survive reload: ' + JSON.stringify(layout.panes))
        }
      }
      if (
        layout.activeWorkspaceId !== expectedLayout.activeWorkspaceId ||
        layout.activeTabId !== expectedLayout.activeTabId ||
        layout.activePaneId !== expectedLayout.activePaneId ||
        layout.sidebarExpanded !== expectedLayout.sidebarExpanded ||
        layout.sidebarWidth !== expectedLayout.sidebarWidth ||
        layout.rightSidebarExpanded !== expectedLayout.rightSidebarExpanded ||
        layout.rightSidebarWidth !== expectedLayout.rightSidebarWidth
      ) {
        throw new Error('Smoke UI layout did not survive reload: ' + JSON.stringify(layout))
      }
      if (stableJson(settings) !== stableJson(expected.settings)) {
        throw new Error('Smoke settings did not survive reload: ' + JSON.stringify(settings))
      }
      return {
        readMs,
        layoutVersion: layout.version,
        paneCount: layout.panes.length,
        tabCount: layout.tabs.length,
        workspaceCount: layout.workspaces.length,
        activePaneId: layout.activePaneId,
        persistenceEnabled: settings.persistence?.enabled === true,
      }
    })()
  `
}

function withTimeout<A>(promise: Promise<A>, timeoutMs: number, label: string): Promise<A> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type ElectronSmokeProcessMetrics = {
  mainRssKb: number
  rendererPid: number
  rendererRssKb: number | null
  taodPid: number | null
  taodRssKb: number | null
  taodDiagnostics: ReturnType<TaodClient['getLifecycleDiagnostics']> | null
}

type ElectronSmokeReloadCycleSummary = {
  cycle: number
  reloadMs: number
  sessionCount: number
  results: ReturnType<typeof summarizeElectronSmokeResult>[]
  workspace: unknown
}

function summarizeElectronSmokeResult(result: any) {
  return {
    sessionId: typeof result?.sessionId === 'string' ? result.sessionId : null,
    durationMs: typeof result?.durationMs === 'number' ? result.durationMs : null,
    rendererReadyMs: typeof result?.rendererReadyMs === 'number' ? result.rendererReadyMs : null,
    createSessionMs: typeof result?.createSessionMs === 'number' ? result.createSessionMs : null,
    firstOutputMs: typeof result?.firstOutputMs === 'number' ? result.firstOutputMs : null,
    inputEchoMs: typeof result?.inputEchoMs === 'number' ? result.inputEchoMs : null,
    throughputBytesPerSec:
      typeof result?.throughputBytesPerSec === 'number' ? result.throughputBytesPerSec : null,
    receivedBytes: typeof result?.receivedBytes === 'number' ? result.receivedBytes : null,
    preload: {
      pendingClientMessages:
        typeof result?.diagnostics?.pendingClientMessages === 'number'
          ? result.diagnostics.pendingClientMessages
          : null,
      pendingOutputChars:
        typeof result?.diagnostics?.pendingOutputChars === 'number'
          ? result.diagnostics.pendingOutputChars
          : null,
      pendingDataDroppedCharsTotal:
        typeof result?.diagnostics?.pendingDataDroppedCharsTotal === 'number'
          ? result.diagnostics.pendingDataDroppedCharsTotal
          : null,
      pendingDataTruncatedCharsTotal:
        typeof result?.diagnostics?.pendingDataTruncatedCharsTotal === 'number'
          ? result.diagnostics.pendingDataTruncatedCharsTotal
          : null,
      pendingOutputDroppedCharsTotal:
        typeof result?.diagnostics?.pendingOutputDroppedCharsTotal === 'number'
          ? result.diagnostics.pendingOutputDroppedCharsTotal
          : null,
      pendingOutputTruncatedCharsTotal:
        typeof result?.diagnostics?.pendingOutputTruncatedCharsTotal === 'number'
          ? result.diagnostics.pendingOutputTruncatedCharsTotal
          : null,
    },
    taod: {
      state:
        typeof result?.taodDiagnostics?.state === 'string' ? result.taodDiagnostics.state : null,
      controlRequestCount:
        typeof result?.taodDiagnostics?.controlRequestCount === 'number'
          ? result.taodDiagnostics.controlRequestCount
          : null,
      activeSubscribers:
        typeof result?.taodDiagnostics?.streamDiagnostics?.activeSubscribers === 'number'
          ? result.taodDiagnostics.streamDiagnostics.activeSubscribers
          : null,
      pendingOutputBytes:
        typeof result?.taodDiagnostics?.streamDiagnostics?.pendingOutputBytes === 'number'
          ? result.taodDiagnostics.streamDiagnostics.pendingOutputBytes
          : null,
      outputBytesTotal:
        typeof result?.taodDiagnostics?.streamDiagnostics?.outputBytesTotal === 'number'
          ? result.taodDiagnostics.streamDiagnostics.outputBytesTotal
          : null,
      inputBytesTotal:
        typeof result?.taodDiagnostics?.streamDiagnostics?.inputBytesTotal === 'number'
          ? result.taodDiagnostics.streamDiagnostics.inputBytesTotal
          : null,
      lastPingDurationMs:
        typeof result?.taodDiagnostics?.timing?.lastPingDurationMs === 'number'
          ? result.taodDiagnostics.timing.lastPingDurationMs
          : null,
      lastStartDurationMs:
        typeof result?.taodDiagnostics?.timing?.lastStartDurationMs === 'number'
          ? result.taodDiagnostics.timing.lastStartDurationMs
          : null,
    },
    bridge: {
      portConnected:
        typeof result?.bridgeDiagnostics?.portConnected === 'boolean'
          ? result.bridgeDiagnostics.portConnected
          : null,
      activeSessions:
        typeof result?.bridgeDiagnostics?.activeSessions === 'number'
          ? result.bridgeDiagnostics.activeSessions
          : null,
      activeStreams:
        typeof result?.bridgeDiagnostics?.activeStreams === 'number'
          ? result.bridgeDiagnostics.activeStreams
          : null,
      messagesPostedTotal:
        typeof result?.bridgeDiagnostics?.messagesPostedTotal === 'number'
          ? result.bridgeDiagnostics.messagesPostedTotal
          : null,
      dataMessagesPostedTotal:
        typeof result?.bridgeDiagnostics?.dataMessagesPostedTotal === 'number'
          ? result.bridgeDiagnostics.dataMessagesPostedTotal
          : null,
      dataCharsPostedTotal:
        typeof result?.bridgeDiagnostics?.dataCharsPostedTotal === 'number'
          ? result.bridgeDiagnostics.dataCharsPostedTotal
          : null,
      messagesDroppedNoPortTotal:
        typeof result?.bridgeDiagnostics?.messagesDroppedNoPortTotal === 'number'
          ? result.bridgeDiagnostics.messagesDroppedNoPortTotal
          : null,
      postFailuresTotal:
        typeof result?.bridgeDiagnostics?.postFailuresTotal === 'number'
          ? result.bridgeDiagnostics.postFailuresTotal
          : null,
    },
    rendererTrace: {
      count: Array.isArray(result?.rendererTraceEntries) ? result.rendererTraceEntries.length : 0,
      names: Array.isArray(result?.rendererTraceEntries)
        ? result.rendererTraceEntries
            .map((entry: { name?: unknown }) => entry.name)
            .filter((name: unknown): name is string => typeof name === 'string')
            .slice(-16)
        : [],
    },
  }
}

async function rssKbForPid(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return null
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], {
      timeout: 1000,
    })
    const parsed = Number.parseInt(String(stdout).trim(), 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  } catch {
    return null
  }
}

async function sampleElectronSmokeMetrics(
  window: BrowserWindow,
): Promise<ElectronSmokeProcessMetrics> {
  const taodDiagnostics =
    (await taodClient?.refreshLifecycleDiagnostics().catch(() => null)) ?? null
  const taodPid = taodDiagnostics?.spawnedPid ?? null
  const rendererPid = window.webContents.getOSProcessId()
  const [rendererRssKb, taodRssKb] = await Promise.all([
    rssKbForPid(rendererPid),
    taodPid ? rssKbForPid(taodPid) : Promise.resolve(null),
  ])

  return {
    mainRssKb: Math.round(process.memoryUsage().rss / 1024),
    rendererPid,
    rendererRssKb,
    taodPid,
    taodRssKb,
    taodDiagnostics,
  }
}

function summarizeElectronSmokeMetrics(metrics: ElectronSmokeProcessMetrics) {
  const stream = metrics.taodDiagnostics?.streamDiagnostics
  return {
    mainRssKb: metrics.mainRssKb,
    rendererPid: metrics.rendererPid,
    rendererRssKb: metrics.rendererRssKb,
    taodPid: metrics.taodPid,
    taodRssKb: metrics.taodRssKb,
    taod: metrics.taodDiagnostics
      ? {
          state: metrics.taodDiagnostics.state,
          daemonOwnership: metrics.taodDiagnostics.daemonOwnership,
          recoveryAction: metrics.taodDiagnostics.recoveryAction,
          controlRequestCount: metrics.taodDiagnostics.controlRequestCount,
          activeSubscribers: stream?.activeSubscribers ?? null,
          pendingOutputBytes: stream?.pendingOutputBytes ?? null,
          outputBytesTotal: stream?.outputBytesTotal ?? null,
          inputBytesTotal: stream?.inputBytesTotal ?? null,
          slowSubscriberDropsTotal: stream?.slowSubscriberDropsTotal ?? null,
          lastPingDurationMs: metrics.taodDiagnostics.timing.lastPingDurationMs ?? null,
          lastStartDurationMs: metrics.taodDiagnostics.timing.lastStartDurationMs ?? null,
        }
      : null,
  }
}

async function waitForElectronSmokeBaseline(
  window: BrowserWindow,
  isSmokeSettled: () => boolean,
): Promise<ElectronSmokeProcessMetrics> {
  const deadline = Date.now() + Math.max(500, Math.min(5000, ELECTRON_SMOKE_OUTPUT_START_DELAY_MS))
  let lastMetrics = await sampleElectronSmokeMetrics(window)
  while (!isSmokeSettled() && Date.now() < deadline) {
    if (
      lastMetrics.taodPid &&
      lastMetrics.taodRssKb !== null &&
      lastMetrics.taodDiagnostics?.state.endsWith('-live')
    ) {
      return lastMetrics
    }
    await delay(50)
    lastMetrics = await sampleElectronSmokeMetrics(window)
  }
  return lastMetrics
}

function waitForRendererReload(window: BrowserWindow): Promise<number> {
  const startedAt = performance.now()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.webContents.off('did-finish-load', onFinish)
      window.webContents.off('did-fail-load', onFail)
    }
    const onFinish = () => {
      cleanup()
      resolve(performance.now() - startedAt)
    }
    const onFail = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
    ) => {
      cleanup()
      reject(
        new Error(`Renderer reload failed (${errorCode}) ${errorDescription}: ${validatedURL}`),
      )
    }
    window.webContents.once('did-finish-load', onFinish)
    window.webContents.once('did-fail-load', onFail)
    window.webContents.reload()
  })
}

async function runElectronSmoke(): Promise<void> {
  const smokeStartedAt = performance.now()
  const window = createWindow()
  await withTimeout(
    mainWindowLoadPromise ?? Promise.reject(new Error('Renderer load was not started')),
    ELECTRON_SMOKE_TIMEOUT_MS,
    'Electron smoke renderer load',
  )
  const rendererLoadMs = performance.now() - smokeStartedAt
  if (
    ELECTRON_SMOKE_MAX_RENDERER_LOAD_MS > 0 &&
    rendererLoadMs > ELECTRON_SMOKE_MAX_RENDERER_LOAD_MS
  ) {
    throw new Error(
      `Smoke renderer load above budget: ${Math.round(rendererLoadMs)} ms > ${ELECTRON_SMOKE_MAX_RENDERER_LOAD_MS} ms`,
    )
  }
  const traceStarted = await startElectronSmokeTrace()
  const token = `tao-electron-smoke-${Date.now().toString(36)}`
  let smokeSettled = false
  const smokePromise = withTimeout(
    window.webContents.executeJavaScript(
      electronSmokeScript({ cwd: process.cwd(), token, keepSession: ELECTRON_SMOKE_RELOAD }),
      true,
    ),
    ELECTRON_SMOKE_TIMEOUT_MS,
    'Electron smoke terminal session',
  ).finally(() => {
    smokeSettled = true
  })
  const beforeMetrics = await waitForElectronSmokeBaseline(window, () => smokeSettled)
  const result = await smokePromise
  let reloadSessionResults = [result]
  let reloadWorkspaceId = `electron-smoke-workspace-${Date.now().toString(36)}`
  const reloadWorkspaceName = 'Electron Smoke Workspace'
  let reloadWorkspaceSetupResult: unknown = null
  let reloadWorkspaceResult: unknown = null
  let reloadUiStateSetupResult: unknown = null
  let reloadUiStateResult: unknown = null
  if (ELECTRON_SMOKE_RELOAD) {
    reloadWorkspaceSetupResult = await withTimeout(
      window.webContents.executeJavaScript(
        electronSmokeWorkspaceSetupScript({
          cwd: process.cwd(),
          workspaceId: reloadWorkspaceId,
          name: reloadWorkspaceName,
        }),
        true,
      ),
      ELECTRON_SMOKE_TIMEOUT_MS,
      'Electron smoke workspace setup',
    )
    if (
      typeof reloadWorkspaceSetupResult === 'object' &&
      reloadWorkspaceSetupResult !== null &&
      typeof (reloadWorkspaceSetupResult as { workspaceId?: unknown }).workspaceId === 'string'
    ) {
      reloadWorkspaceId = (reloadWorkspaceSetupResult as { workspaceId: string }).workspaceId
    }
    reloadUiStateSetupResult = await withTimeout(
      window.webContents.executeJavaScript(
        electronSmokeUiStateSetupScript({ cwd: process.cwd(), workspaceId: reloadWorkspaceId }),
        true,
      ),
      ELECTRON_SMOKE_TIMEOUT_MS,
      'Electron smoke UI-state setup',
    )
    for (let index = 1; index < ELECTRON_SMOKE_RELOAD_SESSION_COUNT; index += 1) {
      const extraToken = `tao-electron-smoke-${Date.now().toString(36)}-${index + 1}`
      const extraResult = await withTimeout(
        window.webContents.executeJavaScript(
          electronSmokeScript({ cwd: process.cwd(), token: extraToken, keepSession: true }),
          true,
        ),
        ELECTRON_SMOKE_TIMEOUT_MS,
        `Electron smoke terminal session ${index + 1}`,
      )
      reloadSessionResults.push(extraResult)
    }
  }
  const reloadCycleResults: unknown[] = []
  let lastReloadCycleResult: ElectronSmokeReloadCycleSummary | null = null
  let completedReloadCycles = 0
  let maxReloadMs: number | null = null
  if (ELECTRON_SMOKE_RELOAD) {
    const reloadStartedAt = performance.now()
    let nextProgressAt =
      ELECTRON_SMOKE_PROGRESS_INTERVAL_MS > 0
        ? reloadStartedAt + ELECTRON_SMOKE_PROGRESS_INTERVAL_MS
        : Number.POSITIVE_INFINITY
    const shouldRunReloadCycle = (cycle: number) =>
      ELECTRON_SMOKE_RELOAD_DURATION_MS > 0
        ? cycle === 0 || performance.now() - reloadStartedAt < ELECTRON_SMOKE_RELOAD_DURATION_MS
        : cycle < ELECTRON_SMOKE_RELOAD_CYCLES

    for (let cycle = 0; shouldRunReloadCycle(cycle); cycle += 1) {
      if (cycle > 0) {
        reloadSessionResults = []
        for (let index = 0; index < ELECTRON_SMOKE_RELOAD_SESSION_COUNT; index += 1) {
          const extraToken = `tao-electron-smoke-${Date.now().toString(36)}-cycle-${cycle + 1}-${index + 1}`
          const extraResult = await withTimeout(
            window.webContents.executeJavaScript(
              electronSmokeScript({ cwd: process.cwd(), token: extraToken, keepSession: true }),
              true,
            ),
            ELECTRON_SMOKE_TIMEOUT_MS,
            `Electron smoke reload cycle ${cycle + 1} terminal session ${index + 1}`,
          )
          reloadSessionResults.push(extraResult)
        }
      }

      const reloadMs = await withTimeout(
        waitForRendererReload(window),
        ELECTRON_SMOKE_TIMEOUT_MS,
        `Electron smoke renderer reload cycle ${cycle + 1}`,
      )
      maxReloadMs = maxReloadMs === null ? reloadMs : Math.max(maxReloadMs, reloadMs)
      if (ELECTRON_SMOKE_MAX_RELOAD_MS > 0 && reloadMs > ELECTRON_SMOKE_MAX_RELOAD_MS) {
        throw new Error(
          `Smoke renderer reload above budget: ${Math.round(reloadMs)} ms > ${ELECTRON_SMOKE_MAX_RELOAD_MS} ms`,
        )
      }
      const cycleAttachResults: unknown[] = []
      for (const [index, sessionResult] of reloadSessionResults.entries()) {
        const reloadResult = await withTimeout(
          window.webContents.executeJavaScript(
            electronSmokeReloadAttachScript({ sessionId: sessionResult.sessionId }),
            true,
          ),
          ELECTRON_SMOKE_TIMEOUT_MS,
          `Electron smoke reload cycle ${cycle + 1} attach ${index + 1}`,
        )
        cycleAttachResults.push(reloadResult)
      }
      if (cycle === 0) {
        reloadWorkspaceResult = await withTimeout(
          window.webContents.executeJavaScript(
            electronSmokeWorkspaceReloadScript({ workspaceId: reloadWorkspaceId }),
            true,
          ),
          ELECTRON_SMOKE_TIMEOUT_MS,
          'Electron smoke workspace reload check',
        )
        reloadUiStateResult = await withTimeout(
          window.webContents.executeJavaScript(
            electronSmokeUiStateReloadScript({ setupResult: reloadUiStateSetupResult }),
            true,
          ),
          ELECTRON_SMOKE_TIMEOUT_MS,
          'Electron smoke UI-state reload check',
        )
      }

      const cycleSummary: ElectronSmokeReloadCycleSummary = {
        cycle: cycle + 1,
        reloadMs,
        sessionCount: reloadSessionResults.length,
        results: cycleAttachResults.map(summarizeElectronSmokeResult),
        workspace:
          cycle === 0
            ? {
                setup: reloadWorkspaceSetupResult,
                result: reloadWorkspaceResult,
                uiState: {
                  setup: reloadUiStateSetupResult,
                  result: reloadUiStateResult,
                },
              }
            : null,
      }
      lastReloadCycleResult = cycleSummary
      completedReloadCycles = cycleSummary.cycle
      if (ELECTRON_SMOKE_RELOAD_DURATION_MS === 0 || reloadCycleResults.length < 3) {
        reloadCycleResults.push(cycleSummary)
      }

      const now = performance.now()
      if (now >= nextProgressAt) {
        const metrics = await sampleElectronSmokeMetrics(window)
        console.log(
          '[electron-smoke] progress',
          JSON.stringify({
            elapsedMs: now - reloadStartedAt,
            cycle: cycleSummary.cycle,
            maxReloadMs,
            lastReloadMs: reloadMs,
            sessionCount: cycleSummary.sessionCount,
            memory: summarizeElectronSmokeMetrics(metrics),
          }),
        )
        do {
          nextProgressAt += ELECTRON_SMOKE_PROGRESS_INTERVAL_MS
        } while (now >= nextProgressAt)
      }

      if (ELECTRON_SMOKE_RELOAD_DURATION_MS > 0 && ELECTRON_SMOKE_RELOAD_INTERVAL_MS > 0) {
        const nextCycleAt = reloadStartedAt + cycleSummary.cycle * ELECTRON_SMOKE_RELOAD_INTERVAL_MS
        const deadlineAt = reloadStartedAt + ELECTRON_SMOKE_RELOAD_DURATION_MS
        const delayMs = Math.min(nextCycleAt, deadlineAt) - performance.now()
        if (delayMs > 0) await delay(delayMs)
      }
    }
  }
  const afterMetrics = await sampleElectronSmokeMetrics(window)
  const totalMs = performance.now() - smokeStartedAt
  const mainRssGrowthKb = afterMetrics.mainRssKb - beforeMetrics.mainRssKb
  const rendererRssGrowthKb =
    beforeMetrics.rendererRssKb === null || afterMetrics.rendererRssKb === null
      ? null
      : afterMetrics.rendererRssKb - beforeMetrics.rendererRssKb
  const taodRssGrowthKb =
    beforeMetrics.taodRssKb === null || afterMetrics.taodRssKb === null
      ? null
      : afterMetrics.taodRssKb - beforeMetrics.taodRssKb

  if (
    ELECTRON_SMOKE_MAX_MAIN_RSS_GROWTH_KB > 0 &&
    mainRssGrowthKb > ELECTRON_SMOKE_MAX_MAIN_RSS_GROWTH_KB
  ) {
    throw new Error(
      `Smoke main RSS growth above budget: ${mainRssGrowthKb} KiB > ${ELECTRON_SMOKE_MAX_MAIN_RSS_GROWTH_KB} KiB`,
    )
  }
  if (ELECTRON_SMOKE_MAX_RENDERER_RSS_GROWTH_KB > 0) {
    if (rendererRssGrowthKb === null) {
      throw new Error('Smoke could not measure renderer RSS growth')
    }
    if (rendererRssGrowthKb > ELECTRON_SMOKE_MAX_RENDERER_RSS_GROWTH_KB) {
      throw new Error(
        `Smoke renderer RSS growth above budget: ${rendererRssGrowthKb} KiB > ${ELECTRON_SMOKE_MAX_RENDERER_RSS_GROWTH_KB} KiB`,
      )
    }
  }
  if (ELECTRON_SMOKE_MAX_TAOD_RSS_GROWTH_KB > 0) {
    if (taodRssGrowthKb === null) {
      throw new Error('Smoke could not measure taod RSS growth')
    }
    if (taodRssGrowthKb > ELECTRON_SMOKE_MAX_TAOD_RSS_GROWTH_KB) {
      throw new Error(
        `Smoke taod RSS growth above budget: ${taodRssGrowthKb} KiB > ${ELECTRON_SMOKE_MAX_TAOD_RSS_GROWTH_KB} KiB`,
      )
    }
  }
  if (
    ELECTRON_SMOKE_MAX_MAIN_RSS_KB > 0 &&
    afterMetrics.mainRssKb > ELECTRON_SMOKE_MAX_MAIN_RSS_KB
  ) {
    throw new Error(
      `Smoke main RSS above budget: ${afterMetrics.mainRssKb} KiB > ${ELECTRON_SMOKE_MAX_MAIN_RSS_KB} KiB`,
    )
  }
  if (
    ELECTRON_SMOKE_MAX_RENDERER_RSS_KB > 0 &&
    afterMetrics.rendererRssKb !== null &&
    afterMetrics.rendererRssKb > ELECTRON_SMOKE_MAX_RENDERER_RSS_KB
  ) {
    throw new Error(
      `Smoke renderer RSS above budget: ${afterMetrics.rendererRssKb} KiB > ${ELECTRON_SMOKE_MAX_RENDERER_RSS_KB} KiB`,
    )
  }
  if (
    ELECTRON_SMOKE_MAX_TAOD_RSS_KB > 0 &&
    afterMetrics.taodRssKb !== null &&
    afterMetrics.taodRssKb > ELECTRON_SMOKE_MAX_TAOD_RSS_KB
  ) {
    throw new Error(
      `Smoke taod RSS above budget: ${afterMetrics.taodRssKb} KiB > ${ELECTRON_SMOKE_MAX_TAOD_RSS_KB} KiB`,
    )
  }
  if (ELECTRON_SMOKE_MAX_TOTAL_MS > 0 && totalMs > ELECTRON_SMOKE_MAX_TOTAL_MS) {
    throw new Error(
      `Smoke total runtime above budget: ${Math.round(totalMs)} ms > ${ELECTRON_SMOKE_MAX_TOTAL_MS} ms`,
    )
  }

  const traceResult = await stopElectronSmokeTrace(traceStarted)
  console.log(
    '[electron-smoke] passed',
    JSON.stringify({
      ...summarizeElectronSmokeResult(result),
      startup: {
        rendererLoadMs,
        firstOutputMs: result.firstOutputMs,
        inputEchoMs: result.inputEchoMs,
        totalMs,
        maxRendererLoadMs:
          ELECTRON_SMOKE_MAX_RENDERER_LOAD_MS > 0 ? ELECTRON_SMOKE_MAX_RENDERER_LOAD_MS : null,
        maxFirstOutputMs:
          ELECTRON_SMOKE_MAX_FIRST_OUTPUT_MS > 0 ? ELECTRON_SMOKE_MAX_FIRST_OUTPUT_MS : null,
        maxInputEchoMs:
          ELECTRON_SMOKE_MAX_INPUT_ECHO_MS > 0 ? ELECTRON_SMOKE_MAX_INPUT_ECHO_MS : null,
        maxTotalMs: ELECTRON_SMOKE_MAX_TOTAL_MS > 0 ? ELECTRON_SMOKE_MAX_TOTAL_MS : null,
      },
      reload:
        maxReloadMs === null
          ? null
          : {
              observedMaxReloadMs: maxReloadMs,
              cycleCount: completedReloadCycles,
              requestedCycles: ELECTRON_SMOKE_RELOAD_CYCLES,
              requestedDurationMs:
                ELECTRON_SMOKE_RELOAD_DURATION_MS > 0 ? ELECTRON_SMOKE_RELOAD_DURATION_MS : null,
              cycles:
                ELECTRON_SMOKE_RELOAD_DURATION_MS > 0 &&
                lastReloadCycleResult &&
                !reloadCycleResults.some(
                  (result) =>
                    typeof result === 'object' &&
                    result !== null &&
                    (result as { cycle?: unknown }).cycle === lastReloadCycleResult.cycle,
                )
                  ? [...reloadCycleResults, lastReloadCycleResult]
                  : reloadCycleResults,
              sampledCycleCount: reloadCycleResults.length,
              lastCycle: lastReloadCycleResult,
              maxReloadMs: ELECTRON_SMOKE_MAX_RELOAD_MS > 0 ? ELECTRON_SMOKE_MAX_RELOAD_MS : null,
              maxReloadAttachMs:
                ELECTRON_SMOKE_MAX_RELOAD_ATTACH_MS > 0
                  ? ELECTRON_SMOKE_MAX_RELOAD_ATTACH_MS
                  : null,
              maxReloadEchoMs:
                ELECTRON_SMOKE_MAX_RELOAD_ECHO_MS > 0 ? ELECTRON_SMOKE_MAX_RELOAD_ECHO_MS : null,
            },
      memory: {
        before: beforeMetrics,
        after: afterMetrics,
        mainRssGrowthKb,
        rendererRssGrowthKb,
        taodRssGrowthKb,
        maxMainRssGrowthKb:
          ELECTRON_SMOKE_MAX_MAIN_RSS_GROWTH_KB > 0 ? ELECTRON_SMOKE_MAX_MAIN_RSS_GROWTH_KB : null,
        maxRendererRssGrowthKb:
          ELECTRON_SMOKE_MAX_RENDERER_RSS_GROWTH_KB > 0
            ? ELECTRON_SMOKE_MAX_RENDERER_RSS_GROWTH_KB
            : null,
        maxTaodRssGrowthKb:
          ELECTRON_SMOKE_MAX_TAOD_RSS_GROWTH_KB > 0 ? ELECTRON_SMOKE_MAX_TAOD_RSS_GROWTH_KB : null,
        maxMainRssKb: ELECTRON_SMOKE_MAX_MAIN_RSS_KB > 0 ? ELECTRON_SMOKE_MAX_MAIN_RSS_KB : null,
        maxRendererRssKb:
          ELECTRON_SMOKE_MAX_RENDERER_RSS_KB > 0 ? ELECTRON_SMOKE_MAX_RENDERER_RSS_KB : null,
        maxTaodRssKb: ELECTRON_SMOKE_MAX_TAOD_RSS_KB > 0 ? ELECTRON_SMOKE_MAX_TAOD_RSS_KB : null,
      },
      trace: traceResult,
    }),
  )
  await finishElectronSmoke(0)
}

async function finishElectronSmoke(code: number): Promise<void> {
  const forceExit = setTimeout(() => {
    console.error('[electron-smoke] forced process exit after cleanup timeout')
    process.exit(code)
  }, 5000)
  try {
    await withTimeout(disposeSessionBackends(), 3000, 'Electron smoke backend disposal').catch(
      (error) => {
        console.error('[electron-smoke] backend disposal failed:', error)
      },
    )
    mainWindow?.destroy()
    mainWindow = null
    await withTimeout(disposeMainRuntime(), 3000, 'Electron smoke runtime disposal').catch(
      (error) => {
        console.error('[electron-smoke] runtime disposal failed:', error)
      },
    )
  } finally {
    clearTimeout(forceExit)
    app.exit(code)
    process.exit(code)
  }
}

app.whenReady().then(() => {
  if (isElectronSmoke()) {
    void runElectronSmoke().catch((error) => {
      console.error('[electron-smoke] failed:', error)
      void finishElectronSmoke(1)
    })
    return
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  void disposeSessionBackends()
  void disposeMainRuntime()
})
