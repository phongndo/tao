import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * Bundle the built taod binary beside Electron's main output so production
 * builds do not depend on a source-tree-relative Zig artifact.
 */
function copyTaodBinary() {
  let outDir = ''

  return {
    name: 'copy-taod-binary',
    configResolved(config: any) {
      outDir = config.build.outDir
    },
    closeBundle() {
      if (process.env.TAOD_SKIP_NATIVE === '1') {
        console.warn('[copy-taod-binary] Skipping taod copy; TAOD_SKIP_NATIVE=1')
        return
      }

      if (process.platform === 'win32') {
        console.warn('[copy-taod-binary] Skipping taod copy on Windows; taod is POSIX-only')
        return
      }

      const exeName = 'taod'
      const taodSource = resolve(__dirname, '../daemon/zig-out/bin', exeName)
      const taodDestDir = resolve(outDir, '../bin')
      const taodDest = resolve(taodDestDir, exeName)

      if (!existsSync(taodSource)) {
        throw new Error(`[copy-taod-binary] taod source not found: ${taodSource}`)
      }

      mkdirSync(taodDestDir, { recursive: true })
      copyFileSync(taodSource, taodDest)
      chmodSync(taodDest, 0o755)
      console.log('[copy-taod-binary] Copied taod to', taodDest)

      const adaptersSource = resolve(__dirname, '../daemon/adapters')
      const adaptersDest = resolve(outDir, '../adapters')
      if (existsSync(adaptersSource)) {
        rmSync(adaptersDest, { recursive: true, force: true })
        copyDirectory(adaptersSource, adaptersDest)
        console.log('[copy-taod-binary] Copied taod adapters to', adaptersDest)
      }
    },
  }
}

function copyDirectory(source: string, destination: string) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source)) {
    const sourcePath = resolve(source, entry)
    const destinationPath = resolve(destination, basename(entry))
    const stats = statSync(sourcePath)
    if (stats.isDirectory()) {
      copyDirectory(sourcePath, destinationPath)
      continue
    }
    if (!stats.isFile()) continue
    copyFileSync(sourcePath, destinationPath)
    if (process.platform !== 'win32') chmodSync(destinationPath, stats.mode)
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyTaodBinary()],
    build: {
      // node-pty has been removed — taod owns PTY lifecycle
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    publicDir: resolve(__dirname, 'public'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
})
