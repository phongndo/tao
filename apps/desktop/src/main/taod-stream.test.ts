import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  currentScreenCrc32,
  decodeCurrentScreenSnapshot,
  decodeFallbackCurrentScreenSnapshotPayload,
  decodeGhosttyNativeCurrentScreenSnapshotPayload,
  encodeCurrentScreenSnapshot,
  encodeFallbackCurrentScreenSnapshot,
  encodeGhosttyNativeCurrentScreenSnapshot,
  fallbackCurrentScreenSnapshotToAnsi,
  fallbackScreenFromText,
  ghosttyNativeCurrentScreenSnapshotToAnsi,
  isFallbackCurrentScreenSnapshot,
  isGhosttyNativeCurrentScreenSnapshot,
} from '@tao/shared/current-screen-snapshot'
import {
  TAOD_CONTROL_CAPABILITIES,
  TAOD_CONTROL_PROTOCOL_VERSION,
  TAOD_STREAM_HEADER_SIZE,
  TAOD_STREAM_MAGIC,
  TAOD_STREAM_MAX_PAYLOAD_BYTES,
  TAOD_STREAM_SESSION_ID_SIZE,
  TAOD_STREAM_VERSION,
  TaodStreamFrameKind,
} from '@tao/shared/taod-protocol'
import {
  TAOD_STREAM_PAYLOAD_LENGTH_OFFSET,
  decodeTaodExitPayload,
  decodeTaodResizePayload,
  encodeTaodResizePayload,
  encodeTaodStreamFrame,
  TaodStreamFrameParser,
} from './taod-stream'

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'packages/shared/fixtures/taod-protocol',
)

function readFixture(name: string): string {
  return readFileSync(resolve(fixtureRoot, name), 'utf8').trim()
}

function readHexFixture(name: string): Buffer {
  return Buffer.from(readFixture(name), 'hex')
}

type ProtocolSpec = {
  readonly control: {
    readonly protocolVersion: number
    readonly daemonVersion: string
    readonly capabilities: readonly string[]
    readonly requestFixtures: readonly string[]
    readonly responseFixtures: readonly string[]
  }
  readonly stream: {
    readonly magic: number
    readonly version: number
    readonly sessionIdSize: number
    readonly headerSize: number
    readonly maxPayloadBytes: number
    readonly frameKinds: readonly { readonly name: string; readonly value: number }[]
    readonly fixtures: readonly string[]
    readonly corruptFixtures: readonly string[]
  }
}

function readProtocolSpec(): ProtocolSpec {
  return JSON.parse(readFixture('spec.json')) as ProtocolSpec
}

test('taod protocol spec matches TS constants and fixture files', () => {
  const spec = readProtocolSpec()
  assert.equal(spec.control.protocolVersion, TAOD_CONTROL_PROTOCOL_VERSION)
  assert.deepEqual(spec.control.capabilities, [...TAOD_CONTROL_CAPABILITIES])
  assert.equal(spec.stream.magic, TAOD_STREAM_MAGIC)
  assert.equal(spec.stream.version, TAOD_STREAM_VERSION)
  assert.equal(spec.stream.sessionIdSize, TAOD_STREAM_SESSION_ID_SIZE)
  assert.equal(spec.stream.headerSize, TAOD_STREAM_HEADER_SIZE)
  assert.equal(spec.stream.maxPayloadBytes, TAOD_STREAM_MAX_PAYLOAD_BYTES)
  assert.deepEqual(spec.stream.frameKinds, [
    { name: 'output', value: TaodStreamFrameKind.Output },
    { name: 'input', value: TaodStreamFrameKind.Input },
    { name: 'resize', value: TaodStreamFrameKind.Resize },
    { name: 'snapshot', value: TaodStreamFrameKind.Snapshot },
    { name: 'exit', value: TaodStreamFrameKind.Exit },
    { name: 'agent', value: TaodStreamFrameKind.Agent },
  ])

  for (const fixture of [
    ...spec.control.requestFixtures,
    ...spec.control.responseFixtures,
    ...spec.stream.fixtures,
    ...spec.stream.corruptFixtures,
  ]) {
    assert.ok(readFixture(fixture).length > 0, `missing or empty fixture ${fixture}`)
  }
})

