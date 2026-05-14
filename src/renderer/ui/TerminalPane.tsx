import { useEffect, useRef } from 'react'
import type { Terminal } from 'ghostty-web'
import { createTerminal } from '../terminal'

export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)

  useEffect(() => {
    let disposed = false

    async function mountTerminal() {
      const container = containerRef.current
      if (!container) return

      if (!window.electronAPI) {
        container.innerHTML = `
          <div class="terminal-error">
            <pre>FATAL: window.electronAPI is undefined</pre>
            <p>Preload script failed. Check DevTools.</p>
          </div>`
        return
      }

      try {
        const terminal = await createTerminal(container)
        if (disposed) {
          terminal.dispose()
          return
        }

        terminalRef.current = terminal
        console.log('[renderer] Terminal ready')
        window.electronAPI.signalReady()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[renderer] Failed:', err)
        container.innerHTML = `
          <div class="terminal-error">
            <h2>Failed to initialize terminal</h2>
            <pre>${message}</pre>
          </div>`
        // Do not leave the BrowserWindow hidden if terminal initialization failed.
        window.electronAPI.signalReady()
      }
    }

    void mountTerminal()

    return () => {
      disposed = true
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [])

  return <div id="terminal-container" ref={containerRef} />
}
