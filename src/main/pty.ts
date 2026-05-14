import * as pty from 'node-pty'

export interface PtyExitInfo {
  exitCode: number
  signal?: number
}

type DataCallback = (data: string) => void
type ExitCallback = (info: PtyExitInfo) => void

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export class PtyManager {
  private ptyProcess: pty.IPty
  private dataCallbacks: DataCallback[] = []
  private exitCallbacks: ExitCallback[] = []
  private cols = DEFAULT_COLS
  private rows = DEFAULT_ROWS

  constructor(shell: string, initialSize?: { cols: number; rows: number }) {
    this.cols = sanitizeCols(initialSize?.cols)
    this.rows = sanitizeRows(initialSize?.rows)

    const env = Object.assign({}, process.env as Record<string, string>, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    })

    this.ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: process.env.HOME || process.cwd(),
      env,
    })

    this.ptyProcess.onData((data: string) => {
      // Forward to all registered callbacks
      for (const cb of this.dataCallbacks) {
        try {
          cb(data)
        } catch (err) {
          console.error('[pty] data callback error:', err)
        }
      }
    })

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      for (const cb of this.exitCallbacks) {
        try {
          cb({ exitCode, signal })
        } catch (err) {
          console.error('[pty] exit callback error:', err)
        }
      }
    })
  }

  onData(cb: DataCallback): void {
    this.dataCallbacks.push(cb)
  }

  onExit(cb: ExitCallback): void {
    this.exitCallbacks.push(cb)
  }

  write(data: string): void {
    if (data.length === 0) return
    this.ptyProcess.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return

    const nextCols = Math.max(2, Math.floor(cols))
    const nextRows = Math.max(1, Math.floor(rows))
    if (nextCols === this.cols && nextRows === this.rows) return

    try {
      this.ptyProcess.resize(nextCols, nextRows)
      this.cols = nextCols
      this.rows = nextRows
    } catch (err) {
      console.error('[pty] resize error:', err)
    }
  }

  getColsRows(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  dispose(): void {
    try {
      this.ptyProcess.kill()
    } catch {
      // Process may already be dead
    }
    this.dataCallbacks = []
    this.exitCallbacks = []
  }
}

function sanitizeCols(cols: number | undefined): number {
  if (cols === undefined || !Number.isFinite(cols)) return DEFAULT_COLS
  return Math.max(2, Math.floor(cols))
}

function sanitizeRows(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows)) return DEFAULT_ROWS
  return Math.max(1, Math.floor(rows))
}