test('taod stream encoder matches the shared golden output fixture', () => {
  const encoded = encodeTaodStreamFrame({
    kind: TaodStreamFrameKind.Output,
    sessionId: 'session-1',
    seq: 7,
    payload: Buffer.from('hello'),
  })

  assert.equal(encoded.toString('hex'), readFixture('stream-output-frame.hex'))

  const frames = new TaodStreamFrameParser().push(encoded)
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.kind, TaodStreamFrameKind.Output)
  assert.equal(frames[0]?.sessionId, 'session-1')
  assert.equal(frames[0]?.seq, 7)
  assert.equal(frames[0]?.payload.toString('utf8'), 'hello')
})

test('taod stream codec matches shared golden resize, exit, and snapshot fixtures', () => {
  const resize = readHexFixture('stream-resize-frame.hex')
  const exit = readHexFixture('stream-exit-frame.hex')
  const snapshot = readHexFixture('stream-snapshot-frame.hex')

  assert.equal(
    encodeTaodStreamFrame({
      kind: TaodStreamFrameKind.Resize,
      sessionId: 'session-1',
      seq: 11,
      payload: encodeTaodResizePayload(120, 40),
    }).toString('hex'),
    resize.toString('hex'),
  )
  assert.equal(
    decodeTaodResizePayload(new TaodStreamFrameParser().push(resize)[0]!.payload)?.cols,
    120,
  )

  const exitPayload = Buffer.from([0, 0, 0, 2, 0, 0, 0, 15])
  assert.equal(
    encodeTaodStreamFrame({
      kind: TaodStreamFrameKind.Exit,
      sessionId: 'session-1',
      seq: 12,
      payload: exitPayload,
    }).toString('hex'),
    exit.toString('hex'),
  )
  assert.deepEqual(decodeTaodExitPayload(new TaodStreamFrameParser().push(exit)[0]!.payload), {
    exitCode: 2,
    signal: 15,
  })

  assert.equal(
    encodeTaodStreamFrame({
      kind: TaodStreamFrameKind.Snapshot,
      sessionId: 'session-1',
      seq: 13,
      payload: 'state',
    }).toString('hex'),
    snapshot.toString('hex'),
  )
  const frames = new TaodStreamFrameParser().push(snapshot)
  assert.equal(frames[0]?.kind, TaodStreamFrameKind.Snapshot)
  assert.equal(frames[0]?.payload.toString('utf8'), 'state')
})

test('taod stream parser rejects shared golden corrupt CRC fixture', () => {
  assert.throws(
    () => new TaodStreamFrameParser().push(readHexFixture('stream-corrupt-crc-frame.hex')),
    /CRC/u,
  )
})

test('taod stream frames encode and parse binary payloads', () => {
  const encoded = encodeTaodStreamFrame({
    kind: TaodStreamFrameKind.Output,
    sessionId: 'session-1',
    seq: 7,
    payload: Buffer.from('hello'),
  })

  const parser = new TaodStreamFrameParser()
  const frames = parser.push(encoded)

  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.kind, TaodStreamFrameKind.Output)
  assert.equal(frames[0]?.sessionId, 'session-1')
  assert.equal(frames[0]?.seq, 7)
  assert.equal(frames[0]?.payload.toString('utf8'), 'hello')
})

test('taod stream parser keeps partial tails for the next chunk', () => {
  const first = encodeTaodStreamFrame({
    kind: TaodStreamFrameKind.Output,
    sessionId: 'session-1',
    seq: 1,
    payload: 'first',
  })
  const second = encodeTaodStreamFrame({
    kind: TaodStreamFrameKind.Agent,
    sessionId: 'session-1',
    seq: 2,
    payload: '{"ok":true}',
  })

  const parser = new TaodStreamFrameParser()
  assert.equal(parser.push(Buffer.concat([first, second.subarray(0, 5)])).length, 1)
  const frames = parser.push(second.subarray(5))

  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.kind, TaodStreamFrameKind.Agent)
  assert.equal(frames[0]?.seq, 2)
})

