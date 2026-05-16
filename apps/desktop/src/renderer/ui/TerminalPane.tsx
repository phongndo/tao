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
  onRestartSession,
}: {
  sessionId: string
  cwd?: string
  isActive: boolean
  focusToken: number
  onTitleChange?(title: string): void
  onRestartSession?(): void
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const onTitleChangeRef = useRef(onTitleChange)
  const cwdRef = useRef(cwd)
  const terminalReadyRef = useRef(false)
  const [terminalError, setTerminalError] = useState<TerminalError | null>(null)
  const [isArchived, setIsArchived] = useState(false)

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])

  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])

  useEffect(() => {
    let disposed = false

    async function mountTerminal() {
      const surface = surfaceRef.current
      if (!surface) return

      if (!window.electronAPI) {
        setTerminalError({
          message: 'FATAL: window.electronAPI is undefined',
          detail: 'Preload script failed. Check DevTools.',
        })
        return
      }

      try {
        setTerminalError(null)
        setIsArchived(false)
        const terminal = await createTerminal(surface, sessionId, {
          cwd: cwdRef.current,
          onTitle: (title) => onTitleChangeRef.current?.(title),
          onArchived: () => {
            if (!disposed) setIsArchived(true)
          },
        })
        if (disposed) {
          terminal.dispose()
          return
        }

        terminalRef.current = terminal
        terminalReadyRef.current = true
        setTerminalCursorVisible(terminal, isActive)
        if (isActive) {
          terminal.focus()
          window.electronAPI.signalReady()
        } else {
          terminal.blur()
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[renderer] Failed:', err)
        setTerminalError({
          title: 'Failed to initialize terminal',
          message,
        })
        // Do not leave the BrowserWindow hidden if terminal initialization failed.
        if (isActive) window.electronAPI.signalReady()
      }
    }

    void mountTerminal()

    return () => {
      disposed = true
      terminalReadyRef.current = false
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
      if (terminalReadyRef.current) window.electronAPI.signalReady()
    } else {
      terminal.blur()
    }
  }, [focusToken, isActive])

  return (
    <div className="terminal-container">
      <div className="terminal-surface" ref={surfaceRef} />
      {terminalError ? (
        <div className="terminal-error">
          {terminalError.title ? <h2>{terminalError.title}</h2> : null}
          <pre>{terminalError.message}</pre>
          {terminalError.detail ? <p>{terminalError.detail}</p> : null}
        </div>
      ) : null}
      {isArchived && !terminalError ? (
        <div className="terminal-archive-banner">
          <span>Archived session</span>
          <button type="button" onClick={onRestartSession} disabled={!onRestartSession}>
            Start fresh shell
          </button>
        </div>
      ) : null}
    </div>
  )
}
