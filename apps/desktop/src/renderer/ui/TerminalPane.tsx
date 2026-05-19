import type { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { FiChevronDown, FiChevronUp, FiSearch, FiX } from 'react-icons/fi'
import type { AttachSessionResult } from '@tao/shared/taod-protocol'
import {
  clearTerminalSearch,
  createTerminal,
  forceTerminalRender,
  onTerminalSearchResults,
  searchTerminalBuffer,
  setTerminalCursorVisible,
} from '../terminal'

type TerminalError = {
  title?: string
  message: string
  detail?: string
}

type ResumeNotice = {
  label: string
  detail: string
}

function resumeNoticeFromAttach(result: AttachSessionResult): ResumeNotice | null {
  if (result.attachMode === 'agent-resume') {
    const provider = result.agentProvider ? `${result.agentProvider} ` : ''
    const nativeId = result.nativeSessionId ? ` (${result.nativeSessionId})` : ''
    return {
      label: 'Agent resumed',
      detail: `Started ${provider}via native resume${nativeId}.`,
    }
  }

  if (result.attachMode === 'command-resume') {
    return {
      label: 'Command relaunched',
      detail: 'The previous live process was gone, so Tao restarted the saved command.',
    }
  }

  return null
}

function renderAfterWindowShown(terminal: Terminal, isCurrent: () => boolean): () => void {
  let frame: number | null = null
  let timer: number | null = null
  let cancelled = false

  void window.electronAPI.signalReady().then(() => {
    if (cancelled || !isCurrent()) return

    // Chromium can drop the initial canvas upload while the BrowserWindow is still hidden.
    // Render again after main confirms the window has been shown so the first visible frame
    // contains the shell prompt instead of a black canvas until the next input echo.
    forceTerminalRender(terminal)
    frame = window.requestAnimationFrame(() => {
      frame = null
      if (!cancelled && isCurrent()) forceTerminalRender(terminal)
    })
    timer = window.setTimeout(() => {
      timer = null
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
        frame = null
      }
      if (!cancelled && isCurrent()) forceTerminalRender(terminal)
    }, 50)
  })

  return () => {
    cancelled = true
    if (frame !== null) window.cancelAnimationFrame(frame)
    if (timer !== null) window.clearTimeout(timer)
  }
}