test('taod stream parser preserves magic prefixes while resyncing across chunks', () => {
  const encoded = encodeTaodStreamFrame({
    kind: TaodStreamFrameKind.Output,
    sessionId: 'session-1',
    seq: 1,
    payload: 'recovered',
  })

  const parser = new TaodStreamFrameParser()
  assert.deepEqual(parser.push(Buffer.concat([Buffer.from('noise'), encoded.subarray(0, 2)])), [])
  const frames = parser.push(encoded.subarray(2))

  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.payload.toString('utf8'), 'recovered')
})

test('taod stream parser rejects CRC corruption', () => {
  const encoded = encodeTaodStreamFrame({
    kind: TaodStreamFrameKind.Output,
    sessionId: 'session-1',
    seq: 1,
    payload: 'bad',
  })
  encoded[encoded.length - 1]! ^= 0xff

  const parser = new TaodStreamFrameParser()
  assert.throws(() => parser.push(encoded), /CRC/u)
})

test('taod resize and exit payload helpers round-trip', () => {
  assert.deepEqual(decodeTaodResizePayload(encodeTaodResizePayload(120, 40)), {
    cols: 120,
    rows: 40,
  })

  const exitPayload = Buffer.alloc(8)
  exitPayload.writeInt32BE(2, 0)
  exitPayload.writeInt32BE(15, 4)
  assert.deepEqual(decodeTaodExitPayload(exitPayload), { exitCode: 2, signal: 15 })
})

test('current-screen snapshot envelopes and fallback payloads round-trip', () => {
  const screen = fallbackScreenFromText(6, 2, ['hello', 'VT'])
  const fallback = encodeFallbackCurrentScreenSnapshot({
    cols: 6,
    rows: 2,
    cursorX: 2,
    cursorY: 1,
    screen,
  })
  const envelope = encodeCurrentScreenSnapshot({
    seq: 42,
    cols: 6,
    rows: 2,
    backendName: 'fallback',
    payload: fallback,
  })

  const decoded = decodeCurrentScreenSnapshot(envelope)
  assert.equal(decoded.seq, 42)
  assert.equal(decoded.backendName, 'fallback')
  assert.equal(isFallbackCurrentScreenSnapshot(decoded), true)
  assert.equal(decoded.payloadCrc32, currentScreenCrc32(fallback))

  const decodedFallback = decodeFallbackCurrentScreenSnapshotPayload(decoded.payload)
  assert.equal(decodedFallback.cols, 6)
  assert.equal(decodedFallback.rows, 2)
  assert.equal(decodedFallback.cursorX, 2)
  assert.equal(decodedFallback.cursorY, 1)
  assert.equal(
    fallbackCurrentScreenSnapshotToAnsi(decodedFallback),
    '\x1b[2J\x1b[1;1Hhello\x1b[2;1HVT\x1b[2;3H',
  )
})

test('current-screen snapshot decoder rejects corrupt payload CRCs', () => {
  const fallback = encodeFallbackCurrentScreenSnapshot({
    cols: 4,
    rows: 1,
    screen: fallbackScreenFromText(4, 1, ['bad']),
  })
  const envelope = Buffer.from(
    encodeCurrentScreenSnapshot({
      seq: 1,
      cols: 4,
      rows: 1,
      backendName: 'fallback',
      payload: fallback,
    }),
  )
  envelope[envelope.length - 1]! ^= 0xff

  assert.throws(() => decodeCurrentScreenSnapshot(envelope), /CRC/u)
})

