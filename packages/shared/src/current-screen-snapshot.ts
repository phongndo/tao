export const CURRENT_SCREEN_SNAPSHOT_MAGIC = Uint8Array.from([
  0x54, 0x41, 0x4f, 0x53, 0x4e, 0x50, 0x01, 0x00,
]) // TAUSNP\1\0
export const CURRENT_SCREEN_SNAPSHOT_VERSION = 1
export const CURRENT_SCREEN_SNAPSHOT_HEADER_SIZE = 34
export const CURRENT_SCREEN_SNAPSHOT_MAX_BACKEND_NAME_BYTES = 128
export const CURRENT_SCREEN_SNAPSHOT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024

export const FALLBACK_CURRENT_SCREEN_MAGIC = Uint8Array.from([
  0x54, 0x41, 0x4f, 0x56, 0x46, 0x42, 0x01, 0x00,
]) // TAUVFB\1\0
export const FALLBACK_CURRENT_SCREEN_VERSION = 1
export const FALLBACK_CURRENT_SCREEN_HEADER_SIZE = 30
export const FALLBACK_CURRENT_SCREEN_MAX_BYTES = 16 * 1024 * 1024

export const GHOSTTY_NATIVE_CURRENT_SCREEN_MAGIC = Uint8Array.from([
  0x54, 0x41, 0x4f, 0x47, 0x56, 0x54, 0x01, 0x00,
]) // TAUGVT\1\0
export const GHOSTTY_NATIVE_CURRENT_SCREEN_VERSION = 1
export const GHOSTTY_NATIVE_CURRENT_SCREEN_HEADER_SIZE = 26
export const GHOSTTY_NATIVE_CURRENT_SCREEN_MAX_BYTES = 16 * 1024 * 1024

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

let crcTable: Uint32Array | null = null

export type CurrentScreenSnapshot = {
  readonly seq: number
  readonly cols: number
  readonly rows: number
  readonly backendName: string
  readonly payload: Uint8Array
  readonly payloadCrc32: number
}

export type FallbackCurrentScreenSnapshot = {
  readonly cols: number
  readonly rows: number
  readonly cursorX: number
  readonly cursorY: number
  readonly maxScrollback: number
  readonly screen: Uint8Array
  readonly screenCrc32: number
}

export type GhosttyNativeCurrentScreenSnapshot = {
  readonly cols: number
  readonly rows: number
  readonly maxScrollback: number
  readonly vt: Uint8Array
  readonly vtCrc32: number
}

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

export function currentScreenCrc32(bytes: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function bytesEqual(lhs: Uint8Array, rhs: Uint8Array): boolean {
  if (lhs.byteLength !== rhs.byteLength) return false
  for (let index = 0; index < lhs.byteLength; index++) {
    if (lhs[index] !== rhs[index]) return false
  }
  return true
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes)
}

function safeSeqToNumber(seq: bigint): number {
  return seq > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(seq)
}

function writeBigUInt64BE(view: DataView, offset: number, value: number | bigint): void {
  view.setBigUint64(offset, BigInt(value), false)
}

export function encodeCurrentScreenSnapshot(input: {
  readonly seq: number | bigint
  readonly cols: number
  readonly rows: number
  readonly backendName: string
  readonly payload: Uint8Array
}): Uint8Array {
  const backendName = textEncoder.encode(input.backendName)
  if (input.cols <= 0 || input.rows <= 0) throw new Error('Invalid current-screen size')
  if (
    backendName.byteLength === 0 ||
    backendName.byteLength > CURRENT_SCREEN_SNAPSHOT_MAX_BACKEND_NAME_BYTES
  ) {
    throw new Error('Invalid current-screen backend name')
  }
  if (input.payload.byteLength > CURRENT_SCREEN_SNAPSHOT_MAX_PAYLOAD_BYTES) {
    throw new Error('Current-screen snapshot payload too large')
  }

  const encoded = new Uint8Array(
    CURRENT_SCREEN_SNAPSHOT_HEADER_SIZE + backendName.byteLength + input.payload.byteLength,
  )
  const view = readView(encoded)
  encoded.set(CURRENT_SCREEN_SNAPSHOT_MAGIC, 0)
  view.setUint16(8, CURRENT_SCREEN_SNAPSHOT_VERSION, false)
  view.setUint16(10, input.cols, false)
  view.setUint16(12, input.rows, false)
  view.setUint16(14, backendName.byteLength, false)
  view.setUint16(16, 0, false)
  writeBigUInt64BE(view, 18, input.seq)
  view.setUint32(26, input.payload.byteLength, false)
  view.setUint32(30, currentScreenCrc32(input.payload), false)
  encoded.set(backendName, CURRENT_SCREEN_SNAPSHOT_HEADER_SIZE)
  encoded.set(input.payload, CURRENT_SCREEN_SNAPSHOT_HEADER_SIZE + backendName.byteLength)
  return encoded
}