export function TerminalPane({
  sessionId,
  terminalId,
  workspaceId,
  worktreeId,
  cwd,
  isActive,
  focusToken,
  searchToken,
  onTitleChange,
  onRestartSession,
  onArchiveStateChange,
}: {
  sessionId: string
  terminalId?: string
  workspaceId?: string
  worktreeId?: string
  cwd?: string
  isActive: boolean
  focusToken: number
  searchToken: number
  onTitleChange?(title: string): void
  onRestartSession?(): void
  onArchiveStateChange?(archived: boolean): void
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const onTitleChangeRef = useRef(onTitleChange)
  const onArchiveStateChangeRef = useRef(onArchiveStateChange)
  const cwdRef = useRef(cwd)
  const terminalReadyRef = useRef(false)
  const lastOpenedSearchTokenRef = useRef(0)
  const [terminalError, setTerminalError] = useState<TerminalError | null>(null)
  const [isArchived, setIsArchived] = useState(false)
  const [resumeNotice, setResumeNotice] = useState<ResumeNotice | null>(null)
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState({ resultIndex: -1, resultCount: 0 })

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])

  useEffect(() => {
    onArchiveStateChangeRef.current = onArchiveStateChange
  }, [onArchiveStateChange])

  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])

  useEffect(() => {
    let disposed = false
    let cleanupWindowRender: (() => void) | null = null
    let searchResultsSubscription: { dispose(): void } | null = null

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
        setResumeNotice(null)
        onArchiveStateChangeRef.current?.(false)
        const terminal = await createTerminal(surface, sessionId, {
          terminalId,
          workspaceId,
          worktreeId,
          cwd: cwdRef.current,
          onTitle: (title) => onTitleChangeRef.current?.(title),
          onArchived: () => {
            if (!disposed) {
              setIsArchived(true)
              onArchiveStateChangeRef.current?.(true)
            }
          },
          onAttach: (result) => {
            if (!disposed) setResumeNotice(resumeNoticeFromAttach(result))
          },
        })
        if (disposed) {
          terminal.dispose()
          return
        }

        terminalRef.current = terminal
        terminalReadyRef.current = true
        searchResultsSubscription = onTerminalSearchResults(terminal, (result) => {
          if (!disposed) setSearchResult(result)
        })
        setTerminalCursorVisible(terminal, isActive && !isArchived)
        if (isActive && !isArchived) {
          terminal.focus()
          cleanupWindowRender = renderAfterWindowShown(
            terminal,
            () => !disposed && terminalRef.current === terminal,
          )
        } else {
          terminal.blur()
        }
      } catch (err) {
        if (disposed) {
          if (isActive) void window.electronAPI.signalReady()
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        console.error('[renderer] Failed:', err)
        setTerminalError({
          title: 'Failed to initialize terminal',
          message,
        })
        // Do not leave the BrowserWindow hidden if terminal initialization failed.
        if (isActive) void window.electronAPI.signalReady()
      }
    }

    void mountTerminal()

    return () => {
      disposed = true
      cleanupWindowRender?.()
      searchResultsSubscription?.dispose()
      terminalReadyRef.current = false
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [sessionId, terminalId, workspaceId, worktreeId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    setTerminalCursorVisible(terminal, isActive && !isArchived)
    if (isActive && !isArchived) {
      terminal.focus()
      if (terminalReadyRef.current) {
        return renderAfterWindowShown(terminal, () => terminalRef.current === terminal)
      }
    } else {
      terminal.blur()
    }
  }, [focusToken, isActive, isArchived])

  useEffect(() => {
    if (searchToken <= 0 || searchToken <= lastOpenedSearchTokenRef.current) return
    if (!isActive || isArchived) return

    lastOpenedSearchTokenRef.current = searchToken
    setSearchVisible(true)
  }, [isActive, isArchived, searchToken])

  useEffect(() => {
    if (!searchVisible) return

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [searchToken, searchVisible])

  useEffect(() => {
    if (!isArchived) return

    const terminal = terminalRef.current
    if (terminal) clearTerminalSearch(terminal)
    setSearchVisible(false)
    setSearchResult({ resultIndex: -1, resultCount: 0 })
  }, [isArchived])

  function runSearch(query: string, direction: 'next' | 'previous', incremental = false) {
    const terminal = terminalRef.current
    if (!terminal) return

    if (query.length === 0) {
      clearTerminalSearch(terminal)
      setSearchResult({ resultIndex: -1, resultCount: 0 })
      return
    }

    searchTerminalBuffer(terminal, query, direction, incremental)
  }

  function closeSearch() {
    const terminal = terminalRef.current
    if (terminal) {
      clearTerminalSearch(terminal)
      if (isActive && !isArchived) terminal.focus()
    }
    setSearchVisible(false)
    setSearchResult({ resultIndex: -1, resultCount: 0 })
  }

  const activeSearchIndex = searchResult.resultIndex >= 0 ? searchResult.resultIndex + 1 : 0

  return (
    <div
      className={
        isArchived ? 'terminal-container terminal-container-archived' : 'terminal-container'
      }
    >
      <div className="terminal-surface" ref={surfaceRef} />
      {searchVisible && !isArchived && !terminalError ? (
        <form
          className="terminal-search-panel"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault()
            runSearch(searchQuery, 'next')
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              closeSearch()
            }
          }}
        >
          <FiSearch size={13} aria-hidden="true" />
          <input
            ref={searchInputRef}
            aria-label="Find in terminal"
            value={searchQuery}
            placeholder="Find"
            spellCheck={false}
            onChange={(event) => {
              const nextQuery = event.target.value
              setSearchQuery(nextQuery)
              runSearch(nextQuery, 'next', true)
            }}
          />
          <span className="terminal-search-count" aria-live="polite">
            {searchQuery.length > 0 ? `${activeSearchIndex}/${searchResult.resultCount}` : ''}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            title="Previous match"
            onClick={() => runSearch(searchQuery, 'previous')}
          >
            <FiChevronUp size={14} />
          </button>
          <button
            type="button"
            aria-label="Next match"
            title="Next match"
            onClick={() => runSearch(searchQuery, 'next')}
          >
            <FiChevronDown size={14} />
          </button>
          <button
            type="button"
            aria-label="Close search"
            title="Close search"
            onClick={closeSearch}
          >
            <FiX size={14} />
          </button>
        </form>
      ) : null}
      {terminalError ? (
        <div className="terminal-error">
          {terminalError.title ? <h2>{terminalError.title}</h2> : null}
          <pre>{terminalError.message}</pre>
          {terminalError.detail ? <p>{terminalError.detail}</p> : null}
        </div>
      ) : null}
      {isArchived && !terminalError ? (
        <div className="terminal-archive-banner">
          <span className="terminal-archive-label">Read-only archive</span>
          <span className="terminal-archive-detail">Input is ignored until you start fresh.</span>
          <button type="button" onClick={onRestartSession} disabled={!onRestartSession}>
            Start fresh shell
          </button>
        </div>
      ) : null}
      {resumeNotice && !isArchived && !terminalError ? (
        <div className="terminal-resume-banner">
          <span className="terminal-resume-label">{resumeNotice.label}</span>
          <span className="terminal-resume-detail">{resumeNotice.detail}</span>
        </div>
      ) : null}
    </div>
  )
}
