import { Schema } from 'effect'
import type { MessagePortMain } from 'electron'
import { StringDecoder } from 'node:string_decoder'
import {
  AgentStatusSchema,
  TaodStreamFrameKind,
  type AgentStatus,
  type AttachSessionMode,
} from '@tao/shared/taod-protocol'
import { defaultSettings, readSettings } from './settings-store'
import {
  type PtyClientMessage,
  PtyClientMessageSchema,
  type PtyServiceMessage,
} from './pty-protocol'
import type { SettingsData } from '@tao/shared/session'
import { TaodClient, type TaodControlResponse, type TaodSessionStream } from './taod-client'
import { decodeTaodExitPayload, decodeTaodResizePayload } from './taod-stream'

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const ATTACH_STREAM_READY_TIMEOUT_MS = 500

export type TaodPtyBridgeOptions = {
  readonly client?: TaodClient
  readonly defaultShell?: string
}

type BridgeSession = {
  stream: TaodSessionStream | null
  decoder: StringDecoder
  cols: number
  rows: number
  archived: boolean
  attachMode: AttachSessionMode
  agentProvider?: string
  nativeSessionId?: string | null
}

function decodeClientMessage(message: unknown): PtyClientMessage | null {
  const decoded = Schema.decodeUnknownOption(PtyClientMessageSchema)(message)
  return decoded._tag === 'Some' ? decoded.value : null
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error === 'object' && error && 'code' in error) {
    return (error as { code?: unknown }).code === 'session_not_found'
  }
  return false
}

function sanitizeCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string') return undefined
  const trimmed = cwd.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isValidSize(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0
}

function sanitizeArgv(argv: readonly string[] | undefined): string[] | undefined {
  if (!argv) return undefined
  const normalized = argv
    .map((arg) => (typeof arg === 'string' ? arg : ''))
    .filter((arg) => arg.length > 0)

  return normalized.length > 0 ? normalized : undefined
}

function responseSeq(response: TaodControlResponse): number {
  return typeof response.last_seq === 'number' ? response.last_seq : 0
}

function responseSize(response: TaodControlResponse, fallback: { cols: number; rows: number }) {
  const cols =
    typeof response.cols === 'number' && response.cols > 0 ? response.cols : fallback.cols
  const rows =
    typeof response.rows === 'number' && response.rows > 0 ? response.rows : fallback.rows
  return { cols, rows }
}

function defaultShellArgv(defaultShell?: string): string[] {
  const shell =
    defaultShell ?? process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  return [shell]
}

function responseAttachMode(response: TaodControlResponse): AttachSessionMode {
  switch (response.attach_kind) {
    case 'agent-resume':
      return 'agent-resume'
    case 'command-resume':
      return 'command-resume'
    case 'fresh':
      return 'fresh'
    case 'live':
    default:
      return 'live'
  }
}

function decodeAgentStatus(payload: Buffer): AgentStatus | null {
  try {
    const decoded = Schema.decodeUnknownOption(AgentStatusSchema)(
      JSON.parse(payload.toString('utf8')),
    )
    return decoded._tag === 'Some' ? decoded.value : null
  } catch {
    return null
  }
}

function waitForAttachStreamReady(stream: TaodSessionStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      settle()
    }, ATTACH_STREAM_READY_TIMEOUT_MS)

    function cleanup() {
      clearTimeout(timeout)
      stream.off('frame', onFrame)
      stream.off('error', onError)
      stream.off('close', onClose)
    }

    function settle(error?: Error) {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }

    function onFrame() {
      settle()
    }

    function onError(error: Error) {
      settle(error)
    }

    function onClose() {
      settle(new Error('taod attach stream closed before it became ready'))
    }

    stream.on('frame', onFrame)
    stream.once('error', onError)
    stream.once('close', onClose)
  })
}

export class TaodPtyBridge {
  private readonly client: TaodClient
  private readonly defaultShell?: string
  private port: MessagePortMain | null = null
  private readonly sessions = new Map<string, BridgeSession>()
  private readonly supersededAttachStreams = new WeakSet<TaodSessionStream>()
  private readonly cleanupTimer: ReturnType<typeof setInterval>

