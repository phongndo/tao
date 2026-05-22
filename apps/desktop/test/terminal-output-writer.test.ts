import assert from 'node:assert/strict'
import test from 'node:test'
import { createBatchedTerminalWriter } from '../src/renderer/terminal-output-writer'

const delay = () => new Promise((resolve) => setTimeout(resolve, 0))

function installWindowTimers() {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    setTimeout,
    clearTimeout,
  }

  return () => {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
}

test('terminal output writer serializes xterm writes until callbacks fire', async () => {
  const restoreWindow = installWindowTimers()
  try {
    const writes: string[] = []
    const callbacks: Array<() => void> = []
    const writer = createBatchedTerminalWriter({
      write(data, callback) {
        writes.push(data)
        if (callback) callbacks.push(callback)
      },
    })

    writer.write('x'.repeat(40 * 1024))
    await delay()

    const diagnostics = writer.diagnostics()
    assert.equal(diagnostics.writeQueueChars, 24 * 1024)
    assert.equal(diagnostics.writeQueueChunks, 2)
    assert.equal(diagnostics.maxWriteQueueChars, 40 * 1024)
    assert.equal(diagnostics.maxWriteQueueChunks, 3)
    assert.equal(diagnostics.writing, true)

    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.length, 16 * 1024)

    let drained = false
    const drain = writer.drain().then(() => {
      drained = true
    })
    await delay()
    assert.equal(drained, false)

    callbacks.shift()?.()
    await delay()
    assert.equal(writes.length, 2)
    assert.equal(writes[1]?.length, 16 * 1024)
    assert.equal(drained, false)
    assert.equal(writer.diagnostics().writeCount, 1)
    assert.equal(writer.diagnostics().totalWrittenChars, 16 * 1024)

    callbacks.shift()?.()
    await delay()
    assert.equal(writes.length, 3)
    assert.equal(writes[2]?.length, 8 * 1024)
    assert.equal(drained, false)

    callbacks.shift()?.()
    await drain
    assert.equal(drained, true)
    const drainedDiagnostics = writer.diagnostics()
    assert.equal(drainedDiagnostics.writeCount, 3)
    assert.equal(drainedDiagnostics.totalWrittenChars, 40 * 1024)
    assert.equal(drainedDiagnostics.lastWriteChars, 8 * 1024)
    assert.ok(drainedDiagnostics.lastWriteDurationMs >= 0)
    assert.ok(drainedDiagnostics.maxWriteDurationMs >= 0)
    assert.deepEqual(
      {
        queuedChars: drainedDiagnostics.queuedChars,
        queuedChunks: drainedDiagnostics.queuedChunks,
        writeQueueChars: drainedDiagnostics.writeQueueChars,
        writeQueueChunks: drainedDiagnostics.writeQueueChunks,
        writing: drainedDiagnostics.writing,
        drainWaiters: drainedDiagnostics.drainWaiters,
        maxWriteQueueChars: drainedDiagnostics.maxWriteQueueChars,
        maxWriteQueueChunks: drainedDiagnostics.maxWriteQueueChunks,
      },
      {
        queuedChars: 0,
        queuedChunks: 0,
        writeQueueChars: 0,
        writeQueueChunks: 0,
        writing: false,
        drainWaiters: 0,
        maxWriteQueueChars: 40 * 1024,
        maxWriteQueueChunks: 3,
      },
    )
  } finally {
    restoreWindow()
  }
})

test('terminal output writer batches same-tick output before writing', async () => {
  const restoreWindow = installWindowTimers()
  try {
    const writes: string[] = []
    const callbacks: Array<() => void> = []
    const writer = createBatchedTerminalWriter({
      write(data, callback) {
        writes.push(data)
        if (callback) callbacks.push(callback)
      },
    })

    writer.write('abc')
    writer.write('def')
    await delay()

    assert.deepEqual(writes, ['abcdef'])
    callbacks.shift()?.()
    await writer.drain()
    assert.equal(writer.diagnostics().writeCount, 1)
    assert.equal(writer.diagnostics().totalWrittenChars, 6)
  } finally {
    restoreWindow()
  }
})

test('terminal output writer bounds backlog when xterm stops draining', async () => {
  const restoreWindow = installWindowTimers()
  try {
    const writes: string[] = []
    const callbacks: Array<() => void> = []
    const writer = createBatchedTerminalWriter({
      write(data, callback) {
        writes.push(data)
        if (callback) callbacks.push(callback)
      },
    })

    writer.write('x'.repeat(5 * 1024 * 1024))
    await delay()

    const backedUpDiagnostics = writer.diagnostics()
    assert.equal(backedUpDiagnostics.writing, true)
    assert.equal(backedUpDiagnostics.dropNoticeCount, 1)
    assert.ok(backedUpDiagnostics.droppedWriteQueueCharsTotal > 0)
    assert.ok(backedUpDiagnostics.droppedWriteQueueChunksTotal > 0)
    assert.ok(backedUpDiagnostics.writeQueueChars < 3 * 1024 * 1024)
    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.length, 16 * 1024)

    const drain = writer.drain()
    while (writer.diagnostics().writing || writer.diagnostics().writeQueueChunks > 0) {
      const callback = callbacks.shift()
      if (callback) callback()
      await delay()
    }
    await drain

    const drainedDiagnostics = writer.diagnostics()
    assert.equal(drainedDiagnostics.writeQueueChars, 0)
    assert.equal(drainedDiagnostics.writeQueueChunks, 0)
    assert.equal(drainedDiagnostics.writing, false)
    assert.equal(drainedDiagnostics.dropNoticeCount, 1)
    const noticeWrite = writes.find((data) => data.includes('Tao dropped terminal output'))
    assert.ok(noticeWrite)
    assert.equal(
      drainedDiagnostics.totalWrittenChars + drainedDiagnostics.droppedWriteQueueCharsTotal,
      5 * 1024 * 1024 + noticeWrite.length,
    )
  } finally {
    restoreWindow()
  }
})
