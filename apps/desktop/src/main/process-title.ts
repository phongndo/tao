import { execFile } from 'node:child_process'
import { basename } from 'node:path'

export type ProcessRow = {
  readonly pid: number
  readonly ppid: number
  readonly stat: string
  readonly command: string
}

const SHELL_NAMES = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh'])
const PROCESS_ROWS_CACHE_MS = 250

let cachedRows: { readAt: number; rows: ProcessRow[] } | null = null
let pendingRows: Promise<ProcessRow[]> | null = null

export function processTitleFromShell(shellPath: string | undefined): string {
  return normalizeProcessName(shellPath ?? process.env.SHELL ?? 'zsh') ?? 'zsh'
}

export function parsePsOutput(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []

  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!match) continue

    const pid = Number.parseInt(match[1]!, 10)
    const ppid = Number.parseInt(match[2]!, 10)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue

    rows.push({
      pid,
      ppid,
      stat: match[3]!,
      command: match[4]!,
    })
  }

  return rows
}

export function resolveProcessTitle(
  rows: readonly ProcessRow[],
  rootPid: number,
  fallbackTitle: string,
): string {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return fallbackTitle

  const byParent = new Map<number, ProcessRow[]>()
  let rootTitle: string | null = null
  for (const row of rows) {
    if (row.pid === rootPid) rootTitle = normalizeProcessName(row.command)
    const siblings = byParent.get(row.ppid)
    if (siblings) siblings.push(row)
    else byParent.set(row.ppid, [row])
  }

  type Candidate = {
    row: ProcessRow
    depth: number
    title: string
  }

  const candidates: Candidate[] = []
  const stack = (byParent.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  const seen = new Set<number>([rootPid])

  while (stack.length > 0) {
    const candidate = stack.pop()!
    if (seen.has(candidate.row.pid)) continue
    seen.add(candidate.row.pid)

    const title = normalizeProcessName(candidate.row.command)
    if (title && !candidate.row.stat.includes('Z')) {
      candidates.push({ ...candidate, title })
    }

    for (const child of byParent.get(candidate.row.pid) ?? []) {
      stack.push({ row: child, depth: candidate.depth + 1 })
    }
  }

  candidates.sort((left, right) => left.depth - right.depth || right.row.pid - left.row.pid)

  return (
    candidates.find((candidate) => !SHELL_NAMES.has(candidate.title))?.title ??
    candidates[0]?.title ??
    rootTitle ??
    fallbackTitle
  )
}

export async function readProcessTitle(rootPid: number, fallbackTitle: string): Promise<string> {
  if (process.platform === 'win32') return fallbackTitle

  const rows = await readProcessRows()
  return resolveProcessTitle(rows, rootPid, fallbackTitle)
}

function readProcessRows(): Promise<ProcessRow[]> {
  const now = Date.now()
  if (cachedRows && now - cachedRows.readAt <= PROCESS_ROWS_CACHE_MS) {
    return Promise.resolve(cachedRows.rows)
  }
  if (pendingRows) return pendingRows

  const nextRows = new Promise<ProcessRow[]>((resolve) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,stat=,comm='],
      { timeout: 1000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([])
          return
        }
        resolve(parsePsOutput(stdout))
      },
    )
  })
    .then((rows) => {
      cachedRows = { readAt: Date.now(), rows }
      return rows
    })
    .finally(() => {
      pendingRows = null
    })

  pendingRows = nextRows
  return nextRows
}

function normalizeProcessName(command: string): string | null {
  const trimmed = command.trim()
  if (trimmed.length === 0) return null

  const name = basename(trimmed).replace(/^-+/, '').trim()
  return name.length > 0 ? name : null
}
