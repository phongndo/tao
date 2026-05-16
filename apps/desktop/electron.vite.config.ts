import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
