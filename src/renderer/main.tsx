import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import 'react-mosaic-component/react-mosaic-component.css'
import './styles.css'

// ── Suppress ghostty-vt OSC warnings ──
// nvim sends OSC queries (11;?, 12;?, 22;, 66;*, 112) and ghostty-web's
// WASM layer logs a warning for each because no OSC allocator is configured.
// These are cosmetic — nvim falls back to defaults — but they spam the console.
// We silence them so real errors aren't buried.
{
  const originalWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    const msg = args.join(' ')
    if (msg.includes('[ghostty-vt]') && msg.includes('warning(osc)')) return
    if (msg.includes('[ghostty-vt]') && msg.includes('invalid OSC')) return
    originalWarn(...args)
  }
}

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Missing #root element')
}

createRoot(rootElement).render(<App />)
