import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveTaoStoragePaths } from '@tao/shared/storage-path'

const paths = resolveTaoStoragePaths(homedir())
const FILE_MAGIC = Buffer.from([0x54, 0x41, 0x4f, 0x45, 0x56, 0x00, 0x01, 0x00]) // TAOEV\0\1\0
const FRAME_MAGIC = 0x54414546 // TAEF
const FRAME_HEADER_SIZE = 32
const FILE_HEADER_SIZE = FILE_MAGIC.length + 36 + 8
const MAX_REPLAY_BYTES = 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 1024 * 1024
const MAX_FRAME_PAYLOAD_BYTES = 64 * 1024 * 1024

export const enum EventFrameKind {
  Output = 1,
  Input = 2,
  Resize = 3,
  Title = 4,
  Cwd = 5,
  AgentEvent = 6,
  SnapshotMark = 7,
  Exit = 8,
}

export type PersistentSession = {
  readonly id: string
  seq: bigint
  readonly dir: string
  readonly eventLogPath: string
  readonly transcriptPath: string
}

export type ReplayFrame = {
  readonly seq: bigint
  readonly data: string
}

export type CleanupSessionPersistenceOptions = {
  readonly retainDays: number
  readonly maxSessionBytes: number
  readonly activeSessionIds?: ReadonlySet<string>
}

type ParsedFrame = {
  readonly kind: EventFrameKind
  readonly seq: bigint
  readonly payload: Buffer
}

type ParsedEventLog = {
  readonly frames: ParsedFrame[]
  readonly validBytes: number
  readonly validHeader: boolean
}

type SessionDirInfo = {
  readonly sessionId: string
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
}

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable

  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  crcTable = table
  return table
}

function crc32(buffer: Buffer): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function ensureRoot(): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 })
  mkdirSync(paths.sessions, { recursive: true, mode: 0o700 })
}

function sessionDir(sessionId: string): string {
  return join(paths.sessions, sanitizeSessionId(sessionId))
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._:-]/gu, '_')
}

function writeHeader(path: string, sessionId: string): void {
  const header = Buffer.alloc(FILE_HEADER_SIZE)
  FILE_MAGIC.copy(header, 0)
  header.write(sessionId.slice(0, 36).padEnd(36, ' '), FILE_MAGIC.length, 36, 'utf8')
  header.writeBigUInt64BE(BigInt(Date.now()), FILE_MAGIC.length + 36)
  writeFileSync(path, header, { mode: 0o600 })
}

function encodeFrame(kind: EventFrameKind, seq: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_SIZE)
  header.writeUInt32BE(FRAME_MAGIC, 0)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(kind, 6)
  header.writeBigUInt64BE(seq, 8)
  header.writeBigUInt64BE(BigInt(Date.now()), 16)
  header.writeUInt32BE(payload.length, 24)
  header.writeUInt32BE(crc32(payload), 28)
  return Buffer.concat([header, payload])
}

function hasValidHeader(data: Buffer): boolean {
  return data.length >= FILE_HEADER_SIZE && data.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)
}

function parseEventLog(path: string): ParsedEventLog {
  if (!existsSync(path)) return { frames: [], validBytes: 0, validHeader: false }

  const data = readFileSync(path)
  if (!hasValidHeader(data)) return { frames: [], validBytes: 0, validHeader: false }

  const frames: ParsedFrame[] = []
  let offset = FILE_HEADER_SIZE
  let validBytes = FILE_HEADER_SIZE
  let lastSeq = 0n

  while (offset + FRAME_HEADER_SIZE <= data.length) {
    if (data.readUInt32BE(offset) !== FRAME_MAGIC) break

    const version = data.readUInt16BE(offset + 4)
    const kind = data.readUInt16BE(offset + 6)
    const seq = data.readBigUInt64BE(offset + 8)
    const length = data.readUInt32BE(offset + 24)
    const expectedCrc = data.readUInt32BE(offset + 28)
    const payloadStart = offset + FRAME_HEADER_SIZE
    const payloadEnd = payloadStart + length

    if (version !== 1 || length > MAX_FRAME_PAYLOAD_BYTES || payloadEnd > data.length) break

    const payload = data.subarray(payloadStart, payloadEnd)
    if (seq > lastSeq && crc32(payload) === expectedCrc) {
      frames.push({ kind: kind as EventFrameKind, seq, payload })
      lastSeq = seq
    }

    offset = payloadEnd
    validBytes = offset
  }

  return { frames, validBytes, validHeader: true }
}

function readValidFrames(path: string): ParsedFrame[] {
  return parseEventLog(path).frames
}

function repairEventLog(path: string, sessionId: string): void {
  if (!existsSync(path)) {
    writeHeader(path, sessionId)
    return
  }

  const parsed = parseEventLog(path)
  if (!parsed.validHeader) {
    writeHeader(path, sessionId)
    return
  }

  try {
    const size = statSync(path).size
    if (parsed.validBytes < size) truncateSync(path, parsed.validBytes)
  } catch {
    // Leave the original file in place if repair races with another writer.
  }
}

function readLastSeq(path: string): bigint {
  return readValidFrames(path).at(-1)?.seq ?? 0n
}

function appendBoundedTranscript(path: string, payload: Buffer): void {
  appendFileSync(path, payload, { mode: 0o600 })

  try {
    const size = statSync(path).size
    if (size <= MAX_TRANSCRIPT_BYTES) return

    const data = readFileSync(path)
    writeFileSync(path, data.subarray(-MAX_TRANSCRIPT_BYTES), { mode: 0o600 })
  } catch {
    // Transcript excerpts are best-effort and should never break PTY logging.
  }
}

