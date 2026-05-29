import {
  TAUD_STREAM_HEADER_SIZE,
  TAUD_STREAM_MAGIC,
  TAUD_STREAM_MAX_PAYLOAD_BYTES,
  TAUD_STREAM_SESSION_ID_SIZE,
  TAUD_STREAM_VERSION,
  TaudStreamFrameKind,
  type TaudStreamFrameKind as TaudStreamFrameKindValue,
} from '@tau/shared/taud-protocol'

const SESSION_ID_OFFSET = 8
const SEQ_OFFSET = SESSION_ID_OFFSET + TAUD_STREAM_SESSION_ID_SIZE
const LENGTH_OFFSET = SEQ_OFFSET + 8
const CRC_OFFSET = LENGTH_OFFSET + 4
const FRAME_MAGIC_BYTES = Buffer.from([0x54, 0x41, 0x53, 0x46])

export const TAUD_STREAM_PAYLOAD_LENGTH_OFFSET = LENGTH_OFFSET

export type TaudParsedStreamFrame = {
  readonly kind: TaudStreamFrameKindValue
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

export function taudCrc32(buffer: Buffer | Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function encodeTaudStreamFrame(input: {
  readonly kind: TaudStreamFrameKindValue
  readonly sessionId: string
  readonly seq: bigint | number
  readonly payload?: Buffer | Uint8Array | string
}): Buffer {
  if (
    input.sessionId.length === 0 ||
    Buffer.byteLength(input.sessionId) > TAUD_STREAM_SESSION_ID_SIZE
  ) {
    throw new Error('Invalid taud stream session id')
  }

  const payload =
    typeof input.payload === 'string'
      ? Buffer.from(input.payload, 'utf8')
      : Buffer.from(input.payload ?? [])
  if (payload.length > TAUD_STREAM_MAX_PAYLOAD_BYTES) {
    throw new Error('Taud stream payload too large')
  }

  const frame = Buffer.alloc(TAUD_STREAM_HEADER_SIZE + payload.length)
  frame.writeUInt32BE(TAUD_STREAM_MAGIC, 0)
  frame.writeUInt16BE(TAUD_STREAM_VERSION, 4)
  frame.writeUInt16BE(input.kind, 6)
  frame.write(input.sessionId, SESSION_ID_OFFSET, TAUD_STREAM_SESSION_ID_SIZE, 'utf8')
  frame.writeBigUInt64BE(BigInt(input.seq), SEQ_OFFSET)
  frame.writeUInt32BE(payload.length, LENGTH_OFFSET)
  frame.writeUInt32BE(taudCrc32(payload), CRC_OFFSET)
  payload.copy(frame, TAUD_STREAM_HEADER_SIZE)
  return frame
}

export function encodeTaudResizePayload(cols: number, rows: number): Buffer {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new Error('Invalid taud resize dimensions')
  }

  const payload = Buffer.alloc(4)
  payload.writeUInt16BE(cols, 0)
  payload.writeUInt16BE(rows, 2)
  return payload
}

export function decodeTaudResizePayload(payload: Buffer): { cols: number; rows: number } | null {
  if (payload.length !== 4) return null
  const cols = payload.readUInt16BE(0)
  const rows = payload.readUInt16BE(2)
  if (cols <= 0 || rows <= 0) return null
  return { cols, rows }
}

export function decodeTaudExitPayload(
  payload: Buffer,
): { exitCode: number; signal?: number } | null {
  if (payload.length !== 8) return null
  const exitCode = payload.readInt32BE(0)
  const signal = payload.readInt32BE(4)
  return { exitCode, ...(signal === 0 ? {} : { signal }) }
}

function isKnownKind(kind: number): kind is TaudStreamFrameKindValue {
  return (
    kind === TaudStreamFrameKind.Output ||
    kind === TaudStreamFrameKind.Input ||
    kind === TaudStreamFrameKind.Resize ||
    kind === TaudStreamFrameKind.Snapshot ||
    kind === TaudStreamFrameKind.Exit ||
    kind === TaudStreamFrameKind.Agent
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

function trailingMagicPrefixLength(buffer: Buffer): number {
  const maxLength = Math.min(FRAME_MAGIC_BYTES.length - 1, buffer.length)
  for (let length = maxLength; length > 0; length -= 1) {
    if (buffer.subarray(buffer.length - length).equals(FRAME_MAGIC_BYTES.subarray(0, length))) {
      return length
    }
  }
  return 0
}

export class TaudStreamFrameParser {
  private pending = Buffer.alloc(0)

  push(chunk: Buffer | Uint8Array): TaudParsedStreamFrame[] {
    if (chunk.length === 0) return []
    this.pending =
      this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk])

    const frames: TaudParsedStreamFrame[] = []
    let offset = 0

    while (offset + TAUD_STREAM_HEADER_SIZE <= this.pending.length) {
      const magic = this.pending.readUInt32BE(offset)
      if (magic !== TAUD_STREAM_MAGIC) {
        const nextMagic = this.pending.indexOf(FRAME_MAGIC_BYTES, offset + 1)
        if (nextMagic === -1) {
          const prefixLength = trailingMagicPrefixLength(this.pending)
          if (prefixLength > 0) {
            this.pending = this.pending.subarray(this.pending.length - prefixLength)
            return frames
          }
          this.pending = Buffer.alloc(0)
          throw new Error('Invalid taud stream frame magic')
        }
        offset = nextMagic
        continue
      }

      const version = this.pending.readUInt16BE(offset + 4)
      const kind = this.pending.readUInt16BE(offset + 6)
      const sessionField = this.pending.subarray(
        offset + SESSION_ID_OFFSET,
        offset + SESSION_ID_OFFSET + TAUD_STREAM_SESSION_ID_SIZE,
      )
      const sessionId = trimSessionId(sessionField)
      const seq = this.pending.readBigUInt64BE(offset + SEQ_OFFSET)
      const length = this.pending.readUInt32BE(offset + LENGTH_OFFSET)
      const expectedCrc = this.pending.readUInt32BE(offset + CRC_OFFSET)
      const payloadStart = offset + TAUD_STREAM_HEADER_SIZE
      const payloadEnd = payloadStart + length

      if (
        version !== TAUD_STREAM_VERSION ||
        !isKnownKind(kind) ||
        sessionId.length === 0 ||
        length > TAUD_STREAM_MAX_PAYLOAD_BYTES
      ) {
        this.pending = Buffer.alloc(0)
        throw new Error('Invalid taud stream frame header')
      }

      if (payloadEnd > this.pending.length) break

      const payload = this.pending.subarray(payloadStart, payloadEnd)
      if (taudCrc32(payload) !== expectedCrc) {
        this.pending = Buffer.alloc(0)
        throw new Error('Invalid taud stream frame CRC')
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
