type TerminalWriteTarget = {
  write(data: string, callback?: () => void): void
}

const OUTPUT_BATCH_MAX_CHARS = 32 * 1024
const OUTPUT_WRITE_CHUNK_MAX_CHARS = 16 * 1024

export function createBatchedTerminalWriter(term: TerminalWriteTarget): {
  write(data: string): void
  flush(): void
  drain(): Promise<void>
  dispose(): void
} {
  let chunks: string[] = []
  let queuedChars = 0
  let writeQueue: string[] = []
  let flushTimer: number | null = null
  let writeTimer: number | null = null
  let writing = false
  let disposed = false
  let drainWaiters: Array<() => void> = []

  function clearFlushTimer() {
    if (flushTimer === null) return
    window.clearTimeout(flushTimer)
    flushTimer = null
  }

  function clearWriteTimer() {
    if (writeTimer === null) return
    window.clearTimeout(writeTimer)
    writeTimer = null
  }

  function resolveDrainWaiters() {
    if (writing || chunks.length > 0 || writeQueue.length > 0) return

    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  function enqueueWriteData(data: string) {
    for (let offset = 0; offset < data.length; offset += OUTPUT_WRITE_CHUNK_MAX_CHARS) {
      writeQueue.push(data.slice(offset, offset + OUTPUT_WRITE_CHUNK_MAX_CHARS))
    }
  }

  function scheduleWrite() {
    if (disposed || writing || writeTimer !== null) return
    writeTimer = window.setTimeout(() => {
      writeTimer = null
      processWriteQueue()
    }, 0)
  }

  function processWriteQueue() {
    clearWriteTimer()
    if (disposed || writing) return

    const data = writeQueue.shift()
    if (!data) {
      resolveDrainWaiters()
      return
    }

    writing = true
    term.write(data, () => {
      writing = false
      if (disposed) {
        writeQueue = []
        resolveDrainWaiters()
        return
      }

      scheduleWrite()
      resolveDrainWaiters()
    })
  }

  function flush() {
    clearFlushTimer()
    if (disposed || chunks.length === 0) return

    const data = chunks.join('')
    chunks = []
    queuedChars = 0
    enqueueWriteData(data)
    processWriteQueue()
  }

  function scheduleFlush() {
    if (flushTimer !== null) return
    flushTimer = window.setTimeout(flush, 0)
  }

  return {
    write(data: string) {
      if (disposed || data.length === 0) return
      chunks.push(data)
      queuedChars += data.length
      if (queuedChars >= OUTPUT_BATCH_MAX_CHARS) {
        flush()
        return
      }
      scheduleFlush()
    },
    flush,
    drain() {
      flush()
      if (!writing && writeQueue.length === 0) return Promise.resolve()

      return new Promise((resolve) => {
        drainWaiters.push(resolve)
      })
    },
    dispose() {
      disposed = true
      clearFlushTimer()
      clearWriteTimer()
      chunks = []
      queuedChars = 0
      writeQueue = []
      const waiters = drainWaiters
      drainWaiters = []
      for (const resolve of waiters) resolve()
    },
  }
}