  constructor(options: TaodPtyBridgeOptions = {}) {
    this.client = options.client ?? new TaodClient()
    this.defaultShell = options.defaultShell
    this.cleanupTimer = setInterval(() => {
      void this.runSessionCleanup()
    }, SESSION_CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref?.()
  }

  async ensureReady(): Promise<void> {
    await this.client.ensureRunning()
    await this.syncPersistenceSettings()
  }

  async syncPersistenceSettings(settings?: SettingsData): Promise<void> {
    try {
      const resolved = settings ?? (await readSettings()) ?? defaultSettings
      const persistence = resolved.persistence ?? defaultSettings.persistence
      if (!persistence) return
      await this.client.configurePersistence({
        enabled: persistence.enabled,
        persistInput: persistence.persistInput,
      })
    } catch (error) {
      console.warn('[taod-bridge] Failed to sync persistence settings:', error)
    }
  }

  connectPort(port: MessagePortMain): void {
    this.detachAllStreams()
    this.port?.close()
    this.port = port
    port.on('message', (messageEvent) => {
      const message = decodeClientMessage(messageEvent.data)
      if (!message) return
      void this.handleClientMessage(message).catch((error) => {
        const sessionId = 'sessionId' in message ? message.sessionId : null
        if (sessionId) this.postError(sessionId, normalizeError(error).message)
      })
    })
    port.start()
  }

  dispose(): void {
    clearInterval(this.cleanupTimer)
    this.detachAllStreams()
    this.sessions.clear()
    this.port?.close()
    this.port = null
    this.client.dispose()
  }

  private async handleClientMessage(message: PtyClientMessage): Promise<void> {
    switch (message.type) {
      case 'renderer-ready':
        break
      case 'spawn':
        if (!isValidSize(message.cols, message.rows)) return
        await this.openSession(
          message.sessionId,
          message.terminalId ?? message.sessionId,
          message.cols,
          message.rows,
          sanitizeCwd(message.cwd),
          {
            forceCreate: true,
            argv: sanitizeArgv(message.argv),
          },
        )
        break
      case 'attach':
        if (!isValidSize(message.cols, message.rows)) return
        await this.openSession(
          message.sessionId,
          message.terminalId ?? message.sessionId,
          message.cols,
          message.rows,
          sanitizeCwd(message.cwd),
          {
            forceCreate: false,
          },
        )
        break
      case 'detach':
        await this.detachSession(message.sessionId)
        break
      case 'write':
        if (message.data.length === 0) return
        this.sessions.get(message.sessionId)?.stream?.writeInput(message.data)
        break
      case 'resize':
        if (!isValidSize(message.cols, message.rows)) return
        await this.resizeSession(message.sessionId, message.cols, message.rows)
        break
      case 'kill':
        await this.killSession(message.sessionId)
        break
      case 'clear-history':
        await this.clearSessionHistory(message.sessionIds)
        break
    }
  }

  private async openSession(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
    cwd: string | undefined,
    options: { forceCreate: boolean; argv?: readonly string[] },
  ): Promise<void> {
    const existing = this.sessions.get(sessionId)
    if (existing?.stream) {
      // A renderer can request attach for an already-streaming session when a terminal view is
      // remounted during tab/layout changes. Returning a bare ready message here leaves the new
      // Ghostty instance with no current-screen snapshot or startup bytes because the previous
      // stream already consumed them. Treat it as a real live reattach instead: close the old
      // subscriber socket and continue through taod attach so the daemon sends a fresh snapshot.
      existing.cols = cols
      existing.rows = rows
      this.supersededAttachStreams.add(existing.stream)
      this.closeSessionStream(sessionId)
    }

    let attachResponse: TaodControlResponse
    let stream: TaodSessionStream
    let attachMode: AttachSessionMode = 'live'
    if (options.forceCreate) {
      await this.createShellSession(sessionId, terminalId, cols, rows, cwd, options.argv)
      attachMode = 'fresh'
      ;({ response: attachResponse, stream } = await this.client.attachSession({
        sessionId,
        terminalId,
        cols,
        rows,
        cwd,
      }))
    } else {
      try {
        ;({ response: attachResponse, stream } = await this.client.attachSession({
          sessionId,
          terminalId,
          cols,
          rows,
          cwd,
        }))
      } catch (error) {
        if (!isNotFoundError(error)) throw error
        await this.createShellSession(sessionId, terminalId, cols, rows, cwd)
        attachMode = 'fresh'
        ;({ response: attachResponse, stream } = await this.client.attachSession({
          sessionId,
          terminalId,
          cols,
          rows,
          cwd,
        }))
      }
    }
    if (attachMode === 'live') attachMode = responseAttachMode(attachResponse)

    const archived = false
    const session: BridgeSession = {
      stream,
      decoder: new StringDecoder('utf8'),
      cols,
      rows,
      archived,
      attachMode,
      agentProvider: attachResponse.agent_provider,
      nativeSessionId: attachResponse.native_session_id,
    }
    this.sessions.set(sessionId, session)
    this.wireStream(sessionId, session, stream)
    const attachReady = waitForAttachStreamReady(stream)
    stream.start()
    try {
      await attachReady
    } catch (error) {
      // A remount/new renderer can supersede an in-flight attach for the same session. In that
      // case the old stream closes because Tao intentionally replaced it; don't report that stale
      // close to the renderer or it can clear the ready state for the newer attach.
      if (this.supersededAttachStreams.has(stream)) return
      this.closeSessionStream(sessionId)
      throw error
    }
    const size = responseSize(attachResponse, { cols, rows })
    this.postReady(sessionId, size, responseSeq(attachResponse), session)
  }

  private async createShellSession(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
    cwd?: string,
    argv?: readonly string[],
  ): Promise<TaodControlResponse> {
    return this.client.createSession({
      sessionId,
      terminalId,
      cols,
      rows,
      cwd,
      argv: argv && argv.length > 0 ? [...argv] : defaultShellArgv(this.defaultShell),
    })
  }

  private wireStream(sessionId: string, session: BridgeSession, stream: TaodSessionStream): void {
    stream.on('frame', (frame) => {
      if (frame.sessionId !== sessionId) return

      switch (frame.kind) {
        case TaodStreamFrameKind.Output: {
          const data = session.decoder.write(frame.payload)
          if (data.length > 0) this.postData(sessionId, data, frame.seq)
          break
        }
        case TaodStreamFrameKind.Resize: {
          const resize = decodeTaodResizePayload(frame.payload)
          if (!resize) return
          session.cols = resize.cols
          session.rows = resize.rows
          this.post({
            type: 'resize',
            sessionId,
            cols: resize.cols,
            rows: resize.rows,
            seq: frame.seq,
            replay: true,
          })
          break
        }
        case TaodStreamFrameKind.Snapshot: {
          if (session.archived) return
          this.post({
            type: 'snapshot',
            sessionId,
            dataBase64: frame.payload.toString('base64'),
            seq: frame.seq,
            live: true,
          })
          break
        }
        case TaodStreamFrameKind.Exit: {
          const exit = decodeTaodExitPayload(frame.payload) ?? { exitCode: -1 }
          this.post({ type: 'exit', sessionId, info: exit })
          this.closeSessionStream(sessionId)
          break
        }
        case TaodStreamFrameKind.Agent: {
          const status = decodeAgentStatus(frame.payload)
          if (status) this.post({ type: 'agent', sessionId, status })
          break
        }
      }
    })

    stream.once('error', (error) => {
      this.postError(sessionId, normalizeError(error).message)
      this.closeSessionStream(sessionId)
    })

    stream.once('close', () => {
      const current = this.sessions.get(sessionId)
      if (current?.stream === stream) current.stream = null
    })
  }

  private async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.cols = cols
      session.rows = rows
      session.stream?.resize(cols, rows)
      return
    }

