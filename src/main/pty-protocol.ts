export interface PtySize {
  cols: number
  rows: number
}

export interface PtyExitInfo {
  exitCode: number
  signal?: number
}

export type PtyClientMessage =
  | { type: 'renderer-ready' }
  | { type: 'write'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'dispose' }

export type PtyServiceMessage =
  | { type: 'ready'; size: PtySize }
  | { type: 'data'; data: string }
  | { type: 'error'; error: string }
  | { type: 'exit'; info: PtyExitInfo }
