import {
  chmodSync,
  copyFileSync,
  createReadStream,
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
 * Bundle the built taud binary beside Electron's main output so production
 * builds do not depend on a source-tree-relative Zig artifact.
 */
function copyTaudBinary() {
  let outDir = ''

  return {
    name: 'copy-taud-binary',
    configResolved(config: any) {
      outDir = config.build.outDir
    },
    closeBundle() {
      if (process.env.TAUD_SKIP_NATIVE === '1') {
        console.warn('[copy-taud-binary] Skipping taud copy; TAUD_SKIP_NATIVE=1')
        return
      }

      if (process.platform === 'win32') {
        console.warn('[copy-taud-binary] Skipping taud copy on Windows; taud is POSIX-only')
        return
      }

      const exeName = 'taud'
      const taudSource = resolve(__dirname, '../daemon/zig-out/bin', exeName)
      const taudDestDir = resolve(outDir, '../bin')
      const taudDest = resolve(taudDestDir, exeName)

      if (!existsSync(taudSource)) {
        throw new Error(`[copy-taud-binary] taud source not found: ${taudSource}`)
      }

      mkdirSync(taudDestDir, { recursive: true })
      copyFileSync(taudSource, taudDest)
      chmodSync(taudDest, 0o755)
      console.log('[copy-taud-binary] Copied taud to', taudDest)

      const adaptersSource = resolve(__dirname, '../daemon/adapters')
      const adaptersDest = resolve(outDir, '../adapters')
      if (existsSync(adaptersSource)) {
        rmSync(adaptersDest, { recursive: true, force: true })
        copyDirectory(adaptersSource, adaptersDest)
        console.log('[copy-taud-binary] Copied taud adapters to', adaptersDest)
      }
    },
  }
}

function exposeNightlyAssets() {
  let outDir = ''
  const nightlyAssetsSource = resolve(__dirname, '../../assets/nightly')

  return {
    name: 'expose-nightly-assets',
    configResolved(config: any) {
      outDir = config.build.outDir
    },
    configureServer(server: any) {
      server.middlewares.use(
        '/nightly',
        (request: any, response: any, next: (error?: unknown) => void) => {
          let requestPath = ''
          try {
            requestPath = decodeURIComponent(String(request.url ?? '').split('?')[0] ?? '')
              .replace(/^\/+/u, '')
              .trim()
          } catch {
            next()
            return
          }
          if (!requestPath || requestPath.includes('/') || requestPath.includes('\\')) {
            next()
            return
          }

          const assetPath = resolve(nightlyAssetsSource, requestPath)
          if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
            next()
            return
          }

          if (requestPath.endsWith('.png')) response.setHeader('Content-Type', 'image/png')
          const stream = createReadStream(assetPath)
          stream.on('error', (error) => {
            if (response.headersSent) {
              response.destroy(error)
              return
            }
            next(error)
          })
          stream.pipe(response)
        },
      )
    },
    closeBundle() {
      if (!existsSync(nightlyAssetsSource)) {
        throw new Error(`[expose-nightly-assets] nightly assets not found: ${nightlyAssetsSource}`)
      }

      const nightlyAssetsDest = resolve(outDir, 'nightly')
      rmSync(nightlyAssetsDest, { recursive: true, force: true })
      copyDirectory(nightlyAssetsSource, nightlyAssetsDest)
      console.log('[expose-nightly-assets] Copied nightly assets to', nightlyAssetsDest)
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
    plugins: [externalizeDepsPlugin(), copyTaudBinary()],
    build: {
      // node-pty has been removed — taud owns PTY lifecycle
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss(), exposeNightlyAssets()],
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
