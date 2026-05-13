import { createTerminal } from './terminal'
import './styles.css'

// ── Suppress ghostty-vt OSC warnings ──
// nvim sends OSC queries (11;?, 12;?, 22;, 66;*, 112) and ghostty-web's
// WASM layer logs a warning for each because no OSC allocator is configured.
// These are cosmetic — nvim falls back to defaults — but they spam the console.
// We silence them so real errors aren't buried.
{
  const originalWarn = console.warn.bind(console)
  console.warn = (...args: any[]) => {
    const msg = args.join(' ')
    if (msg.includes('[ghostty-vt]') && msg.includes('warning(osc)')) return
    if (msg.includes('[ghostty-vt]') && msg.includes('invalid OSC')) return
    originalWarn(...args)
  }
}

// Guard against HMR double-initialization (Vite hot reload re-runs this module)
let initialized = false

async function bootstrap() {
  if (initialized) {
    console.log('[renderer] Already initialized, skipping HMR reload')
    return
  }
  initialized = true

  const container = document.getElementById('terminal-container')
  if (!container) return

  // Quick guard: electronAPI must be available
  if (!window.electronAPI) {
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;font-family:monospace;padding:2rem;">
        <pre style="color:#f7768e;">FATAL: window.electronAPI is undefined</pre>
        <p style="color:#9699a8;margin-top:1rem;">Preload script failed. Check DevTools.</p>
      </div>`
    return
  }

  try {
    await createTerminal(container)
    console.log('[renderer] Terminal ready')

    // Signal main process that the terminal is ready → show window
    window.electronAPI.signalReady()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[renderer] Failed:', err)
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;font-family:monospace;padding:2rem;">
        <h2 style="color:#f7768e;margin-bottom:1rem;">Failed to initialize terminal</h2>
        <pre style="color:#a9b1d6;max-width:80%;overflow:auto;">${message}</pre>
      </div>`
  }
}

bootstrap()
