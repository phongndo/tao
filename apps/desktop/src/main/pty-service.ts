import { Schema } from 'effect'
import type { MessagePortMain } from 'electron'
import { PtyManager } from './pty'
import {
  appendExit,
  appendOutput,
  appendResize,
  clearAllSessionPersistence,
  clearSessionPersistence,
  cleanupSessionPersistence,
  openPersistentSession,
  resetPersistentSession,
  type PersistentSession,
} from './session-persistence'
import { defaultSettings, readSettings } from './settings-store'
import {
  type PtyClientMessage,
  PtyClientMessageSchema,
  type PtyServiceMessage,
} from './pty-protocol'

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown; ports: MessagePortMain[] }) => void): void
  once(
    event: 'message',
    listener: (event: { data: unknown; ports: MessagePortMain[] }) => void,
  ): void
}

const PTY_FLUSH_INTERVAL = 16 // ms (~60fps) for bulk output
const PTY_INTERACTIVE_FLUSH_INTERVAL = 1 // ms, keeps typed-key echo snappy
const PTY_MAX_BUFFER_CHARS = 64 * 1024 // cap per IPC payload to avoid renderer jank
const PTY_INTERACTIVE_WINDOW_MS = 32
const PTY_INTERACTIVE_CHARS = 256
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000

type PtySession = {
  manager: PtyManager
  persistence: PersistentSession
  chunks: string[]
  bufferedChars: number
  flushTimer: ReturnType<typeof setTimeout> | null
  flushTimerDelay: number
  lastInputAt: number
}

// MessagePort/native PTY handles can be insufficient to keep an Electron
// utility process alive on every platform/build. Keep the service process
// explicitly alive until the main process kills it during app shutdown.
const keepAliveTimer = setInterval(() => {}, 60_000)
const cleanupTimer = setInterval(() => {
  void runSessionCleanup()
}, SESSION_CLEANUP_INTERVAL_MS)

let rendererReadyForPty = false
let port: MessagePortMain | null = null
const sessions = new Map<string, PtySession>()

function postToClient(message: PtyServiceMessage) {
  try {
    port?.postMessage(message)
  } catch {
    port = null
  }
}

function clearPtyFlushTimer(session: PtySession) {
  if (session.flushTimer !== null) {
    clearTimeout(session.flushTimer)
    session.flushTimer = null
    session.flushTimerDelay = 0
  }
}

function takePtyBuffer(session: PtySession): string {
  const data = session.chunks.length === 1 ? session.chunks[0] : session.chunks.join('')
  session.chunks = []
  session.bufferedChars = 0
  return data
}

function resetPtyBuffer(session: PtySession) {
  clearPtyFlushTimer(session)
  session.chunks = []
  session.bufferedChars = 0
}

function bigintToSafeNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
}

function sendPtyData(sessionId: string, data: string, seq?: bigint, replay?: boolean) {
  if (data.length === 0) return

  for (let start = 0; start < data.length; ) {
    let end = Math.min(start + PTY_MAX_BUFFER_CHARS, data.length)
    // Avoid splitting surrogate pairs when a chunk contains wide Unicode input.
    if (end < data.length) {
      const code = data.charCodeAt(end)
      if (code >= 0xdc00 && code <= 0xdfff) end--
    }

    postToClient({
      type: 'data',
      sessionId,
      data: data.slice(start, end),
      ...(seq === undefined ? {} : { seq: bigintToSafeNumber(seq) }),
      ...(replay ? { replay: true } : {}),
    })
    start = end
  }
}

function flushPtyBuffer(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  clearPtyFlushTimer(session)
  if (session.bufferedChars === 0 || !rendererReadyForPty) return

  sendPtyData(sessionId, takePtyBuffer(session), session.persistence.seq)
}

function schedulePtyFlush(sessionId: string, session: PtySession, delay: number) {
  if (!rendererReadyForPty) return
  if (session.flushTimer !== null && delay >= session.flushTimerDelay) return

  clearPtyFlushTimer(session)
  session.flushTimerDelay = delay
  session.flushTimer = setTimeout(() => flushPtyBuffer(sessionId), delay)
}

