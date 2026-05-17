import {
  TAOD_STREAM_HEADER_SIZE,
  TAOD_STREAM_MAGIC,
  TAOD_STREAM_MAX_PAYLOAD_BYTES,
  TAOD_STREAM_SESSION_ID_SIZE,
  TAOD_STREAM_VERSION,
  TaodStreamFrameKind,
  type TaodStreamFrameKind as TaodStreamFrameKindValue,
} from '@tao/shared/taod-protocol'

const SESSION_ID_OFFSET = 8
const SEQ_OFFSET = SESSION_ID_OFFSET + TAOD_STREAM_SESSION_ID_SIZE
const LENGTH_OFFSET = SEQ_OFFSET + 8
const CRC_OFFSET = LENGTH_OFFSET + 4
const FRAME_MAGIC_BYTES = Buffer.from([0x54, 0x41, 0x53, 0x46])

export const TAOD_STREAM_PAYLOAD_LENGTH_OFFSET = LENGTH_OFFSET

export type TaodParsedStreamFrame = {
  readonly kind: TaodStreamFrameKindValue
  readonly sessionId: string
  readonly seq: number
  readonly payload: Buffer
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

export function taodCrc32(buffer: Buffer | Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function encodeTaodStreamFrame(input: {
  readonly kind: TaodStreamFrameKindValue
  readonly sessionId: string
  readonly seq: bigint | number
  readonly payload?: Buffer | Uint8Array | string
}): Buffer {
  if (
    input.sessionId.length === 0 ||
    Buffer.byteLength(input.sessionId) > TAOD_STREAM_SESSION_ID_SIZE
  ) {
    throw new Error('Invalid taod stream session id')
  }

  const payload =
    typeof input.payload === 'string'
      ? Buffer.from(input.payload, 'utf8')
      : Buffer.from(input.payload ?? [])
  if (payload.length > TAOD_STREAM_MAX_PAYLOAD_BYTES) {
    throw new Error('Taod stream payload too large')
  }

  const frame = Buffer.alloc(TAOD_STREAM_HEADER_SIZE + payload.length)
  frame.writeUInt32BE(TAOD_STREAM_MAGIC, 0)
  frame.writeUInt16BE(TAOD_STREAM_VERSION, 4)
  frame.writeUInt16BE(input.kind, 6)
  frame.write(input.sessionId, SESSION_ID_OFFSET, TAOD_STREAM_SESSION_ID_SIZE, 'utf8')
  frame.writeBigUInt64BE(BigInt(input.seq), SEQ_OFFSET)
  frame.writeUInt32BE(payload.length, LENGTH_OFFSET)
  frame.writeUInt32BE(taodCrc32(payload), CRC_OFFSET)
  payload.copy(frame, TAOD_STREAM_HEADER_SIZE)
  return frame
}

export function encodeTaodResizePayload(cols: number, rows: number): Buffer {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new Error('Invalid taod resize dimensions')
  }

  const payload = Buffer.alloc(4)
  payload.writeUInt16BE(cols, 0)
  payload.writeUInt16BE(rows, 2)
  return payload
}

export function decodeTaodResizePayload(payload: Buffer): { cols: number; rows: number } | null {
  if (payload.length !== 4) return null
  const cols = payload.readUInt16BE(0)
  const rows = payload.readUInt16BE(2)
  if (cols <= 0 || rows <= 0) return null
  return { cols, rows }
}

export function decodeTaodExitPayload(
  payload: Buffer,
): { exitCode: number; signal?: number } | null {
  if (payload.length !== 8) return null
  const exitCode = payload.readInt32BE(0)
  const signal = payload.readInt32BE(4)
  return { exitCode, ...(signal === 0 ? {} : { signal }) }
}

function isKnownKind(kind: number): kind is TaodStreamFrameKindValue {
  return (
    kind === TaodStreamFrameKind.Output ||
    kind === TaodStreamFrameKind.Input ||
    kind === TaodStreamFrameKind.Resize ||
    kind === TaodStreamFrameKind.Snapshot ||
    kind === TaodStreamFrameKind.Exit ||
    kind === TaodStreamFrameKind.Agent
  )
}

function safeSeqToNumber(seq: bigint): number {
  return seq > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(seq)
}

function trimSessionId(field: Buffer): string {
  const nul = field.indexOf(0)
  const end = nul === -1 ? field.length : nul
  return field.subarray(0, end).toString('utf8')
}

export class TaodStreamFrameParser {
  private pending = Buffer.alloc(0)

  push(chunk: Buffer | Uint8Array): TaodParsedStreamFrame[] {
    if (chunk.length === 0) return []
    this.pending =
      this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk])

    const frames: TaodParsedStreamFrame[] = []
    let offset = 0

    while (offset + TAOD_STREAM_HEADER_SIZE <= this.pending.length) {
      const magic = this.pending.readUInt32BE(offset)
      if (magic !== TAOD_STREAM_MAGIC) {
        const nextMagic = this.pending.indexOf(FRAME_MAGIC_BYTES, offset + 1)
        if (nextMagic === -1) {
          this.pending = Buffer.alloc(0)
          throw new Error('Invalid taod stream frame magic')
        }
        offset = nextMagic
        continue
      }

      const version = this.pending.readUInt16BE(offset + 4)
      const kind = this.pending.readUInt16BE(offset + 6)
      const sessionField = this.pending.subarray(
        offset + SESSION_ID_OFFSET,
        offset + SESSION_ID_OFFSET + TAOD_STREAM_SESSION_ID_SIZE,
      )
      const sessionId = trimSessionId(sessionField)
      const seq = this.pending.readBigUInt64BE(offset + SEQ_OFFSET)
      const length = this.pending.readUInt32BE(offset + LENGTH_OFFSET)
      const expectedCrc = this.pending.readUInt32BE(offset + CRC_OFFSET)
      const payloadStart = offset + TAOD_STREAM_HEADER_SIZE
      const payloadEnd = payloadStart + length

      if (
        version !== TAOD_STREAM_VERSION ||
        !isKnownKind(kind) ||
        sessionId.length === 0 ||
        length > TAOD_STREAM_MAX_PAYLOAD_BYTES
      ) {
        this.pending = Buffer.alloc(0)
        throw new Error('Invalid taod stream frame header')
      }

      if (payloadEnd > this.pending.length) break

      const payload = this.pending.subarray(payloadStart, payloadEnd)
      if (taodCrc32(payload) !== expectedCrc) {
        this.pending = Buffer.alloc(0)
        throw new Error('Invalid taod stream frame CRC')
      }

      frames.push({
        kind,
        sessionId,
        seq: safeSeqToNumber(seq),
        payload: Buffer.from(payload),
      })
      offset = payloadEnd
    }

    if (offset > 0) this.pending = this.pending.subarray(offset)
    return frames
  }

  reset(): void {
    this.pending = Buffer.alloc(0)
  }
}
