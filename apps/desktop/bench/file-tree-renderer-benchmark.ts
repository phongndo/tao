import { app, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

type FileTreeSample = {
  name: string
  durationMs: number
  maxFrameMs: number
  framesOver50: number
  domNodes: number
  pathCount: number
}

type FileTreeBudget = {
  pathCount: number
  gitStatusCount: number
  maxResetMs: number
  maxFrameMs: number
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

function readNonNegativeNumberEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name] ?? String(fallback)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${name} must be a non-negative number <= ${max}`)
  }
  return parsed
}

const budget: FileTreeBudget = {
  pathCount: readPositiveNumberEnv('TAO_FILE_TREE_BENCH_FILES', 50_000, 1_000_000),
  gitStatusCount: readNonNegativeNumberEnv('TAO_FILE_TREE_BENCH_GIT_STATUS', 1000, 1_000_000),
  maxResetMs: readPositiveNumberEnv('TAO_FILE_TREE_MAX_RESET_MS', 1000, 60_000),
  maxFrameMs: readPositiveNumberEnv('TAO_FILE_TREE_MAX_FRAME_MS', 1000, 60_000),
  maxDomNodes: readPositiveNumberEnv('TAO_FILE_TREE_MAX_DOM_NODES', 750, 1_000_000),
  enforce: process.env.TAO_FILE_TREE_BENCH_ENFORCE === '1',
}

function rendererHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #191919; color: #c9c7cd; }
      #tree { width: 360px; height: 720px; }
    </style>
  </head>
  <body>
    <div id="tree"></div>
    <script src="./renderer.js"></script>
  </body>
</html>`
}

function rendererScript(rendererBudget: FileTreeBudget): string {
  return `
      import { FileTree } from '@pierre/trees'
      const { ipcRenderer } = require('electron')
      const budget = ${JSON.stringify(rendererBudget)}

      function nextFrame() {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()))
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

      async function measure(name, work, container, pathCount) {
        await nextFrame()
        const frames = []
        let running = true
        let previous = performance.now()
        function tick(now) {
          frames.push(now - previous)
          previous = now
          if (running) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        const startedAt = performance.now()
        work()
        const durationMs = performance.now() - startedAt
        await nextFrame()
        await nextFrame()
        running = false
        const domNodes = countDomNodes(container)
        return {
          name,
          durationMs,
          maxFrameMs: frames.length === 0 ? 0 : Math.max(...frames),
          framesOver50: frames.filter((value) => value > 50).length,
          domNodes,
          pathCount,
        }
      }

      ;(async () => {
        const container = document.getElementById('tree')
        const paths = generatePaths(budget.pathCount)
        const gitStatus = generateGitStatus(paths, budget.gitStatusCount)
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
        tree.render({ containerWrapper: container })

        const reset = await measure('resetPaths presorted', () => {
          tree.resetPaths(paths)
        }, container, paths.length)

        const status = await measure('setGitStatus', () => {
          tree.setGitStatus(gitStatus)
        }, container, paths.length)

        const scroll = await measure('scrollToPath last', () => {
          tree.scrollToPath(paths[paths.length - 1], { offset: 'nearest' })
        }, container, paths.length)

        tree.cleanUp()
        ipcRenderer.send('bench:done', [reset, status, scroll])
      })().catch((error) => {
        ipcRenderer.send('bench:error', String(error && error.stack ? error.stack : error))
      })
    `
}

function waitForResults(timeoutMs = 90_000): Promise<FileTreeSample[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for file-tree renderer benchmark results'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      ipcMain.removeListener('bench:done', done)
      ipcMain.removeListener('bench:error', error)
    }

    const done = (_event: IpcMainEvent, samples: FileTreeSample[]) => {
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

function printResults(samples: readonly FileTreeSample[]): void {
  console.log('Tao file-tree renderer benchmark')
  console.log(`paths: ${budget.pathCount}, git status entries: ${budget.gitStatusCount}`)
  console.log('')
  console.log('workload              duration ms  max frame ms  >50ms  DOM nodes')
  for (const sample of samples) {
    console.log(
      [
        sample.name.padEnd(20),
        sample.durationMs.toFixed(2).padStart(11),
        sample.maxFrameMs.toFixed(2).padStart(12),
        String(sample.framesOver50).padStart(6),
        String(sample.domNodes).padStart(9),
      ].join('  '),
    )
  }
  console.log('')
  console.log(
    `Budget: reset <= ${budget.maxResetMs} ms, max frame <= ${budget.maxFrameMs} ms, DOM nodes <= ${budget.maxDomNodes}, enforce=${budget.enforce ? 'yes' : 'no'}`,
  )
}

function assertBudget(samples: readonly FileTreeSample[]): void {
  if (!budget.enforce) return
  const reset = samples.find((sample) => sample.name === 'resetPaths presorted')
  if (!reset) throw new Error('Missing resetPaths sample')
  if (reset.durationMs > budget.maxResetMs) {
    throw new Error(
      `file-tree reset above budget: ${reset.durationMs.toFixed(2)} ms > ${budget.maxResetMs}`,
    )
  }
  for (const sample of samples) {
    if (sample.maxFrameMs > budget.maxFrameMs) {
      throw new Error(
        `${sample.name} max frame above budget: ${sample.maxFrameMs.toFixed(2)} ms > ${budget.maxFrameMs}`,
      )
    }
    if (sample.domNodes > budget.maxDomNodes) {
      throw new Error(
        `${sample.name} DOM nodes above budget: ${sample.domNodes} > ${budget.maxDomNodes}`,
      )
    }
  }
}

async function main(): Promise<void> {
  await app.whenReady()

  const tempDir = mkdtempSync(resolve(tmpdir(), 'tao-file-tree-bench-'))
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
      loader: 'ts',
      resolveDir: process.cwd(),
      sourcefile: 'file-tree-renderer.ts',
    },
  })

  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 760,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false,
    },
  })

  try {
    const resultPromise = waitForResults()
    await win.loadFile(htmlPath)
    const results = await resultPromise
    printResults(results)
    assertBudget(results)
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
