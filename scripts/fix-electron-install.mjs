#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const electronPackageJsonPath = require.resolve('electron/package.json')
const electronDir = dirname(electronPackageJsonPath)
const electronPackage = JSON.parse(readFileSync(electronPackageJsonPath, 'utf8'))

const platform =
  process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform
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

async function main() {
  if (await isElectronUsable()) return
  await installElectron()
}

async function isElectronUsable() {
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

async function installElectron() {
  if (existsSync(executablePath) && existsSync(requiredRuntimePath)) {
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

  await rm(distPath, { recursive: true, force: true })
  await mkdir(distPath, { recursive: true })
  execFileSync('unzip', ['-q', zipPath, '-d', distPath], { stdio: 'inherit' })
  await writeInstallMarkers()

  if (!(await isElectronUsable())) {
    throw new Error(`Electron install is incomplete at ${electronDir}`)
  }
}

async function writeInstallMarkers() {
  await mkdir(distPath, { recursive: true })
  await Promise.all([
    writeFile(pathTxtPath, platformPath),
    writeFile(versionPath, electronPackage.version),
  ])
}

function getPlatformPath(targetPlatform) {
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
