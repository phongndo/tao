#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const electronPackageJsonPath = require.resolve('electron/package.json')
const electronDir = dirname(electronPackageJsonPath)
const electronPackage = JSON.parse(readFileSync(electronPackageJsonPath, 'utf8')) as {
  version: string
}

const platform =
  process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform
const hostPlatform = process.platform
const arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch
const platformPath = getPlatformPath(platform)
const distPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || join(electronDir, 'dist')
const executablePath = join(distPath, platformPath)
const requiredRuntimePath =
  platform === 'darwin'
    ? join(
        distPath,
        'Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework',
      )
    : executablePath
const versionPath = join(distPath, 'version')
const pathTxtPath = join(electronDir, 'path.txt')

const keepAlive = setInterval(() => {}, 60_000)

void main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => clearInterval(keepAlive))

async function main(): Promise<void> {
  if (await isElectronUsable()) return
  await installElectron()
}

async function isElectronUsable(): Promise<boolean> {
  try {
    const [installedVersion, installedPath] = await Promise.all([
      readFile(versionPath, 'utf8'),
      readFile(pathTxtPath, 'utf8'),
    ])

    return (
      installedVersion.trim().replace(/^v/u, '') === electronPackage.version &&
      installedPath === platformPath &&
      existsSync(executablePath) &&
      existsSync(requiredRuntimePath)
    )
  } catch {
    return false
  }
}

async function installElectron(): Promise<void> {
  if (existsSync(executablePath) && existsSync(requiredRuntimePath) && (await isElectronUsable())) {
    await writeInstallMarkers()
    return
  }

  const { downloadArtifact } = require('@electron/get')

  const zipPath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: 'electron',
    force: true,
    cacheRoot: process.env.electron_config_cache,
    platform,
    arch,
  })

  await removePath(distPath)
  await mkdir(distPath, { recursive: true })
  extractZip(zipPath, distPath)
  await writeInstallMarkers()

  if (!(await isElectronUsable())) {
    throw new Error(`Electron install is incomplete at ${electronDir}`)
  }
}

async function removePath(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    return
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `[electron-install] Node rm failed for ${path} on host ${hostPlatform} while installing for ${platform}; falling back to shell removal: ${message}`,
    )
    // Electron's macOS .app bundle can occasionally leave nested framework resources behind
    // during recursive removal in fresh worktrees. Fall back to the platform shell remover so
    // predev/setup can repair a partially extracted Electron install instead of failing.
    if (hostPlatform === 'win32') {
      const target = JSON.stringify(path)
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$ErrorActionPreference = 'Stop'; if (Test-Path -LiteralPath ${target}) { Remove-Item -LiteralPath ${target} -Recurse -Force -ErrorAction Stop }`,
        ],
        { stdio: 'inherit' },
      )
      return
    }

    execFileSync('rm', ['-rf', path], { stdio: 'inherit' })
  }
}

function extractZip(zipPath: string, destinationPath: string): void {
  if (platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$ErrorActionPreference = 'Stop'; Expand-Archive -Force -LiteralPath ${JSON.stringify(
          zipPath,
        )} -DestinationPath ${JSON.stringify(destinationPath)}`,
      ],
      { stdio: 'inherit' },
    )
    return
  }

  execFileSync('unzip', ['-q', zipPath, '-d', destinationPath], { stdio: 'inherit' })
}

async function writeInstallMarkers(): Promise<void> {
  await mkdir(distPath, { recursive: true })
  await Promise.all([
    writeFile(pathTxtPath, platformPath),
    writeFile(versionPath, electronPackage.version),
  ])
}

function getPlatformPath(targetPlatform: string): string {
  switch (targetPlatform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(`Electron builds are not available on platform: ${targetPlatform}`)
  }
}
