import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveTaoStoragePaths } from '@tao/shared/storage-path'

const paths = resolveTaoStoragePaths(homedir())
const FILE_MAGIC = Buffer.from([0x54, 0x41, 0x4f, 0x45, 0x56, 0x00, 0x01, 0x00]) // TAOEV\0\1\0
const FRAME_MAGIC = 0x54414546 // TAEF
const FRAME_HEADER_SIZE = 32
const MAX_REPLAY_BYTES = 1024 * 1024

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
  const header = Buffer.alloc(FILE_MAGIC.length + 36 + 8)
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

function readLastSeq(path: string): bigint {
  if (!existsSync(path)) return 0n
  const data = readFileSync(path)
  let offset = FILE_MAGIC.length + 36 + 8
  let lastSeq = 0n

  while (offset + FRAME_HEADER_SIZE <= data.length) {
    if (data.readUInt32BE(offset) !== FRAME_MAGIC) break
    const seq = data.readBigUInt64BE(offset + 8)
    const length = data.readUInt32BE(offset + 24)
    const nextOffset = offset + FRAME_HEADER_SIZE + length
    if (nextOffset > data.length) break
    lastSeq = seq
    offset = nextOffset
  }

  return lastSeq
}

export function openPersistentSession(sessionId: string): PersistentSession {
  ensureRoot()
  const dir = sessionDir(sessionId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const eventLogPath = join(dir, 'events.taoev')
  if (!existsSync(eventLogPath)) writeHeader(eventLogPath, sessionId)

  return {
    id: sessionId,
    seq: readLastSeq(eventLogPath),
    dir,
    eventLogPath,
    transcriptPath: join(dir, 'excerpt.txt'),
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
    appendFileSync(session.transcriptPath, payload, { mode: 0o600 })
  }

  return session.seq
}

export function appendOutput(session: PersistentSession, data: string): void {
  appendSessionFrame(session, EventFrameKind.Output, Buffer.from(data, 'utf8'))
}

export function appendResize(session: PersistentSession, cols: number, rows: number): void {
  const payload = Buffer.alloc(4)
  payload.writeUInt16BE(cols, 0)
  payload.writeUInt16BE(rows, 2)
  appendSessionFrame(session, EventFrameKind.Resize, payload)
}

export function appendExit(session: PersistentSession, exitCode: number, signal?: number): void {
  appendSessionFrame(
    session,
    EventFrameKind.Exit,
    Buffer.from(JSON.stringify({ exitCode, signal: signal ?? null }), 'utf8'),
  )
}

export function readReplayOutput(sessionId: string, maxBytes = MAX_REPLAY_BYTES): string {
  const eventLogPath = join(sessionDir(sessionId), 'events.taoev')
  if (!existsSync(eventLogPath)) return ''

  const data = readFileSync(eventLogPath)
  let offset = FILE_MAGIC.length + 36 + 8
  const chunks: Buffer[] = []
  let totalBytes = 0

  while (offset + FRAME_HEADER_SIZE <= data.length) {
    if (data.readUInt32BE(offset) !== FRAME_MAGIC) break
    const kind = data.readUInt16BE(offset + 6)
    const length = data.readUInt32BE(offset + 24)
    const expectedCrc = data.readUInt32BE(offset + 28)
    const payloadStart = offset + FRAME_HEADER_SIZE
    const payloadEnd = payloadStart + length
    if (payloadEnd > data.length) break

    const payload = data.subarray(payloadStart, payloadEnd)
    if (crc32(payload) === expectedCrc && kind === EventFrameKind.Output && payload.length > 0) {
      chunks.push(payload)
      totalBytes += payload.length
      while (totalBytes > maxBytes && chunks.length > 1) {
        totalBytes -= chunks.shift()?.length ?? 0
      }
    }

    offset = payloadEnd
  }

  const replay = Buffer.concat(chunks)
  return replay.length <= maxBytes
    ? replay.toString('utf8')
    : replay.subarray(-maxBytes).toString('utf8')
}
