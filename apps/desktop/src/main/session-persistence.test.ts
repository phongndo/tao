import { mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'tao-session-persistence-'))
process.env.HOME = home

const persistence = await import('./session-persistence')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('replays valid output frames and ignores frames with bad CRCs', () => {
  const session = persistence.openPersistentSession('crc-session')
  persistence.appendOutput(session, 'ok')
  persistence.appendOutput(session, 'bad')

  const log = readFileSync(session.eventLogPath)
  const payloadOffset = log.indexOf(Buffer.from('bad'))
  assert.notEqual(payloadOffset, -1)
  log[payloadOffset] ^= 0xff
  writeFileSync(session.eventLogPath, log)

  assert.equal(persistence.readReplayOutput('crc-session'), 'ok')
  assert.equal(persistence.openPersistentSession('crc-session').seq, 1n)
})

test('stops replay and sequence recovery before a partial tail frame', () => {
  const session = persistence.openPersistentSession('partial-session')
  persistence.appendOutput(session, 'before')
  persistence.appendOutput(session, 'after')

  truncateSync(session.eventLogPath, readFileSync(session.eventLogPath).length - 2)

  assert.equal(persistence.readReplayOutput('partial-session'), 'before')
  const reopened = persistence.openPersistentSession('partial-session')
  assert.equal(reopened.seq, 1n)
  persistence.appendOutput(reopened, 'next')
  assert.equal(persistence.readReplayOutput('partial-session'), 'beforenext')
})

test('bounds replay to the requested byte tail', () => {
  const session = persistence.openPersistentSession('bounded-session')
  persistence.appendOutput(session, '0123456789')
  persistence.appendOutput(session, 'abcdef')

  assert.equal(persistence.readReplayOutput('bounded-session', 8), '89abcdef')
})

test('handles large logs while preserving only the requested replay tail', () => {
  const session = persistence.openPersistentSession('large-session')
  for (let i = 0; i < 300; i++) {
    persistence.appendOutput(session, `${i.toString().padStart(3, '0')}\n`)
  }

  const replay = persistence.readReplayOutput('large-session', 64)
  assert.ok(Buffer.byteLength(replay) <= 64)
  assert.ok(replay.endsWith('299\n'))
})

test('render replay events preserve resize frames and avoid mid-frame output truncation', () => {
  const session = persistence.openPersistentSession('resize-replay-session')
  persistence.appendResize(session, 120, 40)
  persistence.appendOutput(session, 'first prompt')
  persistence.appendResize(session, 60, 20)
  persistence.appendOutput(session, 'second prompt')

  assert.deepEqual(persistence.readReplayEvents('resize-replay-session', 13), [
    { type: 'resize', seq: 3n, cols: 60, rows: 20 },
    { type: 'output', seq: 4n, data: 'second prompt' },
  ])
  assert.deepEqual(persistence.readReplayEvents('resize-replay-session', 8), [])
})

test('cleanup honors retention, total-size cap, and active sessions', () => {
  const keep = persistence.openPersistentSession('active-session')
  persistence.appendOutput(keep, 'keep')
  const old = persistence.openPersistentSession('old-session')
  persistence.appendOutput(old, 'old')
  const cap = persistence.openPersistentSession('cap-session')
  persistence.appendOutput(cap, 'cap'.repeat(1024))

  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  utimesSync(old.dir, oldDate, oldDate)
  utimesSync(cap.dir, oldDate, oldDate)

  persistence.cleanupSessionPersistence({
    retainDays: 1,
    maxSessionBytes: 1,
    activeSessionIds: new Set(['active-session']),
  })

  assert.equal(readFileSync(keep.eventLogPath).length > 0, true)
  assert.throws(() => readFileSync(old.eventLogPath))
  assert.throws(() => readFileSync(cap.eventLogPath))
})
