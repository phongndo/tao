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

    callbacks.shift()?.()
    await delay()
    assert.equal(writes.length, 3)
    assert.equal(writes[2]?.length, 8 * 1024)
    assert.equal(drained, false)

    callbacks.shift()?.()
    await drain
    assert.equal(drained, true)
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
  } finally {
    restoreWindow()
  }
})