export function openPersistentSession(sessionId: string): PersistentSession {
  ensureRoot()
  const dir = sessionDir(sessionId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const eventLogPath = join(dir, 'events.taoev')
  repairEventLog(eventLogPath, sessionId)

  return {
    id: sessionId,
    seq: readLastSeq(eventLogPath),
    dir,
    eventLogPath,
    transcriptPath: join(dir, 'excerpt.txt'),
  }
}

export function resetPersistentSession(session: PersistentSession): void {
  ensureRoot()
  rmSync(session.dir, { recursive: true, force: true })
  mkdirSync(session.dir, { recursive: true, mode: 0o700 })
  writeHeader(session.eventLogPath, session.id)
  session.seq = 0n
}

export function clearSessionPersistence(sessionId: string): void {
  rmSync(sessionDir(sessionId), { recursive: true, force: true })
}

export function clearAllSessionPersistence(
  options: { activeSessionIds?: ReadonlySet<string> } = {},
): void {
  ensureRoot()

  const activeSessionIds = options.activeSessionIds ?? new Set<string>()
  for (const dir of listSessionDirs()) {
    if (activeSessionIds.has(dir.sessionId)) continue
    rmSync(dir.path, { recursive: true, force: true })
  }
}

export function appendSessionFrame(
  session: PersistentSession,
  kind: EventFrameKind,
  payload: Buffer,
): bigint {
  session.seq += 1n
  appendFileSync(session.eventLogPath, encodeFrame(kind, session.seq, payload), { mode: 0o600 })
  if (kind === EventFrameKind.Output && payload.length > 0) {
    appendBoundedTranscript(session.transcriptPath, payload)
  }

  return session.seq
}

export function appendOutput(session: PersistentSession, data: string): bigint {
  return appendSessionFrame(session, EventFrameKind.Output, Buffer.from(data, 'utf8'))
}

export function appendResize(session: PersistentSession, cols: number, rows: number): bigint {
  const payload = Buffer.alloc(4)
  payload.writeUInt16BE(cols, 0)
  payload.writeUInt16BE(rows, 2)
  return appendSessionFrame(session, EventFrameKind.Resize, payload)
}

export function appendExit(session: PersistentSession, exitCode: number, signal?: number): void {
  appendSessionFrame(
    session,
    EventFrameKind.Exit,
    Buffer.from(JSON.stringify({ exitCode, signal: signal ?? null }), 'utf8'),
  )
}

export function readReplayOutput(sessionId: string, maxBytes = MAX_REPLAY_BYTES): string {
  return readReplayFrames(sessionId, maxBytes)
    .map((frame) => frame.data)
    .join('')
}

export function readReplayFrames(sessionId: string, maxBytes = MAX_REPLAY_BYTES): ReplayFrame[] {
  if (maxBytes <= 0) return []

  const eventLogPath = join(sessionDir(sessionId), 'events.taoev')
  const frames: Array<{ seq: bigint; payload: Buffer }> = []
  let totalBytes = 0

  for (const frame of readValidFrames(eventLogPath)) {
    if (frame.kind === EventFrameKind.Output && frame.payload.length > 0) {
      frames.push({ seq: frame.seq, payload: frame.payload })
      totalBytes += frame.payload.length
      while (totalBytes > maxBytes && frames.length > 1) {
        const firstLength = frames[0]?.payload.length ?? 0
        if (totalBytes - firstLength < maxBytes) break
        totalBytes -= frames.shift()?.payload.length ?? 0
      }
    }
  }

  const replay = Buffer.concat(frames.map((frame) => frame.payload))
  if (replay.length <= maxBytes) {
    return frames.map((frame) => ({ seq: frame.seq, data: frame.payload.toString('utf8') }))
  }

  return [
    {
      seq: frames.at(-1)?.seq ?? 0n,
      data: replay.subarray(-maxBytes).toString('utf8'),
    },
  ]
}

function directorySize(path: string): number {
  let total = 0

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name)
    try {
      if (entry.isDirectory()) {
        total += directorySize(entryPath)
      } else if (entry.isFile()) {
        total += statSync(entryPath).size
      }
    } catch {
      // Ignore files deleted while cleanup is scanning.
    }
  }

  return total
}

function listSessionDirs(): SessionDirInfo[] {
  if (!existsSync(paths.sessions)) return []

  const dirs: SessionDirInfo[] = []
  for (const entry of readdirSync(paths.sessions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(paths.sessions, entry.name)
    try {
      const stat = statSync(path)
      dirs.push({ sessionId: entry.name, path, mtimeMs: stat.mtimeMs, size: directorySize(path) })
    } catch {
      // Ignore inaccessible entries.
    }
  }

  return dirs
}

export function cleanupSessionPersistence(options: CleanupSessionPersistenceOptions): void {
  ensureRoot()

  const activeSessionIds = options.activeSessionIds ?? new Set<string>()
  const retainDays = Math.max(0, options.retainDays)
  const maxSessionBytes = Math.max(0, options.maxSessionBytes)
  const cutoffMs = Date.now() - retainDays * 24 * 60 * 60 * 1000
  let dirs = listSessionDirs().sort((a, b) => a.mtimeMs - b.mtimeMs)

  for (const dir of dirs) {
    if (activeSessionIds.has(dir.sessionId) || dir.mtimeMs >= cutoffMs) continue
    rmSync(dir.path, { recursive: true, force: true })
  }

  dirs = listSessionDirs().sort((a, b) => a.mtimeMs - b.mtimeMs)
  let totalBytes = dirs.reduce((sum, dir) => sum + dir.size, 0)
  for (const dir of dirs) {
    if (totalBytes <= maxSessionBytes) break
    if (activeSessionIds.has(dir.sessionId)) continue

    rmSync(dir.path, { recursive: true, force: true })
    totalBytes -= dir.size
  }
}
