import * as pty from 'node-pty'

export interface PtyExitInfo {
  exitCode: number
  signal?: number
}

type DataCallback = (data: string) => void
type ExitCallback = (info: PtyExitInfo) => void

export class PtyManager {
  private ptyProcess: pty.IPty
  private dataCallbacks: DataCallback[] = []
  private exitCallbacks: ExitCallback[] = []

  constructor(shell: string) {
    const env = Object.assign({}, process.env as Record<string, string>, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    })

    this.ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
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
    this.ptyProcess.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.ptyProcess.resize(cols, rows)
    } catch (err) {
      console.error('[pty] resize error:', err)
    }
  }

  getColsRows(): { cols: number; rows: number } {
    return { cols: this.ptyProcess.cols, rows: this.ptyProcess.rows }
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
