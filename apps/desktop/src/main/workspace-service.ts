import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context, Effect, Layer, Schema } from 'effect'
import {
  GitStatusSchema,
  PortInfoSchema,
  PullRequestInfoSchema,
  WorkspaceDiffPatchSchema,
  WorkspaceFileTreeSchema,
  WorkspaceError,
  decodeWorkspacePathFromUnknown,
  errorMessageFromUnknown,
  type GitStatus,
  type PortInfo,
  type PullRequestInfo,
  type WorkspaceDiffPatch,
  type WorkspaceDiffPatchScope,
  type WorkspaceFileGitStatus,
  type WorkspaceFileGitStatusEntry,
  type WorkspaceFileTree,
  type WorktreeInfo,
  WorktreeInfoSchema,
} from '@tao/shared/workspace'

const execFileAsync = promisify(execFile)

const COMMAND_TIMEOUT_MS = 5000
const COMMAND_MAX_BUFFER = 1024 * 1024
const FILE_TREE_MAX_BUFFER = 4 * 1024 * 1024
const DIFF_PATCH_MAX_BUFFER = 8 * 1024 * 1024

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
    readonly getWorkspaceFileTree: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceFileTree, WorkspaceError>
    readonly getWorkspaceDiffPatch: (
      workspacePath: string,
      scope?: WorkspaceDiffPatchScope,
      compareBranch?: string,
    ) => Effect.Effect<WorkspaceDiffPatch, WorkspaceError>
    readonly stageWorkspacePath: (
      workspacePath: string,
      path: string | readonly string[],
    ) => Effect.Effect<void, WorkspaceError>
    readonly unstageWorkspacePath: (
      workspacePath: string,
      path: string | readonly string[],
    ) => Effect.Effect<void, WorkspaceError>
    readonly revertWorkspacePath: (
      workspacePath: string,
      path: string | readonly string[],
    ) => Effect.Effect<void, WorkspaceError>
    readonly getWorkspacePorts: (workspacePath: string) => Effect.Effect<PortInfo[], WorkspaceError>
    readonly getPullRequestInfo: (
      workspacePath: string,
    ) => Effect.Effect<PullRequestInfo | null, WorkspaceError>
  }
>()('Tao/WorkspaceService') {}

function runCommand(
  command: string,
  args: string[],
  options: { readonly cwd?: string; readonly maxBuffer?: number } = {},
): Effect.Effect<string, WorkspaceError> {
  return Effect.tryPromise({
    try: async (signal): Promise<string> => {
      const { stdout } = (await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? COMMAND_MAX_BUFFER,
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

function runGitBuffered(
  workspacePath: string,
  args: string[],
  maxBuffer: number,
): Effect.Effect<string, WorkspaceError> {
  return Effect.gen(function* () {
    const path = yield* decodeWorkspacePathFromUnknown(workspacePath)
    return yield* runCommand('git', ['-C', path, ...args], { maxBuffer })
  })
}

function validateDiffCompareBranch(compareBranch: string): Effect.Effect<string, WorkspaceError> {
  const trimmed = compareBranch.trim()
  if (trimmed.length === 0 || trimmed.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(trimmed)) {
    return Effect.fail(
      new WorkspaceError('invalid-name', `Invalid compare branch: ${compareBranch}`),
    )
  }

  return Effect.succeed(trimmed)
}

function resolveDefaultDiffCompareBranch(
  workspacePath: string,
): Effect.Effect<string, WorkspaceError> {
  return runGit(workspacePath, ['rev-parse', '--verify', '--quiet', 'main^{commit}']).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.succeed('main'),
      onFailure: () =>
        runGit(workspacePath, ['rev-parse', '--verify', '--quiet', 'master^{commit}']).pipe(
          Effect.match({
            onSuccess: () => 'master',
            onFailure: () => 'main',
          }),
        ),
    }),
  )
}

function diffArgsForScope(
  workspacePath: string,
  scope: WorkspaceDiffPatchScope = 'all',
  compareBranch?: string,
): Effect.Effect<string[], WorkspaceError> {
  const baseArgs = ['diff', '--no-ext-diff', '--no-color', '--patch']

  switch (scope) {
    case 'all':
      return (
        compareBranch?.trim()
          ? validateDiffCompareBranch(compareBranch)
          : resolveDefaultDiffCompareBranch(workspacePath)
      ).pipe(Effect.map((validatedCompareBranch) => [...baseArgs, validatedCompareBranch, '--']))
    case 'uncommitted':
      return Effect.succeed([...baseArgs, 'HEAD', '--'])
    case 'unstaged':
      return Effect.succeed([...baseArgs, '--'])
    case 'staged':
      return Effect.succeed([...baseArgs, '--cached', '--'])
  }
}

function validateGitPaths(
  path: string | readonly string[],
): Effect.Effect<string[], WorkspaceError> {
  const values = Array.isArray(path) ? path : [path]
  const trimmedValues = values.map((value) => value.trim())
  if (
    trimmedValues.length === 0 ||
    trimmedValues.some(
      (value) => value.length === 0 || value.startsWith('-') || value.includes('\0'),
    )
  ) {
    return Effect.fail(new WorkspaceError('invalid-path', 'Invalid path'))
  }
  return Effect.succeed(trimmedValues)
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

function parseNulSeparatedPaths(output: string): string[] {
  return output
    .split('\0')
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right))
}

function statusKind(indexStatus: string, workingTreeStatus: string): WorkspaceFileGitStatus {
  if (indexStatus === '?' && workingTreeStatus === '?') return 'untracked'
  if (indexStatus === '!' && workingTreeStatus === '!') return 'ignored'
  if (indexStatus === 'D' || workingTreeStatus === 'D') return 'deleted'
  if (indexStatus === 'R' || workingTreeStatus === 'R') return 'renamed'
  if (indexStatus === 'A') return 'added'
  return 'modified'
}

function parseWorkspaceFileStatus(output: string): WorkspaceFileGitStatusEntry[] {
  const fields = output.split('\0')
  const entries: WorkspaceFileGitStatusEntry[] = []

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    if (!field || field.length < 4) continue

    const indexStatus = field[0] ?? ' '
    const workingTreeStatus = field[1] ?? ' '
    const path = field.slice(3)
    if (!path) continue

    if (indexStatus === 'R' || indexStatus === 'C') index++
    entries.push({ path, status: statusKind(indexStatus, workingTreeStatus) })
  }

  return entries
}

