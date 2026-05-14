import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Effect, Schema } from 'effect'
import {
  WorkspaceError,
  WorkspacePathSchema,
  type WorktreeInfo,
  WorktreeInfoSchema,
} from '../shared/workspace'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 5000
type MutableWorktreeInfo = {
  path?: string
  branch: string
  hash: string
  isBare: boolean
}

async function runGit(workspacePath: string, args: string[]): Promise<string> {
  let path: string
  try {
    path = Schema.decodeUnknownSync(WorkspacePathSchema)(workspacePath)
  } catch (error) {
    throw new WorkspaceError('invalid-path', error instanceof Error ? error.message : String(error))
  }

  const program = Effect.tryPromise({
    try: async () => {
      const { stdout } = await execFileAsync('git', ['-C', path, ...args], {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      })

      return stdout.trim()
    },
    catch: (error) => {
      return new WorkspaceError(
        'command-failed',
        error instanceof Error ? error.message : String(error),
      )
    },
  })

  return Effect.runPromise(program)
}

export async function getGitBranch(workspacePath: string): Promise<string | null> {
  try {
    const branch = await runGit(workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (branch.length > 0) return branch
  } catch {
    // Detached HEAD or non-git directory. Try a short hash before returning null.
  }

  try {
    const hash = await runGit(workspacePath, ['rev-parse', '--short', 'HEAD'])
    return hash.length > 0 ? hash : null
  } catch {
    return null
  }
}

export async function getGitWorktrees(workspacePath: string): Promise<WorktreeInfo[]> {
  let output: string
  try {
    output = await runGit(workspacePath, ['worktree', 'list', '--porcelain'])
  } catch {
    return []
  }

  if (output.length === 0) return []

  const worktrees = output.split(/\n\s*\n/).flatMap((entry) => {
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

    try {
      return [Schema.decodeUnknownSync(WorktreeInfoSchema)(info)]
    } catch {
      return []
    }
  })

  return worktrees
}
