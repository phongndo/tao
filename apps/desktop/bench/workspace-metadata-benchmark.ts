/**
 * Tao - workspace metadata benchmark through taod.
 *
 * Builds a synthetic Git workspace, launches managed taod, then times the
 * daemon-backed workspace metadata RPCs that used to risk blocking Electron main.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveTaoStoragePaths } from '@tao/shared/storage-path'

type ControlResponse = Record<string, unknown>

type ManagedTaod = {
  readonly home: string
  readonly child: ChildProcess
  readonly cleanup: () => Promise<void>
}

type Metric = {
  readonly name: string
  readonly durationMs: number
  readonly responseBytes: number
  readonly maxMs: number
}

const execFileAsync = promisify(execFile)

const benchDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(benchDir, '..')
const repoRoot = resolve(desktopRoot, '../..')

const FILE_COUNT = positiveInt(process.env.TAO_WORKSPACE_BENCH_FILES, 5000)
const ENFORCE = process.env.TAO_WORKSPACE_BENCH_ENFORCE === '1'
const MAX_BRANCHES_MS = nonNegativeInt(process.env.TAO_WORKSPACE_MAX_BRANCHES_MS, 500)
const MAX_STATUS_MS = nonNegativeInt(process.env.TAO_WORKSPACE_MAX_STATUS_MS, 1000)
const MAX_FILE_TREE_MS = nonNegativeInt(process.env.TAO_WORKSPACE_MAX_FILE_TREE_MS, 2500)
const MAX_DIFF_MS = nonNegativeInt(process.env.TAO_WORKSPACE_MAX_DIFF_MS, 1000)
const MAX_PORTS_MS = nonNegativeInt(process.env.TAO_WORKSPACE_MAX_PORTS_MS, 1000)
const MAX_PR_MS = nonNegativeInt(process.env.TAO_WORKSPACE_MAX_PR_MS, 2000)
const GIT_TIMEOUT_MS = positiveInt(process.env.TAO_WORKSPACE_BENCH_GIT_TIMEOUT_MS, 30_000)

let socketPath =
  process.env.TAOD_SOCKET_PATH || resolveTaoStoragePaths(process.env.HOME || homedir()).socket

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function now(): number {
  return performance.now()
}

function findTaodBinary(): string | null {
  const exeName = process.platform === 'win32' ? 'taod.exe' : 'taod'
  const candidates = [
    process.env.TAOD_PATH,
    resolve(desktopRoot, 'out/bin', exeName),
    resolve(repoRoot, 'apps/daemon/zig-out/bin', exeName),
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function connectSocket(timeoutMs = 3000): Promise<net.Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = net.createConnection(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      rejectSocket(new Error(`Timed out connecting to taod at ${socketPath}`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolveSocket(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      rejectSocket(error)
    })
  })
}

async function writeAll(socket: net.Socket, payload: string, context: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const cleanup = () => {
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error: Error) => {
      cleanup()
      rejectWrite(error)
    }
    const onClose = () => {
      cleanup()
      rejectWrite(new Error(`taod closed socket while writing ${context}`))
    }
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.write(payload, (error) => {
      cleanup()
      if (error) rejectWrite(error)
      else resolveWrite()
    })
  })
}

function sendJson(
  socket: net.Socket,
  request: Record<string, unknown>,
): Promise<{ response: ControlResponse; rawBytes: number }> {
  return new Promise((resolveResponse, rejectResponse) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      rejectResponse(new Error('Timeout waiting for taod response'))
    }, 15_000)

    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error: Error) => {
      cleanup()
      rejectResponse(error)
    }
    const onClose = () => {
      cleanup()
      rejectResponse(new Error('taod closed socket before responding'))
    }
    const onData = (chunk: Buffer) => {
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline === -1) return
      cleanup()
      try {
        const responseBytes = newline + 1
        const response = JSON.parse(buffered.subarray(0, newline).toString('utf8'))
        resolveResponse({ response, rawBytes: responseBytes })
      } catch {
        rejectResponse(new Error('Failed to parse taod response'))
      }
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    void writeAll(socket, `${JSON.stringify(request)}\n`, 'control request').catch((error) => {
      cleanup()
      rejectResponse(error)
    })
  })
}

async function closeSocket(socket: net.Socket): Promise<void> {
  socket.end()
  socket.destroy()
}

async function control(
  request: Record<string, unknown>,
): Promise<{ response: ControlResponse; rawBytes: number }> {
  const socket = await connectSocket()
  try {
    return await sendJson(socket, request)
  } finally {
    await closeSocket(socket)
  }
}

async function startManagedTaod(): Promise<ManagedTaod> {
  const binaryPath = findTaodBinary()
  if (!binaryPath) throw new Error('taod binary not found; run pnpm --filter @tao/desktop build')

  const home = mkdtempSync(resolve(tmpdir(), 'tao-workspace-bench-home-'))
  socketPath = resolveTaoStoragePaths(home).socket
  const adapters = resolve(desktopRoot, 'out/adapters')
  const child = spawn(binaryPath, [], {
    cwd: dirname(binaryPath),
    env: {
      ...process.env,
      HOME: home,
      TAOD_ADAPTER_DIR: adapters,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[taod stderr] ${chunk.toString('utf8')}`)
  })

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const ping = await control({ type: 'ping', id: 'workspace-managed-ping' })
      if (ping.response.ok) {
        return {
          home,
          child,
          cleanup: async () => {
            if (child.exitCode === null && !child.killed) {
              child.kill('SIGTERM')
              await Promise.race([
                new Promise((resolveExit) => child.once('exit', resolveExit)),
                sleep(1000),
              ])
              if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
            }
            rmSync(home, { recursive: true, force: true })
          },
        }
      }
    } catch {
      if (child.exitCode !== null) {
        rmSync(home, { recursive: true, force: true })
        throw new Error(`managed taod exited before socket became ready: ${child.exitCode}`)
      }
      await sleep(50)
    }
  }

  child.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
  throw new Error('managed taod failed to start')
}

async function git(repo: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], {
    cwd: repo,
    timeout: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  })
}

async function createSyntheticRepo(): Promise<{ root: string; cleanup: () => void }> {
  const root = mkdtempSync(resolve(tmpdir(), 'tao-workspace-bench-repo-'))
  try {
    await git(root, ['init', '-q'])
    await git(root, ['config', 'user.email', 'tao-bench@example.invalid'])
    await git(root, ['config', 'user.name', 'Tao Bench'])

    for (let index = 0; index < FILE_COUNT; index++) {
      const dir = resolve(root, 'src', String(index % 100).padStart(3, '0'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        resolve(dir, `file-${String(index).padStart(6, '0')}.txt`),
        `file ${index}\n${'x'.repeat(64)}\n`,
      )
    }
    await git(root, ['add', '.'])
    await git(root, ['commit', '-q', '-m', 'initial synthetic workspace'])

    writeFileSync(resolve(root, 'src/000/file-000000.txt'), `modified\n${'y'.repeat(64)}\n`)
    writeFileSync(resolve(root, 'untracked-smoke.txt'), 'untracked\n')

    return {
      root,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

async function measure(
  name: string,
  request: Record<string, unknown>,
  maxMs: number,
): Promise<Metric> {
  const startedAt = now()
  const { response, rawBytes } = await control(request)
  const durationMs = now() - startedAt
  if (!response.ok) {
    throw new Error(`${name} failed: ${String(response.error_message ?? 'unknown error')}`)
  }
  return { name, durationMs, responseBytes: rawBytes, maxMs }
}

function budgetFailures(metrics: readonly Metric[]): string[] {
  if (!ENFORCE) return []
  const failures: string[] = []
  for (const metric of metrics) {
    if (metric.maxMs <= 0 || metric.durationMs <= metric.maxMs) continue
    failures.push(
      `${metric.name} above budget: ${metric.durationMs.toFixed(2)} ms > ${metric.maxMs} ms`,
    )
  }
  return failures
}

async function runWorkspaceMetadataBenchmark(): Promise<void> {
  const managed = await startManagedTaod()
  const repo = await createSyntheticRepo()

  try {
    console.log('Tao workspace metadata benchmark (taod)')
    console.log('')
    console.log(`  Files:    ${FILE_COUNT}`)
    console.log(`  Repo:     ${repo.root}`)
    console.log(`  Socket:   ${socketPath}`)
    console.log(`  Platform: ${platform()} ${process.arch}`)
    console.log(`  Enforce:  ${ENFORCE ? 'yes' : 'no'}`)
    console.log(`  Git setup timeout: ${GIT_TIMEOUT_MS} ms`)
    console.log('')

    const requests: Array<{ name: string; request: Record<string, unknown>; maxMs: number }> = [
      {
        name: 'workspace.branches',
        request: { type: 'workspace.branches', id: 'workspace-branches', rootPath: repo.root },
        maxMs: MAX_BRANCHES_MS,
      },
      {
        name: 'workspace.status',
        request: { type: 'workspace.status', id: 'workspace-status', rootPath: repo.root },
        maxMs: MAX_STATUS_MS,
      },
      {
        name: 'workspace.fileTree',
        request: { type: 'workspace.fileTree', id: 'workspace-file-tree', rootPath: repo.root },
        maxMs: MAX_FILE_TREE_MS,
      },
      {
        name: 'workspace.diff',
        request: {
          type: 'workspace.diff',
          id: 'workspace-diff',
          rootPath: repo.root,
          scope: 'all',
        },
        maxMs: MAX_DIFF_MS,
      },
      {
        name: 'workspace.ports',
        request: { type: 'workspace.ports', id: 'workspace-ports', rootPath: repo.root },
        maxMs: MAX_PORTS_MS,
      },
      {
        name: 'workspace.pullRequest',
        request: { type: 'workspace.pullRequest', id: 'workspace-pr', rootPath: repo.root },
        maxMs: MAX_PR_MS,
      },
    ]

    const metrics: Metric[] = []
    for (const item of requests) {
      metrics.push(await measure(item.name, item.request, item.maxMs))
    }

    console.log('Results')
    for (const metric of metrics) {
      const budget = metric.maxMs > 0 ? `budget ${metric.maxMs} ms` : 'no budget'
      console.log(
        `  ${metric.name.padEnd(22)} ${metric.durationMs.toFixed(2).padStart(8)} ms  ${String(metric.responseBytes).padStart(9)} bytes  ${budget}`,
      )
    }
    console.log('')

    const failures = budgetFailures(metrics)
    if (failures.length > 0) {
      throw new Error(failures.join('\n'))
    }
  } finally {
    repo.cleanup()
    await managed.cleanup()
  }
}

runWorkspaceMetadataBenchmark().catch((error: unknown) => {
  console.error('\nBenchmark failed:', error)
  process.exit(1)
})