    await this.client.resizeSession(sessionId, cols, rows).catch(() => {})
  }

  private async detachSession(sessionId: string): Promise<void> {
    this.closeSessionStream(sessionId)
    await this.client.detachSession(sessionId).catch(() => {})
  }

  private detachAllStreams(): void {
    for (const [sessionId, session] of this.sessions) {
      session.stream?.close()
      session.stream = null
      void this.client.detachSession(sessionId).catch(() => {})
    }
  }

  private async killSession(sessionId: string): Promise<void> {
    this.closeSessionStream(sessionId)
    this.sessions.delete(sessionId)
    await this.client.killSession(sessionId).catch(() => {})
  }

  private closeSessionStream(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.stream) return
    const stream = session.stream
    session.stream = null
    stream.close()
  }

  private async clearSessionHistory(sessionIds?: readonly string[]): Promise<void> {
    const targetSessionIds = sessionIds ? new Set(sessionIds) : null

    try {
      await this.client.clearHistory(sessionIds)
    } catch (error) {
      console.warn('[taod-bridge] Clear history failed:', error)
      return
    }

    for (const [sessionId, session] of this.sessions) {
      if (targetSessionIds && !targetSessionIds.has(sessionId)) continue
      this.postReady(sessionId, { cols: session.cols, rows: session.rows }, 0, session)
    }
  }

  private async runSessionCleanup(): Promise<void> {
    try {
      const settings = (await readSettings()) ?? defaultSettings
      const persistence = settings.persistence ?? defaultSettings.persistence
      await this.syncPersistenceSettings(settings)
      if (!persistence?.enabled) return

      await this.client.cleanupSessions({
        retainDays: persistence.retainDays,
        maxSessionBytes: persistence.maxSessionBytes,
        activeSessionIds: [...this.sessions.keys()],
      })
    } catch (error) {
      console.warn('[taod-bridge] Session cleanup failed:', error)
    }
  }

  private postReady(
    sessionId: string,
    size: { cols: number; rows: number },
    seq: number,
    session: Pick<BridgeSession, 'archived' | 'attachMode' | 'agentProvider' | 'nativeSessionId'>,
  ): void {
    this.post({
      type: 'ready',
      sessionId,
      size,
      seq,
      ...(session.archived ? { archived: session.archived } : {}),
      attachMode: session.attachMode,
      ...(session.agentProvider ? { agentProvider: session.agentProvider } : {}),
      ...(session.nativeSessionId !== undefined
        ? { nativeSessionId: session.nativeSessionId }
        : {}),
    })
  }

  private postData(sessionId: string, data: string, seq: number): void {
    this.post({ type: 'data', sessionId, data, seq })
  }

  private postError(sessionId: string, error: string): void {
    this.post({ type: 'error', sessionId, error })
  }

  private post(message: PtyServiceMessage): void {
    try {
      this.port?.postMessage(message)
    } catch {
      this.port = null
    }
  }
}
