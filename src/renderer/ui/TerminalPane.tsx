import type { Terminal } from 'ghostty-web'
import { useEffect, useRef, useState } from 'react'
import { createTerminal } from '../terminal'

type TerminalError = {
  title?: string
  message: string
  detail?: string
}

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const [terminalError, setTerminalError] = useState<TerminalError | null>(null)

  useEffect(() => {
    let disposed = false

    async function mountTerminal() {
      const container = containerRef.current
      if (!container) return

      if (!window.electronAPI) {
        setTerminalError({
          message: 'FATAL: window.electronAPI is undefined',
          detail: 'Preload script failed. Check DevTools.',
        })
        return
      }

      try {
        setTerminalError(null)
        const terminal = await createTerminal(container, sessionId)
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
        setTerminalError({
          title: 'Failed to initialize terminal',
          message,
        })
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
  }, [sessionId])

  return (
    <div className="terminal-container" ref={containerRef}>
      {terminalError ? (
        <div className="terminal-error">
          {terminalError.title ? <h2>{terminalError.title}</h2> : null}
          <pre>{terminalError.message}</pre>
          {terminalError.detail ? <p>{terminalError.detail}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
