import { app, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)

type CombinedRendererSample = {
  durationMs: number
  terminalBytes: number
  terminalThroughputMBps: number
  p95FrameMs: number
  maxFrameMs: number
  framesOver16: number
  framesOver50: number
  domNodes: number
  pathCount: number
  diffFileCount: number
  mountedDiffFileCount: number
  webglActive: boolean
}

type CombinedRendererBudget = {
  pathCount: number
  gitStatusCount: number
  diffFileCount: number
  mountedDiffFileCount: number
  diffLinesPerFile: number
  terminalMiB: number
  terminalChunkKiB: number
  maxDurationMs: number
  minTerminalMBps: number
  maxP95FrameMs: number
  maxFrameMs: number
  maxFramesOver16: number
  maxFramesOver50: number
  maxDomNodes: number
  enforce: boolean
}

function readPositiveNumberEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name] ?? String(fallback)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive number <= ${max}`)
  }
  return parsed
}

const budget: CombinedRendererBudget = {
  pathCount: readPositiveNumberEnv('TAU_COMBINED_RENDERER_FILES', 25_000, 1_000_000),
  gitStatusCount: readPositiveNumberEnv('TAU_COMBINED_RENDERER_GIT_STATUS', 1000, 1_000_000),
  diffFileCount: readPositiveNumberEnv('TAU_COMBINED_RENDERER_DIFF_FILES', 24, 500),
  mountedDiffFileCount: readPositiveNumberEnv('TAU_COMBINED_RENDERER_MOUNTED_DIFF_FILES', 12, 100),
  diffLinesPerFile: readPositiveNumberEnv('TAU_COMBINED_RENDERER_DIFF_LINES', 40, 5000),
  terminalMiB: readPositiveNumberEnv('TAU_COMBINED_RENDERER_TERMINAL_MIB', 2, 1024),
  terminalChunkKiB: readPositiveNumberEnv('TAU_COMBINED_RENDERER_TERMINAL_CHUNK_KIB', 64, 1024),
  maxDurationMs: readPositiveNumberEnv('TAU_COMBINED_RENDERER_MAX_DURATION_MS', 10_000, 600_000),
  minTerminalMBps: readPositiveNumberEnv('TAU_COMBINED_RENDERER_MIN_MBPS', 2, 1024),
  maxP95FrameMs: readPositiveNumberEnv('TAU_COMBINED_RENDERER_MAX_P95_FRAME_MS', 80, 10_000),
  maxFrameMs: readPositiveNumberEnv('TAU_COMBINED_RENDERER_MAX_FRAME_MS', 300, 60_000),
  maxFramesOver16: readPositiveNumberEnv('TAU_COMBINED_RENDERER_MAX_FRAMES_OVER_16', 120, 100_000),
  maxFramesOver50: readPositiveNumberEnv('TAU_COMBINED_RENDERER_MAX_FRAMES_OVER_50', 8, 100_000),
  maxDomNodes: readPositiveNumberEnv('TAU_COMBINED_RENDERER_MAX_DOM_NODES', 12_000, 1_000_000),
  enforce: process.env.TAU_COMBINED_RENDERER_ENFORCE === '1',
}

function packageFileUrl(packageName: string, relativePath: string): string {
  const root = dirname(require.resolve(`${packageName}/package.json`))
  return pathToFileURL(resolve(root, relativePath)).href
}

function rendererHtml(): string {
  const xtermCss = packageFileUrl('@xterm/xterm', 'css/xterm.css')
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="${xtermCss}" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #151515;
        color: #c9c7cd;
        font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #app {
        width: 1280px;
        height: 800px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 420px;
        grid-template-rows: 100%;
      }
      #terminal {
        min-width: 0;
        height: 100%;
        padding: 8px;
        box-sizing: border-box;
      }
      #sidebar {
        min-width: 0;
        height: 100%;
        border-left: 1px solid #2a2a2d;
        display: grid;
        grid-template-rows: 45% 55%;
      }
      #tree, #diff {
        min-height: 0;
        overflow: auto;
      }
      #diff {
        border-top: 1px solid #2a2a2d;
        padding: 8px;
        box-sizing: border-box;
      }
      .diff-file {
        margin: 0 0 10px;
        border: 1px solid #2a2a2d;
        background: #191919;
      }
      .diff-file-title {
        padding: 6px 8px;
        color: #f1f1f4;
        background: #202024;
      }
    </style>
  </head>
  <body>
    <div id="app">
      <div id="terminal"></div>
      <div id="sidebar">
        <div id="tree"></div>
        <div id="diff"></div>
      </div>
    </div>
    <script src="./renderer.js"></script>
  </body>
</html>`
}

