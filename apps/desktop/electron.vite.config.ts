import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * Custom Vite plugin that copies ghostty-vt.wasm to the renderer output
 * after each build. This is needed because ghostty-web loads the WASM
 * file at runtime via fetch(), so it must be accessible relative to the
 * renderer's index.html.
 */
function copyGhosttyWasm() {
  let outDir = ''

  return {
    name: 'copy-ghostty-wasm',
    configResolved(config: any) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const wasmSource = resolve(__dirname, 'node_modules/ghostty-web/ghostty-vt.wasm')
      const wasmDest = resolve(outDir, 'ghostty-vt.wasm')

      if (!existsSync(wasmSource)) {
        console.warn('[copy-ghostty-wasm] WASM source not found:', wasmSource)
        return
      }

      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true })
      }

      copyFileSync(wasmSource, wasmDest)
      console.log('[copy-ghostty-wasm] Copied ghostty-vt.wasm to', wasmDest)
    },
  }
}

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
      const exeName = process.platform === 'win32' ? 'taod.exe' : 'taod'
      const taodSource = resolve(__dirname, '../daemon/zig-out/bin', exeName)
      const taodDestDir = resolve(outDir, '../bin')
      const taodDest = resolve(taodDestDir, exeName)

      if (!existsSync(taodSource)) {
        throw new Error(`[copy-taod-binary] taod source not found: ${taodSource}`)
      }

      mkdirSync(taodDestDir, { recursive: true })
      copyFileSync(taodSource, taodDest)
      if (process.platform !== 'win32') chmodSync(taodDest, 0o755)
      console.log('[copy-taod-binary] Copied taod to', taodDest)
    },
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
    plugins: [react(), tailwindcss(), copyGhosttyWasm()],
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
