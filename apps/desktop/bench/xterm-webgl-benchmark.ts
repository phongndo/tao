import { app, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

type RendererMode = 'dom' | 'webgl'

type BenchSample = {
  name: string
  mode: RendererMode
  durationMs: number
  p95FrameMs?: number
  maxFrameMs?: number
  framesOver16?: number
  webglActive: boolean
}

function packageFileUrl(packageName: string, relativePath: string): string {
  const root = dirname(require.resolve(`${packageName}/package.json`))
  return pathToFileURL(join(root, relativePath)).href
}

function rendererHtml(): string {
  const xtermCss = packageFileUrl('@xterm/xterm', 'css/xterm.css')

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="${xtermCss}" />
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #151515; }
      #terminal { width: 1080px; height: 720px; padding: 8px; box-sizing: border-box; }
      .xterm { height: 100%; }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script>
      const { ipcRenderer } = require('electron')
      const { Terminal } = require('@xterm/xterm')
      const { WebglAddon } = require('@xterm/addon-webgl')

      const theme = {
        background: '#151515',
        foreground: '#c9c7cd',
        cursor: '#cac9dd',
        cursorAccent: '#151515',
        selectionBackground: '#2a2a2d',
        black: '#27272a',
        red: '#f5a191',
        green: '#90b99f',
        yellow: '#e6b99d',
        blue: '#aca1cf',
        magenta: '#e29eca',
        cyan: '#ea83a5',
        white: '#c1c0d4',
        brightBlack: '#424246',
        brightRed: '#ffae9f',
        brightGreen: '#9dc6ac',
        brightYellow: '#f0c5a9',
        brightBlue: '#b9aeda',
        brightMagenta: '#ecaad6',
        brightCyan: '#f591b2',
        brightWhite: '#cac9dd',
      }

      function seededRandom(seed) {
        let state = seed >>> 0
        return () => {
          state = (1664525 * state + 1013904223) >>> 0
          return state / 0x100000000
        }
      }

      function generateData(sizeMiB, ansiDensity, seed) {
        const target = sizeMiB * 1024 * 1024
        const random = seededRandom(seed)
        const styles = [
          '\\x1b[31m', '\\x1b[32m', '\\x1b[33m', '\\x1b[34m',
          '\\x1b[35m', '\\x1b[36m', '\\x1b[1m', '\\x1b[4m',
          '\\x1b[38;5;196m', '\\x1b[48;5;22m', '\\x1b[0m',
        ]
        let out = ''
        while (out.length < target) {
          let line = ''
          const len = 20 + Math.floor(random() * 100)
          for (let index = 0; index < len && out.length + line.length < target; index++) {
            if (random() < ansiDensity) {
              line += styles[Math.floor(random() * styles.length)]
            }
            line += String.fromCharCode(32 + Math.floor(random() * 95))
          }
          out += line + '\\r\\n'
        }
        return out
      }

      function percentile(values, p) {
        if (values.length === 0) return 0
        const sorted = [...values].sort((a, b) => a - b)
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
      }

      function nextFrame() {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()))
      }

      function writeAndPresent(term, data) {
        const start = performance.now()
        return new Promise((resolve) => {
          term.write(data, async () => {
            await nextFrame()
            resolve(performance.now() - start)
          })
        })
      }

      function createTerminal(mode) {
        const container = document.getElementById('terminal')
        container.replaceChildren()
        const term = new Terminal({
          cols: 120,
          rows: 40,
          fontSize: 14,
          fontFamily: '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace',
          theme,
          cursorBlink: false,
          cursorStyle: 'block',
          cursorInactiveStyle: 'none',
          scrollback: 10000,
          allowTransparency: false,
          convertEol: false,
          customGlyphs: true,
          minimumContrastRatio: 1,
          rescaleOverlappingGlyphs: false,
          screenReaderMode: false,
          smoothScrollDuration: 0,
          logLevel: 'warn',
        })
        term.open(container)

        let webglActive = false
        if (mode === 'webgl') {
          try {
            const addon = new WebglAddon()
            addon.onContextLoss(() => {
              webglActive = false
              addon.dispose()
            })
            term.loadAddon(addon)
            webglActive = true
          } catch (error) {
            console.warn('WebGL addon failed:', error)
          }
        }

        return { term, webglActive }
      }

      async function runMode(mode) {
        const results = []
        const { term, webglActive } = createTerminal(mode)

        await writeAndPresent(term, 'warmup\\r\\n')
        term.clear()

        const plain = generateData(1, 0.01, 1001)
        const ansi = generateData(1, 0.45, 1002)

        results.push({
          name: '1MiB plain parse+present',
          mode,
          durationMs: await writeAndPresent(term, plain),
          webglActive,
        })
        term.clear()

        results.push({
          name: '1MiB ANSI parse+present',
          mode,
          durationMs: await writeAndPresent(term, ansi),
          webglActive,
        })
        term.clear()

        const chunks = Array.from({ length: 1000 }, (_, index) =>
          generateData(0.002, 0.25, 2000 + index),
        )
        const burstStart = performance.now()
        for (const chunk of chunks) {
          await new Promise((resolve) => term.write(chunk, resolve))
        }
        await nextFrame()
        results.push({
          name: '1000 tiny writes sequential',
          mode,
          durationMs: performance.now() - burstStart,
          webglActive,
        })
        term.clear()

        const batchedBurstStart = performance.now()
        await new Promise((resolve) => term.write(chunks.join(''), resolve))
        await nextFrame()
        results.push({
          name: '1000 tiny writes batched',
          mode,
          durationMs: performance.now() - batchedBurstStart,
          webglActive,
        })
        term.clear()

        const scrollFrames = []
        for (let index = 0; index < 300; index++) {
          scrollFrames.push(
            await writeAndPresent(
              term,
              '\\x1b[32mframe ' + String(index).padStart(3, '0') + '\\x1b[0m scrolling output\\r\\n',
            ),
          )
        }
        results.push({
          name: '300 scrolling frames',
          mode,
          durationMs: scrollFrames.reduce((sum, value) => sum + value, 0),
          p95FrameMs: percentile(scrollFrames, 0.95),
          maxFrameMs: Math.max(...scrollFrames),
          framesOver16: scrollFrames.filter((value) => value > 16.7).length,
          webglActive,
        })
        term.clear()

        const repaintFrames = []
        for (let frame = 0; frame < 120; frame++) {
          const data =
            '\\x1b[H' +
            Array.from({ length: 40 }, (_, row) =>
              '\\x1b[' +
              (31 + ((row + frame) % 7)) +
              'm' +
              'row ' +
              String(row).padStart(2, '0') +
              ' frame ' +
              String(frame).padStart(3, '0') +
              ' '.repeat(96) +
              '\\x1b[0m',
            ).join('\\r\\n')
          repaintFrames.push(await writeAndPresent(term, data))
        }
        results.push({
          name: '120 full viewport repaints',
          mode,
          durationMs: repaintFrames.reduce((sum, value) => sum + value, 0),
          p95FrameMs: percentile(repaintFrames, 0.95),
          maxFrameMs: Math.max(...repaintFrames),
          framesOver16: repaintFrames.filter((value) => value > 16.7).length,
          webglActive,
        })

        term.dispose()
        return results
      }

      ;(async () => {
        const dom = await runMode('dom')
        const webgl = await runMode('webgl')
        ipcRenderer.send('bench:done', [...dom, ...webgl])
      })().catch((error) => {
        ipcRenderer.send('bench:error', String(error && error.stack ? error.stack : error))
      })
    </script>
  </body>