test('current-screen snapshot envelope is backend-compatible and gates fallback decoding', () => {
  const unsupportedEnvelope = encodeCurrentScreenSnapshot({
    seq: 7,
    cols: 80,
    rows: 24,
    backendName: 'some_future_backend',
    payload: Buffer.from('native-backend-state'),
  })

  const decoded = decodeCurrentScreenSnapshot(unsupportedEnvelope)
  assert.equal(decoded.backendName, 'some_future_backend')
  assert.equal(isFallbackCurrentScreenSnapshot(decoded), false)
  assert.equal(isGhosttyNativeCurrentScreenSnapshot(decoded), false)
  assert.throws(() => decodeFallbackCurrentScreenSnapshotPayload(decoded.payload), /fallback/u)
})

test('ghostty native current-screen snapshots carry VT restore bytes', () => {
  const vt = Buffer.from('\x1b[2J\x1b[1;1Hhello\x1b[2;3H')
  const native = encodeGhosttyNativeCurrentScreenSnapshot({
    cols: 12,
    rows: 4,
    maxScrollback: 100,
    vt,
  })
  const envelope = encodeCurrentScreenSnapshot({
    seq: 8,
    cols: 12,
    rows: 4,
    backendName: 'ghostty_native',
    payload: native,
  })

  const decoded = decodeCurrentScreenSnapshot(envelope)
  assert.equal(isGhosttyNativeCurrentScreenSnapshot(decoded), true)
  assert.equal(decoded.payloadCrc32, currentScreenCrc32(native))

  const decodedNative = decodeGhosttyNativeCurrentScreenSnapshotPayload(decoded.payload)
  assert.equal(decodedNative.cols, 12)
  assert.equal(decodedNative.rows, 4)
  assert.equal(decodedNative.maxScrollback, 100)
  assert.equal(ghosttyNativeCurrentScreenSnapshotToAnsi(decodedNative), vt.toString('utf8'))
})

test('taod stream parser accepts snapshot frames with current-screen envelopes', () => {
  const payload = encodeCurrentScreenSnapshot({
    seq: 3,
    cols: 2,
    rows: 1,
    backendName: 'ghostty_native',
    payload: encodeGhosttyNativeCurrentScreenSnapshot({
      cols: 2,
      rows: 1,
      vt: Buffer.from('\x1b[2J\x1b[1;1Hok'),
    }),
  })
  const encoded = encodeTaodStreamFrame({
    kind: TaodStreamFrameKind.Snapshot,
    sessionId: 'session-1',
    seq: 3,
    payload,
  })

  const frames = new TaodStreamFrameParser().push(encoded)
  assert.equal(frames[0]?.kind, TaodStreamFrameKind.Snapshot)
  assert.equal(decodeCurrentScreenSnapshot(frames[0]!.payload).seq, 3)
})

test('taod stream parser handles bursty output frames in order', () => {
  const encodedFrames: Buffer[] = []
  for (let seq = 1; seq <= 4096; seq++) {
    encodedFrames.push(
      encodeTaodStreamFrame({
        kind: TaodStreamFrameKind.Output,
        sessionId: 'stress-session',
        seq,
        payload: `line ${seq}\n`,
      }),
    )
  }

  const parser = new TaodStreamFrameParser()
  const frames = parser.push(Buffer.concat(encodedFrames))

  assert.equal(frames.length, encodedFrames.length)
  assert.equal(frames[0]?.seq, 1)
  assert.equal(frames.at(-1)?.seq, encodedFrames.length)
  assert.equal(frames.at(-1)?.payload.toString('utf8'), `line ${encodedFrames.length}\n`)
})

test('taod stream parser rejects oversized payload headers before buffering bodies', () => {
  const encoded = encodeTaodStreamFrame({
    kind: TaodStreamFrameKind.Output,
    sessionId: 'stress-session',
    seq: 1,
    payload: 'small',
  })
  encoded.writeUInt32BE(TAOD_STREAM_MAX_PAYLOAD_BYTES + 1, TAOD_STREAM_PAYLOAD_LENGTH_OFFSET)

  assert.throws(() => new TaodStreamFrameParser().push(encoded), /header/u)
})
