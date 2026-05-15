import type { Terminal } from 'ghostty-web'
import { useEffect, useRef, useState } from 'react'
import { createTerminal, setTerminalCursorVisible } from '../terminal'

type TerminalError = {
  title?: string
  message: string
  detail?: string
}

export function TerminalPane({
  sessionId,
  cwd,
  isActive,
  focusToken,
  onTitleChange,
}: {
  sessionId: string
  cwd?: string
  isActive: boolean
  focusToken: number
  onTitleChange?(title: string): void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const onTitleChangeRef = useRef(onTitleChange)
  const cwdRef = useRef(cwd)
  const [terminalError, setTerminalError] = useState<TerminalError | null>(null)

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])

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
        const terminal = await createTerminal(container, sessionId, {
          cwd: cwdRef.current,
          onTitle: (title) => onTitleChangeRef.current?.(title),
        })
        if (disposed) {
          terminal.dispose()
          return
        }

        terminalRef.current = terminal
        setTerminalCursorVisible(terminal, isActive)
        if (isActive) {
          terminal.focus()
        } else {
          terminal.blur()
        }
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

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    setTerminalCursorVisible(terminal, isActive)
    if (isActive) {
      terminal.focus()
    } else {
      terminal.blur()
    }
  }, [focusToken, isActive])

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
