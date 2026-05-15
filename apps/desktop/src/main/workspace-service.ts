import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context, Effect, Layer, Schema } from 'effect'
import {
  GitStatusSchema,
  PortInfoSchema,
  PullRequestInfoSchema,
  WorkspaceError,
  decodeWorkspacePathFromUnknown,
  errorMessageFromUnknown,
  type GitStatus,
  type PortInfo,
  type PullRequestInfo,
  type WorktreeInfo,
  WorktreeInfoSchema,
} from '@tau/shared/workspace'

const execFileAsync = promisify(execFile)

const COMMAND_TIMEOUT_MS = 5000
const COMMAND_MAX_BUFFER = 1024 * 1024

type MutableWorktreeInfo = {
  path?: string
  branch: string
  hash: string
  isBare: boolean
}

type ExecResult = {
  stdout: string
}

export class WorkspaceService extends Context.Service<
  WorkspaceService,
  {
    readonly getGitBranch: (workspacePath: string) => Effect.Effect<string | null, WorkspaceError>
    readonly getGitWorktrees: (
      workspacePath: string,
    ) => Effect.Effect<WorktreeInfo[], WorkspaceError>
    readonly getGitStatus: (workspacePath: string) => Effect.Effect<GitStatus, WorkspaceError>
    readonly getWorkspacePorts: (workspacePath: string) => Effect.Effect<PortInfo[], WorkspaceError>
    readonly getPullRequestInfo: (
      workspacePath: string,
    ) => Effect.Effect<PullRequestInfo | null, WorkspaceError>
  }
>()('Tau/WorkspaceService') {}

function runCommand(
  command: string,
  args: string[],
  options: { readonly cwd?: string } = {},
): Effect.Effect<string, WorkspaceError> {
  return Effect.tryPromise({
    try: async (signal): Promise<string> => {
      const { stdout } = (await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        signal,
      })) as ExecResult

      return stdout.trim()
    },
    catch: (error) => new WorkspaceError('command-failed', errorMessageFromUnknown(error)),
  })
}

function runGit(workspacePath: string, args: string[]): Effect.Effect<string, WorkspaceError> {
  return Effect.gen(function* () {
    const path = yield* decodeWorkspacePathFromUnknown(workspacePath)
    return yield* runCommand('git', ['-C', path, ...args])
  })
}

function decodeWorktree(info: MutableWorktreeInfo): WorktreeInfo | null {
  const decoded = Schema.decodeUnknownOption(WorktreeInfoSchema)(info)
  return decoded._tag === 'Some' ? decoded.value : null
}

function parseWorktrees(output: string): WorktreeInfo[] {
  if (output.length === 0) return []

  return output.split(/\n\s*\n/).flatMap((entry) => {
    const info: MutableWorktreeInfo = {
      branch: '',
      hash: '',
      isBare: false,
    }

    for (const line of entry.split('\n')) {
      const [key, ...valueParts] = line.split(' ')
      const value = valueParts.join(' ')

      switch (key) {
        case 'worktree':
          info.path = value
          break
        case 'HEAD':
          info.hash = value
          break
        case 'branch':
          info.branch = value.replace(/^refs\/heads\//, '')
          break
        case 'detached':
          info.branch = 'detached'
          break
        case 'bare':
          info.isBare = true
          break
      }
    }

    const worktree = decodeWorktree(info)
    return worktree ? [worktree] : []
  })
}

function parseGitStatus(output: string): Effect.Effect<GitStatus, WorkspaceError> {
  return Effect.try({
    try: () => {
      let staged = 0
      let changed = 0

      for (const line of output.split('\n')) {
        if (line.length < 2) continue

        const indexStatus = line[0]
        const workingTreeStatus = line[1]
        if (indexStatus !== ' ' && indexStatus !== '?') staged++
        if (workingTreeStatus !== ' ' || indexStatus === '?') changed++
      }

      return Schema.decodeUnknownSync(GitStatusSchema)({ changed, staged })
    },
    catch: (error) => new WorkspaceError('parse-failed', errorMessageFromUnknown(error)),
  })
}

function parsePorts(output: string): Effect.Effect<PortInfo[], WorkspaceError> {
  return Effect.try({
    try: () => {
      const portsByNumber = new Map<number, PortInfo>()
      let processName: string | undefined

      for (const line of output.split('\n')) {
        if (line.length < 2) continue

        const field = line[0]
        const value = line.slice(1)
        if (field === 'c') {
          processName = value || undefined
          continue
        }

        if (field !== 'n') continue
        const port = Number(value.match(/:(\d+)(?:\s|$|\()/)?.[1])
        if (!Number.isInteger(port) || port <= 0) continue
        if (!portsByNumber.has(port)) {
          portsByNumber.set(port, { port, ...(processName ? { processName } : {}) })
        }
      }

      const ports = [...portsByNumber.values()].sort((a, b) => a.port - b.port)
      return [...Schema.decodeUnknownSync(Schema.Array(PortInfoSchema))(ports)]
    },
    catch: (error) => new WorkspaceError('parse-failed', errorMessageFromUnknown(error)),
  })
}

function parsePullRequestInfo(
  output: string,
): Effect.Effect<PullRequestInfo | null, WorkspaceError> {
  if (output.length === 0) return Effect.succeed(null)

  return Effect.try({
    try: () => Schema.decodeUnknownSync(PullRequestInfoSchema)(JSON.parse(output)),
    catch: (error) => new WorkspaceError('parse-failed', errorMessageFromUnknown(error)),
  })
}

const WorkspaceServiceLiveValue: typeof WorkspaceService.Service = {
  getGitBranch: (workspacePath) => {
    const branch = runGit(workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).pipe(
      Effect.map((value) => (value.length > 0 ? value : null)),
    )
    const hash = runGit(workspacePath, ['rev-parse', '--short', 'HEAD']).pipe(
      Effect.map((value) => (value.length > 0 ? value : null)),
      Effect.orElseSucceed(() => null),
    )

    return branch.pipe(
      Effect.matchEffect({
        onFailure: () => hash,
        onSuccess: (value) => Effect.succeed(value),
      }),
    )
  },

  getGitWorktrees: (workspacePath) =>
    runGit(workspacePath, ['worktree', 'list', '--porcelain']).pipe(
      Effect.map(parseWorktrees),
      Effect.orElseSucceed(() => []),
    ),

  getGitStatus: (workspacePath) =>
    runGit(workspacePath, ['status', '--porcelain=v1']).pipe(Effect.flatMap(parseGitStatus)),

  getWorkspacePorts: (workspacePath) =>
    decodeWorkspacePathFromUnknown(workspacePath).pipe(
      Effect.flatMap((decodedPath) =>
        runCommand('lsof', ['-a', '+D', decodedPath, '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpnc']),
      ),
      Effect.flatMap(parsePorts),
      Effect.orElseSucceed(() => []),
    ),

  getPullRequestInfo: (workspacePath) =>
    decodeWorkspacePathFromUnknown(workspacePath).pipe(
      Effect.flatMap((cwd) =>
        runCommand('gh', ['pr', 'view', '--json', 'number,title,url,state,headRefName'], { cwd }),
      ),
      Effect.flatMap(parsePullRequestInfo),
      Effect.orElseSucceed(() => null),
    ),
}

export const WorkspaceServiceLive = Layer.succeed(WorkspaceService)(WorkspaceServiceLiveValue)