function rendererScript(rendererBudget: CombinedRendererBudget): string {
  return `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { FileTree } from '@pierre/trees'
    import { parsePatchFiles } from '@pierre/diffs'
    import { FileDiff } from '@pierre/diffs/react'
    import { Terminal } from '@xterm/xterm'
    import { WebglAddon } from '@xterm/addon-webgl'

    const { ipcRenderer } = require('electron')
    const budget = ${JSON.stringify(rendererBudget)}

    function percentile(values, p) {
      if (values.length === 0) return 0
      const sorted = [...values].sort((a, b) => a - b)
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    }

    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }

    function startFrameSampler() {
      const frames = []
      let running = true
      let previous = performance.now()
      function tick(now) {
        frames.push(now - previous)
        previous = now
        if (running) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      return {
        async stop() {
          running = false
          await nextFrame()
          return frames
        },
      }
    }

    function generatePaths(count) {
      const paths = []
      for (let index = 0; index < count; index += 1) {
        const packageId = String(Math.floor(index / 1000)).padStart(4, '0')
        const featureId = String(Math.floor(index / 100) % 10).padStart(2, '0')
        const bucketId = String(Math.floor(index / 10) % 10).padStart(2, '0')
        const fileId = String(index).padStart(6, '0')
        paths.push('packages/pkg-' + packageId + '/feature-' + featureId + '/bucket-' + bucketId + '/file-' + fileId + '.ts')
      }
      return paths
    }

    function generateGitStatus(paths, count) {
      const statuses = ['modified', 'added', 'deleted', 'renamed', 'untracked']
      const entries = []
      const limit = Math.min(paths.length, count)
      for (let index = 0; index < limit; index += 1) {
        entries.push({ path: paths[index], status: statuses[index % statuses.length] })
      }
      return entries
    }

    function generatePatch(fileCount, linesPerFile) {
      let patch = ''
      for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
        const file = 'packages/pkg-' + String(Math.floor(fileIndex / 4)).padStart(4, '0') + '/feature-' + String(fileIndex % 4).padStart(2, '0') + '/changed-' + String(fileIndex).padStart(4, '0') + '.ts'
        patch += 'diff --git a/' + file + ' b/' + file + '\\n'
        patch += 'index 0000000..1111111 100644\\n'
        patch += '--- a/' + file + '\\n'
        patch += '+++ b/' + file + '\\n'
        patch += '@@ -1,' + linesPerFile + ' +1,' + linesPerFile + ' @@\\n'
        for (let line = 0; line < linesPerFile; line += 1) {
          if (line % 5 === 0) {
            patch += '-export const value' + line + ' = "old-' + fileIndex + '-' + line + '"\\n'
            patch += '+export const value' + line + ' = "new-' + fileIndex + '-' + line + '"\\n'
          } else {
            patch += ' export const stable' + line + ' = "' + fileIndex + '-' + line + '"\\n'
          }
        }
      }
      return patch
    }

    function generateTerminalData(totalBytes) {
      const line = '\\x1b[32mINFO\\x1b[0m combined renderer pressure output ' + '0123456789abcdef'.repeat(8) + '\\r\\n'
      let output = ''
      while (output.length < totalBytes) output += line
      return output.slice(0, totalBytes)
    }

    function countDomNodes(root) {
      let count = 0
      const visit = (node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          count += 1
          if (node.shadowRoot) {
            for (const child of node.shadowRoot.children) visit(child)
          }
        }
        for (const child of node.children ?? []) visit(child)
      }
      visit(root)
      return count
    }

    function createTerminal() {
      const terminal = new Terminal({
        cols: 100,
        rows: 40,
        fontSize: 13,
        fontFamily: '"SF Mono", Menlo, Monaco, monospace',
        scrollback: 5000,
        smoothScrollDuration: 0,
        screenReaderMode: false,
        cursorBlink: false,
        theme: {
          background: '#151515',
          foreground: '#c9c7cd',
          green: '#90b99f',
        },
      })
      const terminalElement = document.getElementById('terminal')
      terminal.open(terminalElement)
      let webglActive = false
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webglActive = false
          webgl.dispose()
        })
        terminal.loadAddon(webgl)
        webglActive = true
      } catch (error) {
        console.warn('WebGL addon failed:', error)
      }
      return { terminal, webglActive }
    }

    async function writeTerminalOutput(terminal, data, chunkChars) {
      const startedAt = performance.now()
      for (let offset = 0; offset < data.length; offset += chunkChars) {
        await new Promise((resolve) => terminal.write(data.slice(offset, offset + chunkChars), resolve))
      }
      await nextFrame()
      return performance.now() - startedAt
    }

    function DiffPanel({ files }) {
      return React.createElement(
        'div',
        null,
        files.map((fileDiff, index) =>
          React.createElement(
            'section',
            { className: 'diff-file', key: fileDiff.name + ':' + index },
            React.createElement('div', { className: 'diff-file-title' }, fileDiff.name),
            React.createElement(FileDiff, {
              fileDiff,
              disableWorkerPool: true,
              options: {
                diffStyle: 'split',
                disableFileHeader: true,
                expandUnchanged: true,
                hunkSeparators: 'line-info-basic',
                lineDiffType: 'word',
                overflow: 'wrap',
                theme: { light: 'github-light-default', dark: 'github-dark-default' },
                themeType: 'dark',
              },
            }),
          ),
        ),
      )
    }

    ;(async () => {
      const paths = generatePaths(budget.pathCount)
      const gitStatus = generateGitStatus(paths, budget.gitStatusCount)
      const parsedDiffFiles = parsePatchFiles(generatePatch(budget.diffFileCount, budget.diffLinesPerFile))
        .flatMap((patch) => patch.files)
      const mountedDiffFiles = parsedDiffFiles.slice(0, budget.mountedDiffFileCount)
      const tree = new FileTree({
        density: 'compact',
        flattenEmptyDirectories: true,
        initialExpansion: 0,
        itemHeight: 26,
        paths: [],
        presorted: true,
        search: false,
        gitStatus: [],
      })
      tree.render({ containerWrapper: document.getElementById('tree') })

      const diffRoot = createRoot(document.getElementById('diff'))
      const { terminal, webglActive } = createTerminal()
      await new Promise((resolve) => terminal.write('warmup\\r\\n', resolve))
      await nextFrame()

      const terminalData = generateTerminalData(budget.terminalMiB * 1024 * 1024)
      const sampler = startFrameSampler()
      const startedAt = performance.now()
      const terminalPromise = writeTerminalOutput(terminal, terminalData, budget.terminalChunkKiB * 1024)

      await nextFrame()
      tree.resetPaths(paths)
      tree.setGitStatus(gitStatus)
      diffRoot.render(React.createElement(DiffPanel, { files: mountedDiffFiles }))
      tree.scrollToPath(paths[paths.length - 1], { offset: 'nearest' })

      const terminalDurationMs = await terminalPromise
      await nextFrame()
      await nextFrame()
      const frames = await sampler.stop()
      const durationMs = performance.now() - startedAt
      const sample = {
        durationMs,
        terminalBytes: terminalData.length,
        terminalThroughputMBps: budget.terminalMiB / (terminalDurationMs / 1000),
        p95FrameMs: percentile(frames, 0.95),
        maxFrameMs: frames.length === 0 ? 0 : Math.max(...frames),
        framesOver16: frames.filter((value) => value > 16.7).length,
        framesOver50: frames.filter((value) => value > 50).length,
        domNodes: countDomNodes(document.body),
        pathCount: paths.length,
        diffFileCount: parsedDiffFiles.length,
        mountedDiffFileCount: mountedDiffFiles.length,
        webglActive,
      }

      diffRoot.unmount()
      tree.cleanUp()
      terminal.dispose()
      ipcRenderer.send('bench:done', sample)
    })().catch((error) => {
      ipcRenderer.send('bench:error', String(error && error.stack ? error.stack : error))
    })
  `
}