</html>`
}

function waitForResults(timeoutMs = 60_000): Promise<BenchSample[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for xterm WebGL benchmark results'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      ipcMain.removeListener('bench:done', done)
      ipcMain.removeListener('bench:error', error)
    }

    const done = (_event: IpcMainEvent, samples: BenchSample[]) => {
      cleanup()
      resolve(samples)
    }

    const error = (_event: IpcMainEvent, message: string) => {
      cleanup()
      reject(new Error(message))
    }

    ipcMain.once('bench:done', done)
    ipcMain.once('bench:error', error)
  })
}

function printResults(samples: readonly BenchSample[]): void {
  const byName = new Map<string, { dom?: BenchSample; webgl?: BenchSample }>()
  for (const sample of samples) {
    const item = byName.get(sample.name) ?? {}
    item[sample.mode] = sample
    byName.set(sample.name, item)
  }

  console.log('Tao xterm.js renderer benchmark')
  console.log('viewport: 120x40 cells, surface: 1080x720 CSS px')
  console.log('')
  console.log('workload                      dom ms   webgl ms  speedup  webgl p95  >16ms')

  for (const [name, pair] of byName) {
    if (!pair.dom || !pair.webgl) continue
    const speedup = pair.dom.durationMs / pair.webgl.durationMs
    const p95 = pair.webgl.p95FrameMs == null ? '-' : pair.webgl.p95FrameMs.toFixed(2)
    const over16 = pair.webgl.framesOver16 == null ? '-' : String(pair.webgl.framesOver16)
    console.log(
      [
        name.padEnd(28),
        pair.dom.durationMs.toFixed(1).padStart(7),
        pair.webgl.durationMs.toFixed(1).padStart(9),
        `${speedup.toFixed(2)}x`.padStart(8),
        p95.padStart(9),
        over16.padStart(6),
      ].join('  '),
    )
  }

  const webglLoaded = samples
    .filter((sample) => sample.mode === 'webgl')
    .every((sample) => sample.webglActive)
  console.log('')
  console.log(`WebGL addon active: ${webglLoaded ? 'yes' : 'no, fell back during benchmark'}`)
}

async function main(): Promise<void> {
  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false,
      webgl: true,
    },
  })

  const resultPromise = waitForResults()
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererHtml())}`)
  const results = await resultPromise
  printResults(results)

  win.destroy()
  app.quit()
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