function bufferPtyData(sessionId: string, data: string) {
  const session = sessions.get(sessionId)
  if (!session || data.length === 0) return

  session.chunks.push(data)
  session.bufferedChars += data.length

  // Keep shell startup output until the renderer has registered its port listener.
  if (!rendererReadyForPty) return

  if (session.bufferedChars >= PTY_MAX_BUFFER_CHARS) {
    flushPtyBuffer(sessionId)
    return
  }

  const isInteractiveEcho =
    data.length <= PTY_INTERACTIVE_CHARS &&
    Date.now() - session.lastInputAt <= PTY_INTERACTIVE_WINDOW_MS

  schedulePtyFlush(
    sessionId,
    session,
    isInteractiveEcho ? PTY_INTERACTIVE_FLUSH_INTERVAL : PTY_FLUSH_INTERVAL,
  )
}

function spawnPty(sessionId: string, cols: number, rows: number, cwd?: string) {
  const existingSession = sessions.get(sessionId)
  if (existingSession) {
    existingSession.manager.resize(cols, rows)
    appendResize(existingSession.persistence, cols, rows)
    postToClient({
      type: 'ready',
      sessionId,
      size: existingSession.manager.getColsRows(),
      seq: bigintToSafeNumber(existingSession.persistence.seq),
    })
    flushPtyBuffer(sessionId)
    return
  }

  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  console.log(`[pty-service] Spawning PTY ${sessionId} with shell: ${shell}`)

  try {
    const persistence = openPersistentSession(sessionId)
    const manager = new PtyManager(shell, { cols, rows, cwd })
    const session: PtySession = {
      manager,
      persistence,
      chunks: [],
      bufferedChars: 0,
      flushTimer: null,
      flushTimerDelay: 0,
      lastInputAt: 0,
    }
    sessions.set(sessionId, session)
    appendResize(persistence, cols, rows)

    manager.onData((data) => {
      const seq = appendOutput(persistence, data)
      bufferPtyData(sessionId, data)
      session.persistence.seq = seq
    })
    manager.onExit(({ exitCode, signal }) => {
      flushPtyBuffer(sessionId)
      appendExit(persistence, exitCode, signal)
      console.log(`[pty-service] PTY ${sessionId} exited with code ${exitCode}, signal ${signal}`)
      sessions.delete(sessionId)
      postToClient({ type: 'exit', sessionId, info: { exitCode, signal } })
    })
    postToClient({
      type: 'ready',
      sessionId,
      size: manager.getColsRows(),
      seq: bigintToSafeNumber(persistence.seq),
    })
  } catch (err) {
    console.error(`[pty-service] Failed to spawn PTY ${sessionId}:`, err)
    postToClient({ type: 'error', sessionId, error: String(err) })
  }
}

function attachPty(sessionId: string, cols: number, rows: number, cwd?: string) {
  const existingSession = sessions.get(sessionId)
  if (existingSession) {
    spawnPty(sessionId, cols, rows, cwd)
    return
  }

  // If the utility-process PTY is gone, do not replay old shell scrollback into
  // a fake terminal. Start a fresh shell and let shells/agents use their own
  // native history/resume mechanisms.
  spawnPty(sessionId, cols, rows, cwd)
}

function detachPty(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  flushPtyBuffer(sessionId)
  resetPtyBuffer(session)
}

function killPty(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  flushPtyBuffer(sessionId)
  resetPtyBuffer(session)
  appendExit(session.persistence, 0, 15)
  session.manager.dispose()
  sessions.delete(sessionId)
}

function clearActiveSessionHistory(sessionId: string, session: PtySession) {
  flushPtyBuffer(sessionId)
  resetPtyBuffer(session)
  resetPersistentSession(session.persistence)

  const size = session.manager.getColsRows()
  const seq = appendResize(session.persistence, size.cols, size.rows)
  postToClient({ type: 'ready', sessionId, size, seq: bigintToSafeNumber(seq) })
}