export function decodeCurrentScreenSnapshot(bytes: Uint8Array): CurrentScreenSnapshot {
  if (bytes.byteLength < CURRENT_SCREEN_SNAPSHOT_HEADER_SIZE) {
    throw new Error('Invalid current-screen snapshot')
  }
  if (
    !bytesEqual(
      bytes.subarray(0, CURRENT_SCREEN_SNAPSHOT_MAGIC.byteLength),
      CURRENT_SCREEN_SNAPSHOT_MAGIC,
    )
  ) {
    throw new Error('Invalid current-screen snapshot magic')
  }

  const view = readView(bytes)
  const version = view.getUint16(8, false)
  if (version !== CURRENT_SCREEN_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported current-screen snapshot version: ${version}`)
  }

  const cols = view.getUint16(10, false)
  const rows = view.getUint16(12, false)
  const backendNameLength = view.getUint16(14, false)
  const seq = safeSeqToNumber(view.getBigUint64(18, false))
  const payloadLength = view.getUint32(26, false)
  const payloadCrc32 = view.getUint32(30, false)

  if (cols <= 0 || rows <= 0) throw new Error('Invalid current-screen snapshot size')
  if (
    backendNameLength <= 0 ||
    backendNameLength > CURRENT_SCREEN_SNAPSHOT_MAX_BACKEND_NAME_BYTES
  ) {
    throw new Error('Invalid current-screen snapshot backend name')
  }
  if (payloadLength > CURRENT_SCREEN_SNAPSHOT_MAX_PAYLOAD_BYTES) {
    throw new Error('Current-screen snapshot payload too large')
  }
  if (
    bytes.byteLength !==
    CURRENT_SCREEN_SNAPSHOT_HEADER_SIZE + backendNameLength + payloadLength
  ) {
    throw new Error('Invalid current-screen snapshot length')
  }

  const backendNameStart = CURRENT_SCREEN_SNAPSHOT_HEADER_SIZE
  const payloadStart = backendNameStart + backendNameLength
  const payload = bytes.subarray(payloadStart, payloadStart + payloadLength)
  if (currentScreenCrc32(payload) !== payloadCrc32) {
    throw new Error('Invalid current-screen snapshot CRC')
  }

  return {
    seq,
    cols,
    rows,
    backendName: textDecoder.decode(bytes.subarray(backendNameStart, payloadStart)),
    payload: copyBytes(payload),
    payloadCrc32,
  }
}

export function encodeFallbackCurrentScreenSnapshot(input: {
  readonly cols: number
  readonly rows: number
  readonly cursorX?: number
  readonly cursorY?: number
  readonly maxScrollback?: number
  readonly screen: Uint8Array
}): Uint8Array {
  const cursorX = input.cursorX ?? 0
  const cursorY = input.cursorY ?? 0
  if (input.cols <= 0 || input.rows <= 0) throw new Error('Invalid fallback snapshot size')
  if (cursorX < 0 || cursorX >= input.cols || cursorY < 0 || cursorY >= input.rows) {
    throw new Error('Invalid fallback snapshot cursor')
  }
  if (input.screen.byteLength !== input.cols * input.rows) {
    throw new Error('Invalid fallback snapshot screen length')
  }
  if (input.screen.byteLength > FALLBACK_CURRENT_SCREEN_MAX_BYTES) {
    throw new Error('Fallback snapshot screen too large')
  }

  const encoded = new Uint8Array(FALLBACK_CURRENT_SCREEN_HEADER_SIZE + input.screen.byteLength)
  const view = readView(encoded)
  encoded.set(FALLBACK_CURRENT_SCREEN_MAGIC, 0)
  view.setUint16(8, FALLBACK_CURRENT_SCREEN_VERSION, false)
  view.setUint16(10, input.cols, false)
  view.setUint16(12, input.rows, false)
  view.setUint16(14, cursorX, false)
  view.setUint16(16, cursorY, false)
  view.setUint32(18, input.maxScrollback ?? 0, false)
  view.setUint32(22, input.screen.byteLength, false)
  view.setUint32(26, currentScreenCrc32(input.screen), false)
  encoded.set(input.screen, FALLBACK_CURRENT_SCREEN_HEADER_SIZE)
  return encoded
}

export function decodeFallbackCurrentScreenSnapshotPayload(
  payload: Uint8Array,
): FallbackCurrentScreenSnapshot {
  if (payload.byteLength < FALLBACK_CURRENT_SCREEN_HEADER_SIZE) {
    throw new Error('Invalid fallback current-screen snapshot')
  }
  if (
    !bytesEqual(
      payload.subarray(0, FALLBACK_CURRENT_SCREEN_MAGIC.byteLength),
      FALLBACK_CURRENT_SCREEN_MAGIC,
    )
  ) {
    throw new Error('Invalid fallback current-screen snapshot magic')
  }

  const view = readView(payload)
  const version = view.getUint16(8, false)
  if (version !== FALLBACK_CURRENT_SCREEN_VERSION) {
    throw new Error(`Unsupported fallback current-screen snapshot version: ${version}`)
  }

  const cols = view.getUint16(10, false)
  const rows = view.getUint16(12, false)
  const cursorX = view.getUint16(14, false)
  const cursorY = view.getUint16(16, false)
  const maxScrollback = view.getUint32(18, false)
  const screenLength = view.getUint32(22, false)
  const screenCrc32 = view.getUint32(26, false)
  const expectedScreenLength = cols * rows

  if (cols <= 0 || rows <= 0) throw new Error('Invalid fallback current-screen snapshot size')
  if (cursorX >= cols || cursorY >= rows) {
    throw new Error('Invalid fallback current-screen snapshot cursor')
  }
  if (screenLength > FALLBACK_CURRENT_SCREEN_MAX_BYTES) {
    throw new Error('Fallback current-screen snapshot too large')
  }
  if (screenLength !== expectedScreenLength) {
    throw new Error('Invalid fallback current-screen snapshot screen length')
  }
  if (payload.byteLength !== FALLBACK_CURRENT_SCREEN_HEADER_SIZE + screenLength) {
    throw new Error('Invalid fallback current-screen snapshot length')
  }

  const screen = payload.subarray(FALLBACK_CURRENT_SCREEN_HEADER_SIZE)
  if (currentScreenCrc32(screen) !== screenCrc32) {
    throw new Error('Invalid fallback current-screen snapshot CRC')
  }

  return {
    cols,
    rows,
    cursorX,
    cursorY,
    maxScrollback,
    screen: copyBytes(screen),
    screenCrc32,
  }
}

export function encodeGhosttyNativeCurrentScreenSnapshot(input: {
  readonly cols: number
  readonly rows: number
  readonly maxScrollback?: number
  readonly vt: Uint8Array
}): Uint8Array {
  if (input.cols <= 0 || input.rows <= 0) throw new Error('Invalid ghostty native snapshot size')
  if (input.vt.byteLength > GHOSTTY_NATIVE_CURRENT_SCREEN_MAX_BYTES) {
    throw new Error('Ghostty native snapshot too large')
  }

  const encoded = new Uint8Array(GHOSTTY_NATIVE_CURRENT_SCREEN_HEADER_SIZE + input.vt.byteLength)
  const view = readView(encoded)
  encoded.set(GHOSTTY_NATIVE_CURRENT_SCREEN_MAGIC, 0)
  view.setUint16(8, GHOSTTY_NATIVE_CURRENT_SCREEN_VERSION, false)
  view.setUint16(10, input.cols, false)
  view.setUint16(12, input.rows, false)
  view.setUint32(14, input.maxScrollback ?? 0, false)
  view.setUint32(18, input.vt.byteLength, false)
  view.setUint32(22, currentScreenCrc32(input.vt), false)
  encoded.set(input.vt, GHOSTTY_NATIVE_CURRENT_SCREEN_HEADER_SIZE)
  return encoded
}

export function decodeGhosttyNativeCurrentScreenSnapshotPayload(
  payload: Uint8Array,
): GhosttyNativeCurrentScreenSnapshot {
  if (payload.byteLength < GHOSTTY_NATIVE_CURRENT_SCREEN_HEADER_SIZE) {
    throw new Error('Invalid ghostty native current-screen snapshot')
  }
  if (
    !bytesEqual(
      payload.subarray(0, GHOSTTY_NATIVE_CURRENT_SCREEN_MAGIC.byteLength),
      GHOSTTY_NATIVE_CURRENT_SCREEN_MAGIC,
    )
  ) {
    throw new Error('Invalid ghostty native current-screen snapshot magic')
  }

  const view = readView(payload)
  const version = view.getUint16(8, false)
  if (version !== GHOSTTY_NATIVE_CURRENT_SCREEN_VERSION) {
    throw new Error(`Unsupported ghostty native current-screen snapshot version: ${version}`)
  }

  const cols = view.getUint16(10, false)
  const rows = view.getUint16(12, false)
  const maxScrollback = view.getUint32(14, false)
  const vtLength = view.getUint32(18, false)
  const vtCrc32 = view.getUint32(22, false)

  if (cols <= 0 || rows <= 0) throw new Error('Invalid ghostty native current-screen size')
  if (vtLength > GHOSTTY_NATIVE_CURRENT_SCREEN_MAX_BYTES) {
    throw new Error('Ghostty native current-screen snapshot too large')
  }
  if (payload.byteLength !== GHOSTTY_NATIVE_CURRENT_SCREEN_HEADER_SIZE + vtLength) {
    throw new Error('Invalid ghostty native current-screen snapshot length')
  }

  const vt = payload.subarray(GHOSTTY_NATIVE_CURRENT_SCREEN_HEADER_SIZE)
  if (currentScreenCrc32(vt) !== vtCrc32) {
    throw new Error('Invalid ghostty native current-screen snapshot CRC')
  }

  return {
    cols,
    rows,
    maxScrollback,
    vt: copyBytes(vt),
    vtCrc32,
  }
}

export function isFallbackCurrentScreenSnapshot(snapshot: CurrentScreenSnapshot): boolean {
  return snapshot.backendName === 'fallback'
}

export function isGhosttyNativeCurrentScreenSnapshot(snapshot: CurrentScreenSnapshot): boolean {
  return snapshot.backendName === 'ghostty_native'
}

function visibleCell(byte: number): string {
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte)
  return ' '
}

function rowEnd(screen: Uint8Array, start: number, cols: number): number {
  let end = cols
  while (end > 0 && screen[start + end - 1] === 0x20) end -= 1
  return end
}

export function fallbackCurrentScreenSnapshotToAnsi(
  snapshot: FallbackCurrentScreenSnapshot,
): string {
  let output = '\x1b[2J'

  for (let row = 0; row < snapshot.rows; row++) {
    const start = row * snapshot.cols
    const end = rowEnd(snapshot.screen, start, snapshot.cols)
    if (end === 0) continue

    output += `\x1b[${row + 1};1H`
    for (let col = 0; col < end; col++) {
      output += visibleCell(snapshot.screen[start + col] ?? 0x20)
    }
  }

  output += `\x1b[${snapshot.cursorY + 1};${snapshot.cursorX + 1}H`
  return output
}

export function ghosttyNativeCurrentScreenSnapshotToAnsi(
  snapshot: GhosttyNativeCurrentScreenSnapshot,
): string {
  return textDecoder.decode(snapshot.vt)
}

export function fallbackScreenFromText(
  cols: number,
  rows: number,
  lines: readonly string[],
): Uint8Array {
  const screen = new Uint8Array(cols * rows)
  screen.fill(0x20)
  for (let row = 0; row < rows; row++) {
    const encoded = textEncoder.encode(lines[row] ?? '')
    screen.set(encoded.subarray(0, cols), row * cols)
  }
  return screen
}