function waitForResult(timeoutMs = 120_000): Promise<CombinedRendererSample> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for combined renderer benchmark result'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      ipcMain.removeListener('bench:done', done)
      ipcMain.removeListener('bench:error', error)
    }

    const done = (_event: IpcMainEvent, sample: CombinedRendererSample) => {
      cleanup()
      resolve(sample)
    }

    const error = (_event: IpcMainEvent, message: string) => {
      cleanup()
      reject(new Error(message))
    }

    ipcMain.once('bench:done', done)
    ipcMain.once('bench:error', error)
  })
}

function printResult(sample: CombinedRendererSample): void {
  console.log('Tau combined renderer pressure benchmark')
  console.log(
    `paths: ${sample.pathCount}, diff files: ${sample.diffFileCount}, mounted diffs: ${sample.mountedDiffFileCount}, terminal bytes: ${sample.terminalBytes}`,
  )
  console.log('')
  console.log(`duration ms: ${sample.durationMs.toFixed(2)}`)
  console.log(`terminal throughput MB/s: ${sample.terminalThroughputMBps.toFixed(2)}`)
  console.log(`p95 frame ms: ${sample.p95FrameMs.toFixed(2)}`)
  console.log(`max frame ms: ${sample.maxFrameMs.toFixed(2)}`)
  console.log(`frames >16ms: ${sample.framesOver16}`)
  console.log(`frames >50ms: ${sample.framesOver50}`)
  console.log(`DOM nodes: ${sample.domNodes}`)
  console.log(`WebGL addon active: ${sample.webglActive ? 'yes' : 'no'}`)
  console.log('')
  console.log(
    `Budget: duration <= ${budget.maxDurationMs} ms, terminal >= ${budget.minTerminalMBps} MB/s, p95 <= ${budget.maxP95FrameMs} ms, max frame <= ${budget.maxFrameMs} ms, >16ms <= ${budget.maxFramesOver16}, >50ms <= ${budget.maxFramesOver50}, DOM nodes <= ${budget.maxDomNodes}, enforce=${budget.enforce ? 'yes' : 'no'}`,
  )
}