function clearSessionHistory(sessionIds?: readonly string[]) {
  const targetSessionIds = sessionIds ? new Set(sessionIds) : null

  for (const [sessionId, session] of sessions) {
    if (targetSessionIds && !targetSessionIds.has(sessionId)) continue
    clearActiveSessionHistory(sessionId, session)
  }

  if (targetSessionIds) {
    for (const sessionId of targetSessionIds) {
      if (!sessions.has(sessionId)) clearSessionPersistence(sessionId)
    }
    return
  }

  clearAllSessionPersistence({ activeSessionIds: new Set(sessions.keys()) })
}

function killAllPtys() {
  while (sessions.size > 0) {
    const sessionId = sessions.keys().next().value
    if (!sessionId) return
    killPty(sessionId)
  }
}

function handleClientMessage(message: PtyClientMessage) {
  switch (message.type) {
    case 'renderer-ready':
      rendererReadyForPty = true
      for (const sessionId of sessions.keys()) {
        flushPtyBuffer(sessionId)
      }
      break
    case 'spawn':
      if (
        !Number.isInteger(message.cols) ||
        !Number.isInteger(message.rows) ||
        message.cols <= 0 ||
        message.rows <= 0
      ) {
        return
      }
      spawnPty(message.sessionId, message.cols, message.rows, message.cwd)
      break
    case 'attach':
      if (
        !Number.isInteger(message.cols) ||
        !Number.isInteger(message.rows) ||
        message.cols <= 0 ||
        message.rows <= 0
      ) {
        return
      }
      attachPty(message.sessionId, message.cols, message.rows, message.cwd)
      break
    case 'detach':
      detachPty(message.sessionId)
      break
    case 'write': {
      if (message.data.length === 0) return
      const session = sessions.get(message.sessionId)
      if (!session) return
      session.lastInputAt = Date.now()
      session.manager.write(message.data)
      break
    }
    case 'resize': {
      if (
        !Number.isInteger(message.cols) ||
        !Number.isInteger(message.rows) ||
        message.cols <= 0 ||
        message.rows <= 0
      ) {
        return
      }
      const session = sessions.get(message.sessionId)
      session?.manager.resize(message.cols, message.rows)
      if (session) appendResize(session.persistence, message.cols, message.rows)
      break
    }
    case 'kill':
      killPty(message.sessionId)
      break
    case 'clear-history':
      clearSessionHistory(message.sessionIds)
      break
  }
}

async function runSessionCleanup(): Promise<void> {
  try {
    const settings = (await readSettings()) ?? defaultSettings
    const persistence = settings.persistence ?? defaultSettings.persistence
    if (!persistence?.enabled) return

    cleanupSessionPersistence({
      retainDays: persistence.retainDays,
      maxSessionBytes: persistence.maxSessionBytes,
      activeSessionIds: new Set(sessions.keys()),
    })
  } catch (error) {
    console.warn('[pty-service] Session cleanup failed:', error)
  }
}

function decodeClientMessage(message: unknown): PtyClientMessage | null {
  const decoded = Schema.decodeUnknownOption(PtyClientMessageSchema)(message)
  return decoded._tag === 'Some' ? decoded.value : null
}

const parentPort = (process as typeof process & { parentPort?: ParentPort | null }).parentPort

if (!parentPort) {
  throw new Error('PTY service started without a parentPort')
}

parentPort.on('message', (event) => {
  const [receivedPort] = event.ports
  if (!receivedPort) {
    throw new Error('PTY service started without a MessagePort')
  }

  port?.close()
  port = receivedPort
  port.on('message', (messageEvent) => {
    const message = decodeClientMessage(messageEvent.data)
    if (!message) return
    handleClientMessage(message)
  })
  port.start()
})

process.once('exit', () => {
  clearInterval(keepAliveTimer)
  clearInterval(cleanupTimer)
  killAllPtys()
})

void runSessionCleanup()
