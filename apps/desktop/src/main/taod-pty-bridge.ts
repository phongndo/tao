import { Schema } from 'effect'
import type { MessagePortMain } from 'electron'
import { StringDecoder } from 'node:string_decoder'
import { TaodStreamFrameKind } from '@tao/shared/taod-protocol'
import {
  appendResize,
  clearAllSessionPersistence,
  clearSessionPersistence,
  cleanupSessionPersistence,
  openPersistentSession,
  resetPersistentSession,
} from './session-persistence'
import { defaultSettings, readSettings } from './settings-store'
import {
  type PtyClientMessage,
  PtyClientMessageSchema,
  type PtyServiceMessage,
} from './pty-protocol'
import { TaodClient, type TaodControlResponse, type TaodSessionStream } from './taod-client'
import { decodeTaodExitPayload, decodeTaodResizePayload } from './taod-stream'

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000

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
}

function decodeClientMessage(message: unknown): PtyClientMessage | null {
  const decoded = Schema.decodeUnknownOption(PtyClientMessageSchema)(message)
  return decoded._tag === 'Some' ? decoded.value : null
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isNotFoundError(error: unknown): boolean {
  return normalizeError(error).message.toLowerCase().includes('session not found')
}

function sanitizeCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string') return undefined
  const trimmed = cwd.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isValidSize(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0
}

function bigintToSafeNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
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

export class TaodPtyBridge {
  private readonly client: TaodClient
  private readonly defaultShell?: string
  private port: MessagePortMain | null = null
  private readonly sessions = new Map<string, BridgeSession>()
  private readonly cleanupTimer: ReturnType<typeof setInterval>

  constructor(options: TaodPtyBridgeOptions = {}) {
    this.client = options.client ?? new TaodClient()
    this.defaultShell = options.defaultShell
    this.cleanupTimer = setInterval(() => {
      void this.runSessionCleanup()
    }, SESSION_CLEANUP_INTERVAL_MS)
  }

  ensureReady(): Promise<void> {
    return this.client.ensureRunning()
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
  }

  private async handleClientMessage(message: PtyClientMessage): Promise<void> {
    switch (message.type) {
      case 'renderer-ready':
        break
      case 'spawn':
        if (!isValidSize(message.cols, message.rows)) return
        await this.openSession(
          message.sessionId,
          message.cols,
          message.rows,
          sanitizeCwd(message.cwd),
          {
            forceCreate: true,
          },
        )
        break
      case 'attach':
        if (!isValidSize(message.cols, message.rows)) return
        await this.openSession(
          message.sessionId,
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
        this.clearSessionHistory(message.sessionIds)
        break
    }
  }

  private async openSession(
    sessionId: string,
    cols: number,
    rows: number,
    cwd: string | undefined,
    options: { forceCreate: boolean },
  ): Promise<void> {
    const existing = this.sessions.get(sessionId)
    if (existing?.stream) {
      existing.cols = cols
      existing.rows = rows
      existing.stream.resize(cols, rows)
      this.postReady(sessionId, { cols, rows }, 0, existing.archived)
      return
    }

    let attachResponse: TaodControlResponse
    let stream: TaodSessionStream
    if (options.forceCreate) {
      await this.createShellSession(sessionId, cols, rows, cwd)
      ;({ response: attachResponse, stream } = await this.client.attachSession({
        sessionId,
        terminalId: sessionId,
        cols,
        rows,
        cwd,
      }))
    } else {
      try {
        ;({ response: attachResponse, stream } = await this.client.attachSession({
          sessionId,
          terminalId: sessionId,
          cols,
          rows,
          cwd,
        }))
      } catch (error) {
        if (!isNotFoundError(error)) throw error
        await this.createShellSession(sessionId, cols, rows, cwd)
        ;({ response: attachResponse, stream } = await this.client.attachSession({
          sessionId,
          terminalId: sessionId,
          cols,
          rows,
          cwd,
        }))
      }
    }

    if (attachResponse.status === 'archived') {
      // Older daemons could attach persisted logs as read-only archive sessions.
      // Tao no longer restores cold shell scrollback; upgrade that case to a
      // real fresh shell under the same session id.
      stream.close()
      await this.createShellSession(sessionId, cols, rows, cwd)
      ;({ response: attachResponse, stream } = await this.client.attachSession({
        sessionId,
        terminalId: sessionId,
        cols,
        rows,
        cwd,
      }))
    }

    const archived = false
    const session: BridgeSession = {
      stream,
      decoder: new StringDecoder('utf8'),
      cols,
      rows,
      archived,
    }
    this.sessions.set(sessionId, session)
    this.wireStream(sessionId, session, stream)

    const size = responseSize(attachResponse, { cols, rows })
    this.postReady(sessionId, size, responseSeq(attachResponse), archived)
    stream.start()
  }

  private async createShellSession(
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
  ): Promise<TaodControlResponse> {
    return this.client.createSession({
      sessionId,
      terminalId: sessionId,
      cols,
      rows,
      cwd,
      argv: defaultShellArgv(this.defaultShell),
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
        case TaodStreamFrameKind.Exit: {
          const exit = decodeTaodExitPayload(frame.payload) ?? { exitCode: -1 }
          this.post({ type: 'exit', sessionId, info: exit })
          this.closeSessionStream(sessionId)
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

  private clearSessionHistory(sessionIds?: readonly string[]): void {
    const targetSessionIds = sessionIds ? new Set(sessionIds) : null

    for (const [sessionId, session] of this.sessions) {
      if (targetSessionIds && !targetSessionIds.has(sessionId)) continue
      const persistentSession = openPersistentSession(sessionId)
      resetPersistentSession(persistentSession)
      appendResize(persistentSession, session.cols, session.rows)
      this.postReady(
        sessionId,
        { cols: session.cols, rows: session.rows },
        bigintToSafeNumber(persistentSession.seq),
        session.archived,
      )
    }

    if (targetSessionIds) {
      for (const sessionId of targetSessionIds) {
        if (!this.sessions.has(sessionId)) clearSessionPersistence(sessionId)
      }
      return
    }

    clearAllSessionPersistence({ activeSessionIds: new Set(this.sessions.keys()) })
  }

  private async runSessionCleanup(): Promise<void> {
    try {
      const settings = (await readSettings()) ?? defaultSettings
      const persistence = settings.persistence ?? defaultSettings.persistence
      if (!persistence?.enabled) return

      cleanupSessionPersistence({
        retainDays: persistence.retainDays,
        maxSessionBytes: persistence.maxSessionBytes,
        activeSessionIds: new Set(this.sessions.keys()),
      })
    } catch (error) {
      console.warn('[taod-bridge] Session cleanup failed:', error)
    }
  }

  private postReady(
    sessionId: string,
    size: { cols: number; rows: number },
    seq: number,
    archived: boolean,
  ): void {
    this.post({ type: 'ready', sessionId, size, seq, ...(archived ? { archived } : {}) })
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