function parseWorkspaceFileTree(
  pathsOutput: string,
  statusOutput: string,
): Effect.Effect<WorkspaceFileTree, WorkspaceError> {
  return Effect.try({
    try: () =>
      Schema.decodeUnknownSync(WorkspaceFileTreeSchema)({
        paths: parseNulSeparatedPaths(pathsOutput),
        gitStatus: parseWorkspaceFileStatus(statusOutput),
      }),
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

  getWorkspaceFileTree: (workspacePath) => {
    const paths = runGitBuffered(
      workspacePath,
      ['ls-files', '-co', '--exclude-standard', '-z'],
      FILE_TREE_MAX_BUFFER,
    )
    const status = runGitBuffered(
      workspacePath,
      ['status', '--porcelain=v1', '-z'],
      FILE_TREE_MAX_BUFFER,
    ).pipe(Effect.orElseSucceed(() => ''))

    return Effect.all([paths, status]).pipe(
      Effect.flatMap(([pathsOutput, statusOutput]) =>
        parseWorkspaceFileTree(pathsOutput, statusOutput),
      ),
      Effect.orElseSucceed(() => ({ paths: [], gitStatus: [] })),
    )
  },

  getWorkspaceDiffPatch: (workspacePath, scope, compareBranch) =>
    diffArgsForScope(workspacePath, scope, compareBranch).pipe(
      Effect.flatMap((args) => runGitBuffered(workspacePath, args, DIFF_PATCH_MAX_BUFFER)),
      Effect.map((patch) => Schema.decodeUnknownSync(WorkspaceDiffPatchSchema)(patch)),
    ),

  stageWorkspacePath: (workspacePath, path) =>
    validateGitPaths(path).pipe(
      Effect.flatMap((validatedPaths) =>
        runGit(workspacePath, ['add', '--all', '--', ...validatedPaths]),
      ),
      Effect.asVoid,
    ),

  unstageWorkspacePath: (workspacePath, path) =>
    validateGitPaths(path).pipe(
      Effect.flatMap((validatedPaths) =>
        runGit(workspacePath, ['restore', '--staged', '--', ...validatedPaths]),
      ),
      Effect.asVoid,
    ),

  revertWorkspacePath: (workspacePath, path) =>
    validateGitPaths(path).pipe(
      Effect.flatMap((validatedPaths) =>
        runGit(workspacePath, ['restore', '--', ...validatedPaths]),
      ),
      Effect.asVoid,
    ),

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
