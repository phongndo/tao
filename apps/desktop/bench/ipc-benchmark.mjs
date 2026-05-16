import { app, BrowserWindow, ipcMain, MessageChannelMain } from 'electron'

process.once('uncaughtException', (err) => {
  console.error(err)
  app.exit(1)
})

function readPositiveIntEnv(name, fallback, max) {
  const raw = process.env[name] ?? String(fallback)
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`)
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new Error(`${name} must be <= ${max}`)
  }

  return parsed
}

const TOTAL_MB = readPositiveIntEnv('TAO_IPC_BENCH_MB', 64, 4096)
const CHUNK_KB = readPositiveIntEnv('TAO_IPC_BENCH_CHUNK_KB', 64, 1024)
const RUNS = readPositiveIntEnv('TAO_IPC_BENCH_RUNS', 3, 100)
const PING_EVERY_CHUNKS = readPositiveIntEnv('TAO_IPC_BENCH_PING_EVERY_CHUNKS', 4, 1_000_000)

const totalBytes = TOTAL_MB * 1024 * 1024
const chunkBytes = CHUNK_KB * 1024
const chunks = Math.ceil(totalBytes / chunkBytes)
const controlPings = Math.ceil(chunks / PING_EVERY_CHUNKS)
const payload = 'x'.repeat(chunkBytes)

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function summarize(mode, samples) {
  const durations = samples.map((sample) => sample.durationMs)
  const throughput = samples.map((sample) => TOTAL_MB / (sample.durationMs / 1000))
  const stalls16 = samples.map((sample) => sample.stalls16)
  const stalls32 = samples.map((sample) => sample.stalls32)
  const controlStalls16 = samples.map((sample) => sample.controlStalls16)
  const controlStalls32 = samples.map((sample) => sample.controlStalls32)

  return {
    mode,
    avgMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    bestMBps: Math.max(...throughput),
    avgMBps: throughput.reduce((sum, value) => sum + value, 0) / throughput.length,
    medianStalls16: percentile(stalls16, 0.5),
    medianStalls32: percentile(stalls32, 0.5),
    medianControlStalls16: percentile(controlStalls16, 0.5),
    medianControlStalls32: percentile(controlStalls32, 0.5),
    p99ControlLatencyMs: percentile(
      samples.map((sample) => sample.p99ControlLatencyMs),
      0.99,
    ),
    p99GapMs: percentile(
      samples.map((sample) => sample.p99GapMs),
      0.99,
    ),
    maxGapMs: Math.max(...samples.map((sample) => sample.maxGapMs)),
  }
}

function printSummary({ legacy, port }) {
  console.log('Tao Electron IPC benchmark')
  console.log(
    `payload: ${TOTAL_MB} MiB, chunk: ${CHUNK_KB} KiB, runs: ${RUNS}, control ping: every ${PING_EVERY_CHUNKS} chunks`,
  )
  console.log('')
  console.log(
    'mode          avg ms   avg MB/s  best MB/s  data stalls >16ms  data stalls >32ms  control stalls >16ms  control stalls >32ms  p99 ctrl  p99 data',
  )

  for (const result of [legacy, port]) {
    console.log(
      [
        result.mode.padEnd(12),
        result.avgMs.toFixed(1).padStart(7),
        result.avgMBps.toFixed(1).padStart(10),
        result.bestMBps.toFixed(1).padStart(10),
        String(result.medianStalls16).padStart(17),
        String(result.medianStalls32).padStart(17),
        String(result.medianControlStalls16).padStart(20),
        String(result.medianControlStalls32).padStart(20),
        result.p99ControlLatencyMs.toFixed(2).padStart(8),
        result.p99GapMs.toFixed(2).padStart(8),
      ].join('  '),
    )
  }

  console.log('')
  if (port.medianControlStalls16 < legacy.medianControlStalls16) {
    console.log(
      'PASS: MessagePort caused fewer median >16ms control IPC stalls during bulk output.',
    )
  } else {
    console.log('WARN: MessagePort did not reduce median >16ms control IPC stalls in this run.')
  }
}

function rendererHtml() {
  return `<!doctype html>
<html>
  <body>
    <script>
      const { ipcRenderer } = require('electron')

      let expectedChunks = 0
      let expectedControlPings = 0
      let receivedChunks = 0
      let receivedBytes = 0
      let start = 0
      let last = 0
      let gaps = []
      let controlLatencies = []
      let port = null

      function reset(expectedData, expectedPings) {
        expectedChunks = expectedData
        expectedControlPings = expectedPings
        receivedChunks = 0
        receivedBytes = 0
        start = 0
        last = 0
        gaps = []
        controlLatencies = []
      }

      function record(data) {
        const now = performance.now()
        if (receivedChunks === 0) {
          start = now
        } else {
          gaps.push(now - last)
        }
        last = now
        receivedChunks += 1
        receivedBytes += data.length

        maybeDone()
      }

      function maybeDone() {
        if (receivedChunks === expectedChunks && controlLatencies.length === expectedControlPings) {
          const durationMs = performance.now() - start
          ipcRenderer.send('bench:done', {
            durationMs,
            receivedBytes,
            p95GapMs: percentile(gaps, 0.95),
            p99GapMs: percentile(gaps, 0.99),
            maxGapMs: gaps.length === 0 ? 0 : Math.max(...gaps),
            stalls16: gaps.filter((gap) => gap > 16).length,
            stalls32: gaps.filter((gap) => gap > 32).length,
            p99ControlLatencyMs: percentile(controlLatencies, 0.99),
            controlStalls16: controlLatencies.filter((latency) => latency > 16).length,
            controlStalls32: controlLatencies.filter((latency) => latency > 32).length,
          })
        }
      }

      function percentile(values, p) {
        if (values.length === 0) return 0
        const sorted = [...values].sort((a, b) => a - b)
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
      }

      ipcRenderer.on('bench:legacy-data', (_event, data) => {
        record(data)
      })

      ipcRenderer.on('bench:port', (event) => {
        if (port) port.close()
        port = event.ports[0]
        port.onmessage = (message) => record(message.data)
        port.start()
        ipcRenderer.send('bench:port-ready')
      })

      ipcRenderer.on('bench:start', (_event, expectedData, expectedPings) => {
        reset(expectedData, expectedPings)
        ipcRenderer.send('bench:ready')
      })

      ipcRenderer.on('bench:ping', (_event, sentAt) => {
        controlLatencies.push(Date.now() - sentAt)
        maybeDone()
        ipcRenderer.send('bench:pong')
      })
    </script>
  </body>
</html>`
}

function waitFor(channel, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onEvent = (_event, result) => {
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, onEvent)
      reject(new Error(`Timed out waiting for ${channel}`))
    }, timeoutMs)

    ipcMain.once(channel, onEvent)
  })
}

async function runLegacy(win) {
  win.webContents.send('bench:start', chunks, controlPings)
  await waitFor('bench:ready')

  for (let index = 0; index < chunks; index++) {
    win.webContents.send('bench:legacy-data', payload)
    sendControlPing(win, index)
  }

  const result = await waitFor('bench:done')
  return result
}

async function runPort(win) {
  const { port1, port2 } = new MessageChannelMain()
  win.webContents.postMessage('bench:port', null, [port2])
  port1.start()
  await waitFor('bench:port-ready')

  win.webContents.send('bench:start', chunks, controlPings)
  await waitFor('bench:ready')

  for (let index = 0; index < chunks; index++) {
    port1.postMessage(payload)
    sendControlPing(win, index)
  }

  const result = await waitFor('bench:done')
  port1.close()
  return result
}

function sendControlPing(win, index) {
  if (index % PING_EVERY_CHUNKS === 0) {
    win.webContents.send('bench:ping', Date.now())
  }
}

async function main() {
  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false,
    },
  })

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererHtml())}`)

  const legacySamples = []
  const portSamples = []
  for (let index = 0; index < RUNS; index++) {
    legacySamples.push(await runLegacy(win))
    portSamples.push(await runPort(win))
  }

  printSummary({
    legacy: summarize('legacy', legacySamples),
    port: summarize('messageport', portSamples),
  })

  win.destroy()
  app.quit()
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
