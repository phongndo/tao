export type TaoStoragePaths = {
  readonly root: string
  readonly database: string
  readonly settings: string
  readonly paneLayouts: string
  readonly run: string
  readonly socket: string
  readonly pid: string
  readonly sessions: string
  readonly adapters: string
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, '') : path
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? trimTrailingSlash(part) : part.replace(/^\/+|\/+$/gu, '')))
    .join('/')
}

export function resolveTaoStoragePaths(homeDir: string): TaoStoragePaths {
  const home = trimTrailingSlash(homeDir.trim())
  const root = joinPath(home, '.tao')
  const run = joinPath(root, 'run')
  const sessions = joinPath(root, 'sessions')

  return {
    root,
    database: joinPath(root, 'tao.db'),
    settings: joinPath(root, 'settings.json'),
    paneLayouts: joinPath(root, 'pane-layouts.json'),
    run,
    socket: joinPath(run, 'taod.sock'),
    pid: joinPath(run, 'taod.pid'),
    sessions,
    adapters: joinPath(root, 'adapters'),
  }
}
