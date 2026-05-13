import type { MessagePortMain } from 'electron'
import { PtyManager } from './pty'
import type { PtyClientMessage, PtyServiceMessage } from './pty-protocol'

type ParentPort = {
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

let rendererReadyForPty = false
let ptyManager: PtyManager | null = null
let port: MessagePortMain | null = null
let ptyChunks: string[] = []
let ptyBufferedChars = 0
let ptyFlushTimer: ReturnType<typeof setTimeout> | null = null
let ptyFlushTimerDelay = 0
let lastPtyInputAt = 0

function postToClient(message: PtyServiceMessage) {
  port?.postMessage(message)
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
  if (data.length === 0) return

  for (let start = 0; start < data.length; ) {
    let end = Math.min(start + PTY_MAX_BUFFER_CHARS, data.length)
    // Avoid splitting surrogate pairs when a chunk contains wide Unicode input.
    if (end < data.length) {
      const code = data.charCodeAt(end)
      if (code >= 0xdc00 && code <= 0xdfff) end--
    }

    postToClient({ type: 'data', data: data.slice(start, end) })
    start = end
  }
}

function flushPtyBuffer() {
  clearPtyFlushTimer()
  if (ptyBufferedChars === 0 || !rendererReadyForPty) return

  sendPtyData(takePtyBuffer())
}

function schedulePtyFlush(delay: number) {
  if (!rendererReadyForPty) return
  if (ptyFlushTimer !== null && delay >= ptyFlushTimerDelay) return

  clearPtyFlushTimer()
  ptyFlushTimerDelay = delay
  ptyFlushTimer = setTimeout(flushPtyBuffer, delay)
}

function bufferPtyData(data: string) {
  if (data.length === 0) return

  ptyChunks.push(data)
  ptyBufferedChars += data.length

  // Keep shell startup output until the renderer has registered its port listener.
  if (!rendererReadyForPty) return

  if (ptyBufferedChars >= PTY_MAX_BUFFER_CHARS) {
    flushPtyBuffer()
    return
  }

  const isInteractiveEcho =
    data.length <= PTY_INTERACTIVE_CHARS && Date.now() - lastPtyInputAt <= PTY_INTERACTIVE_WINDOW_MS

  schedulePtyFlush(isInteractiveEcho ? PTY_INTERACTIVE_FLUSH_INTERVAL : PTY_FLUSH_INTERVAL)
}

function setupPty() {
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  console.log(`[pty-service] Spawning PTY with shell: ${shell}`)

  try {
    ptyManager = new PtyManager(shell)
    ptyManager.onData(bufferPtyData)
    ptyManager.onExit(({ exitCode, signal }) => {
      flushPtyBuffer()
      console.log(`[pty-service] PTY exited with code ${exitCode}, signal ${signal}`)
      ptyManager = null
      postToClient({ type: 'exit', info: { exitCode, signal } })
    })
    postToClient({ type: 'ready', size: ptyManager.getColsRows() })
  } catch (err) {
    console.error('[pty-service] Failed to spawn PTY:', err)
    postToClient({ type: 'error', error: String(err) })
  }
}

function disposePty() {
  flushPtyBuffer()
  resetPtyBuffer()
  ptyManager?.dispose()
  ptyManager = null
}

function handleClientMessage(message: PtyClientMessage) {
  switch (message.type) {
    case 'renderer-ready':
      rendererReadyForPty = true
      flushPtyBuffer()
      break
    case 'write':
      if (typeof message.data !== 'string' || message.data.length === 0) return
      lastPtyInputAt = Date.now()
      ptyManager?.write(message.data)
      break
    case 'resize':
      if (
        !Number.isInteger(message.cols) ||
        !Number.isInteger(message.rows) ||
        message.cols <= 0 ||
        message.rows <= 0
      ) {
        return
      }
      ptyManager?.resize(message.cols, message.rows)
      break
    case 'dispose':
      disposePty()
      break
  }
}

function isClientMessage(message: unknown): message is PtyClientMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    typeof (message as { type: unknown }).type === 'string'
  )
}

const parentPort = (process as typeof process & { parentPort?: ParentPort | null }).parentPort

if (!parentPort) {
  throw new Error('PTY service started without a parentPort')
}

parentPort.once('message', (event) => {
  const [receivedPort] = event.ports
  if (!receivedPort) {
    throw new Error('PTY service started without a MessagePort')
  }

  port = receivedPort
  port.on('message', (messageEvent) => {
    if (!isClientMessage(messageEvent.data)) return
    handleClientMessage(messageEvent.data)
  })
  port.start()

  setupPty()
})

process.once('exit', disposePty)