function assertBudget(sample: CombinedRendererSample): void {
  if (!budget.enforce) return
  if (!sample.webglActive)
    throw new Error('WebGL addon was not active during combined renderer benchmark')
  if (sample.durationMs > budget.maxDurationMs) {
    throw new Error(
      `combined renderer duration above budget: ${sample.durationMs.toFixed(2)} ms > ${budget.maxDurationMs}`,
    )
  }
  if (sample.terminalThroughputMBps < budget.minTerminalMBps) {
    throw new Error(
      `combined renderer terminal throughput below budget: ${sample.terminalThroughputMBps.toFixed(2)} MB/s < ${budget.minTerminalMBps}`,
    )
  }
  if (sample.p95FrameMs > budget.maxP95FrameMs) {
    throw new Error(
      `combined renderer p95 frame above budget: ${sample.p95FrameMs.toFixed(2)} ms > ${budget.maxP95FrameMs}`,
    )
  }
  if (sample.maxFrameMs > budget.maxFrameMs) {
    throw new Error(
      `combined renderer max frame above budget: ${sample.maxFrameMs.toFixed(2)} ms > ${budget.maxFrameMs}`,
    )
  }
  if (sample.framesOver16 > budget.maxFramesOver16) {
    throw new Error(
      `combined renderer >16ms frames above budget: ${sample.framesOver16} > ${budget.maxFramesOver16}`,
    )
  }
  if (sample.framesOver50 > budget.maxFramesOver50) {
    throw new Error(
      `combined renderer >50ms frames above budget: ${sample.framesOver50} > ${budget.maxFramesOver50}`,
    )
  }
  if (sample.domNodes > budget.maxDomNodes) {
    throw new Error(
      `combined renderer DOM nodes above budget: ${sample.domNodes} > ${budget.maxDomNodes}`,
    )
  }
}

async function main(): Promise<void> {
  await app.whenReady()

  const tempDir = mkdtempSync(resolve(tmpdir(), 'tau-combined-renderer-bench-'))
  const htmlPath = resolve(tempDir, 'index.html')
  const rendererPath = resolve(tempDir, 'renderer.js')
  writeFileSync(htmlPath, rendererHtml())
  await build({
    bundle: true,
    external: ['electron'],
    format: 'iife',
    logLevel: 'silent',
    outfile: rendererPath,
    platform: 'browser',
    stdin: {
      contents: rendererScript(budget),
      loader: 'tsx',
      resolveDir: process.cwd(),
      sourcefile: 'combined-renderer.tsx',
    },
  })

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false,
      webgl: true,
    },
  })

  try {
    const resultPromise = waitForResult()
    await win.loadFile(htmlPath)
    const sample = await resultPromise
    printResult(sample)
    assertBudget(sample)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

  win.destroy()
  app.quit()
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
