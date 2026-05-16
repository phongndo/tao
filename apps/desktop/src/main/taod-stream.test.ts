import test from 'node:test'
import assert from 'node:assert/strict'
import { TaodStreamFrameKind } from '@tao/shared/taod-protocol'
import {
  decodeTaodExitPayload,
  decodeTaodResizePayload,
  encodeTaodResizePayload,
  encodeTaodStreamFrame,
  TaodStreamFrameParser,
} from './taod-stream'

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
