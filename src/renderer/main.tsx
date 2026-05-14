import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
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

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Missing #root element')
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 10 * 60 * 1000,
      retry: 1,
      staleTime: 5 * 60 * 1000,
    },
  },
})

createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
)
