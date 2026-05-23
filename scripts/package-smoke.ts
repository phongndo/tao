#!/usr/bin/env tsx
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as string

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = resolve(repoRoot, 'apps/desktop')
const outRoot = resolve(desktopRoot, 'out')
const taodPath = resolve(outRoot, 'bin', process.platform === 'win32' ? 'taod.exe' : 'taod')
const adaptersRoot = resolve(outRoot, 'adapters')

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const ELECTRON_SMOKE_PROCESS_TIMEOUT_MS = positiveIntEnv(
  'TAO_ELECTRON_SMOKE_PROCESS_TIMEOUT_MS',
  20_000,
)
const ELECTRON_SMOKE_MAX_LAUNCH_MS = nonNegativeIntEnv('TAO_ELECTRON_SMOKE_MAX_LAUNCH_MS', 0)
const ELECTRON_SMOKE_PROGRESS_TIMEOUT_MS = nonNegativeIntEnv(
  'TAO_ELECTRON_SMOKE_PROGRESS_TIMEOUT_MS',
  process.env.TAO_ELECTRON_SMOKE_RELOAD_DURATION_MS ? 180_000 : 0,
)

function fail(message: string): never {
  console.error(`[package-smoke] ${message}`)
  process.exit(1)
}

function assertFile(path: string, label: string): void {
  let stats
  try {
    stats = statSync(path)
  } catch {
    fail(`${label} is missing: ${path}`)
  }
  if (!stats.isFile()) fail(`${label} is not a file: ${path}`)
}

function assertExecutable(path: string, label: string): void {
  assertFile(path, label)
  if (process.platform === 'win32') return
  try {
    accessSync(path, constants.X_OK)
  } catch {
    fail(`${label} is not executable: ${path}`)
  }
}

function assertPackageLayout(): void {
  assertFile(resolve(outRoot, 'main/index.js'), 'main bundle')
  assertFile(resolve(outRoot, 'preload/index.mjs'), 'preload bundle')
  assertFile(resolve(outRoot, 'renderer/index.html'), 'renderer entrypoint')
  assertExecutable(taodPath, 'taod binary')

  for (const adapter of ['claude.ts', 'codex.ts', 'pi.ts']) {
    assertFile(resolve(adaptersRoot, adapter), `taod adapter ${adapter}`)
  }
}

function runTaodCheck(): void {
  const home = mkdtempSync(resolve(tmpdir(), 'tao-package-smoke-'))
  try {
    const result = spawnSync(taodPath, ['--check'], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        HOME: home,
        TAOD_ADAPTER_DIR: adaptersRoot,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })

    if (result.error) fail(`taod --check failed to start: ${result.error.message}`)
    if (result.status !== 0) {
      const stderr = result.stderr.trim()
      const stdout = result.stdout.trim()
      fail(
        `taod --check exited with ${result.status}${stderr ? `\nstderr:\n${stderr}` : ''}${
          stdout ? `\nstdout:\n${stdout}` : ''
        }`,
      )
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function childPids(pid: number): number[] {
  if (process.platform === 'win32') return []
  const result = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0)
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  for (const childPid of childPids(pid)) killProcessTree(childPid, signal)
  try {
    process.kill(pid, signal)
  } catch {
    // Process already exited.
  }
}

function runElectronLaunchSmoke(): Promise<void> {
  const home = mkdtempSync(resolve(tmpdir(), 'tao-electron-smoke-'))
  return new Promise((resolveSmoke, rejectSmoke) => {
    let stdout = ''
    let stderr = ''
    let stdoutLineBuffer = ''
    let settled = false
    let sawPass = false
    let lastProgressAt = Date.now()
    const launchedAt = Date.now()

    const child = spawn(electronPath, ['.'], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        HOME: home,
        TAO_ELECTRON_SMOKE: '1',
        TAOD_ADAPTER_DIR: adaptersRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const cleanup = () => {
      clearTimeout(timeout)
      clearInterval(progressTimeout)
      rmSync(home, { recursive: true, force: true })
    }

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (child.exitCode === null && !child.killed) {
        if (typeof child.pid === 'number') {
          killProcessTree(child.pid, 'SIGKILL')
        } else {
          child.kill('SIGKILL')
        }
      }
      cleanup()
      if (error) {
        rejectSmoke(error)
      } else {
        resolveSmoke()
      }
    }

    const formatFailure = (message: string): Error =>
      new Error(
        `${message}${stderr.trim() ? `\nstderr:\n${stderr.trim()}` : ''}${
          stdout.trim() ? `\nstdout:\n${stdout.trim()}` : ''
        }`,
      )

    const timeout = setTimeout(() => {
      finish(formatFailure('Electron launch smoke timed out'))
    }, ELECTRON_SMOKE_PROCESS_TIMEOUT_MS)
    const progressTimeout = setInterval(() => {
      if (
        ELECTRON_SMOKE_PROGRESS_TIMEOUT_MS > 0 &&
        Date.now() - lastProgressAt > ELECTRON_SMOKE_PROGRESS_TIMEOUT_MS
      ) {
        finish(
          formatFailure(
            `Electron launch smoke made no progress for ${Date.now() - lastProgressAt} ms`,
          ),
        )
      }
    }, 5000)

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text
      stdoutLineBuffer += text
      const lines = stdoutLineBuffer.split(/\r?\n/)
      stdoutLineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.includes('[electron-smoke] progress')) {
          lastProgressAt = Date.now()
          console.log(line)
        }
        if (line.includes('[electron-smoke] trace')) {
          lastProgressAt = Date.now()
          console.log(line)
        }
        if (line.includes('[electron-smoke] passed') && !sawPass) {
          sawPass = true
          lastProgressAt = Date.now()
          const launchMs = Date.now() - launchedAt
          if (ELECTRON_SMOKE_MAX_LAUNCH_MS > 0 && launchMs > ELECTRON_SMOKE_MAX_LAUNCH_MS) {
            finish(
              formatFailure(
                `Electron launch smoke above process budget: ${launchMs} ms > ${ELECTRON_SMOKE_MAX_LAUNCH_MS} ms`,
              ),
            )
            return
          }
          console.log(line)
          console.log(`[package-smoke] Electron launch smoke completed in ${launchMs} ms`)
          setTimeout(() => finish(), 1000).unref?.()
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      finish(formatFailure(`Electron launch smoke failed to start: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      if (sawPass) {
        finish()
        return
      }
      finish(formatFailure(`Electron launch smoke exited with ${code ?? signal ?? 'unknown'}`))
    })
  })
}

if (process.env.TAOD_SKIP_NATIVE === '1') {
  fail('TAOD_SKIP_NATIVE=1 cannot produce a package with taod; do not publish this artifact')
}
if (process.platform === 'win32') {
  fail('Windows package smoke is unsupported while taod is POSIX-only')
}

assertPackageLayout()
runTaodCheck()
runElectronLaunchSmoke()
  .then(() => {
    console.log('[package-smoke] packaged taod, adapters, and Electron launch passed smoke checks')
  })
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error))
  })
