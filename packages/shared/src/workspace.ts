import { Effect, Schema } from 'effect'

export const WORKSPACE_IPC_TIMEOUT_MS = 15_000

export const WorkspacePathSchema = Schema.Trim.check(Schema.isNonEmpty())

export const WorktreeInfoSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  branch: Schema.String,
  hash: Schema.String,
  isBare: Schema.Boolean,
})

export const GitStatusSchema = Schema.Struct({
  changed: Schema.Number,
  staged: Schema.Number,
})

export const WorkspaceFileGitStatusSchema = Schema.Union([
  Schema.Literal('added'),
  Schema.Literal('deleted'),
  Schema.Literal('ignored'),
  Schema.Literal('modified'),
  Schema.Literal('renamed'),
  Schema.Literal('untracked'),
])

export const WorkspaceFileGitStatusEntrySchema = Schema.Struct({
  path: Schema.String,
  status: WorkspaceFileGitStatusSchema,
})

export const WorkspaceFileTreeSchema = Schema.Struct({
  paths: Schema.Array(Schema.String),
  gitStatus: Schema.Array(WorkspaceFileGitStatusEntrySchema),
})

export const WorkspaceDiffPatchSchema = Schema.String
export const WorkspaceDiffPatchScopeSchema = Schema.Union([
  Schema.Literal('all'),
  Schema.Literal('uncommitted'),
  Schema.Literal('unstaged'),
  Schema.Literal('staged'),
])
export const WorkspaceDiffPatchInputSchema = Schema.Struct({
  workspacePath: WorkspacePathSchema,
  scope: Schema.optional(WorkspaceDiffPatchScopeSchema),
  compareBranch: Schema.optional(Schema.String),
})
export const WorkspaceGitPathActionInputSchema = Schema.Struct({
  workspacePath: WorkspacePathSchema,
  path: Schema.Trim.check(Schema.isNonEmpty()),
})

export const WorkspaceWorktreeStateSchema = Schema.Union([
  Schema.Literal('creating'),
  Schema.Literal('active'),
  Schema.Literal('missing'),
  Schema.Literal('removing'),
  Schema.Literal('archived'),
  Schema.Literal('error'),
  Schema.Literal('untracked'),
])

export const WorkspaceWorktreeSchema = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  folderName: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.optional(Schema.NullOr(Schema.String)),
  targetBranch: Schema.optional(Schema.NullOr(Schema.String)),
  state: WorkspaceWorktreeStateSchema,
  orderIndex: Schema.Number,
  lastActiveTabId: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.String),
  gitStatus: Schema.optional(Schema.NullOr(GitStatusSchema)),
})

export const WorkspaceRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootPath: Schema.String,
  gitCommonDir: Schema.optional(Schema.NullOr(Schema.String)),
  workspaceSlug: Schema.String,
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  orderIndex: Schema.Number,
  lastActiveTabId: Schema.optional(Schema.NullOr(Schema.String)),
  gitStatus: Schema.optional(Schema.NullOr(GitStatusSchema)),
  worktrees: Schema.Array(WorkspaceWorktreeSchema),
})

export const PortInfoSchema = Schema.Struct({
  port: Schema.Number,
  processName: Schema.optional(Schema.String),
})

export const PullRequestInfoSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  headRefName: Schema.optional(Schema.String),
})

export const WorkspaceErrorKindSchema = Schema.Union([
  Schema.Literal('invalid-path'),
  Schema.Literal('invalid-name'),
  Schema.Literal('invalid-workspace'),
  Schema.Literal('invalid-worktree'),
  Schema.Literal('branch-exists'),
  Schema.Literal('branch-checked-out'),
  Schema.Literal('worktree-dirty'),
  Schema.Literal('git-failed'),
  Schema.Literal('state-conflict'),
  Schema.Literal('command-failed'),
  Schema.Literal('parse-failed'),
  Schema.Literal('unauthorized'),
  Schema.Literal('ipc-failed'),
  Schema.Literal('ipc-timeout'),
  Schema.Literal('invalid-response'),
  Schema.Literal('unavailable'),
])

export const WorkspaceErrorPayloadSchema = Schema.Struct({
  name: Schema.Literal('WorkspaceError'),
  kind: WorkspaceErrorKindSchema,
  message: Schema.String,
})

export const WorkspaceGitBranchResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.NullOr(Schema.String) }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspaceGitBranchesResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(Schema.String) }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspaceGitWorktreesResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(WorktreeInfoSchema) }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspaceGitStatusResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: GitStatusSchema }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspaceFileTreeResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: WorkspaceFileTreeSchema }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspaceDiffPatchResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: WorkspaceDiffPatchSchema }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])
export const WorkspaceGitPathActionResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Void }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspacePortsResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(PortInfoSchema) }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspacePullRequestResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.NullOr(PullRequestInfoSchema) }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspaceListResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(WorkspaceRecordSchema) }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspaceRecordResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: WorkspaceRecordSchema }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspaceWorktreeResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: WorkspaceWorktreeSchema }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspacePickDirectoryResponseSchema = Schema.NullOr(WorkspacePathSchema)

export type WorktreeInfo = Schema.Schema.Type<typeof WorktreeInfoSchema>
export type GitStatus = Schema.Schema.Type<typeof GitStatusSchema>
export type WorkspaceFileGitStatus = Schema.Schema.Type<typeof WorkspaceFileGitStatusSchema>
export type WorkspaceFileGitStatusEntry = Schema.Schema.Type<
  typeof WorkspaceFileGitStatusEntrySchema
>
export type WorkspaceFileTree = Schema.Schema.Type<typeof WorkspaceFileTreeSchema>
export type WorkspaceDiffPatch = Schema.Schema.Type<typeof WorkspaceDiffPatchSchema>
export type WorkspaceDiffPatchScope = Schema.Schema.Type<typeof WorkspaceDiffPatchScopeSchema>
export type WorkspaceDiffPatchInput = Schema.Schema.Type<typeof WorkspaceDiffPatchInputSchema>
export type WorkspaceGitPathActionInput = Schema.Schema.Type<typeof WorkspaceGitPathActionInputSchema>
export type WorkspaceWorktreeState = Schema.Schema.Type<typeof WorkspaceWorktreeStateSchema>
export type WorkspaceWorktree = Schema.Schema.Type<typeof WorkspaceWorktreeSchema>
export type WorkspaceRecord = Schema.Schema.Type<typeof WorkspaceRecordSchema>
export type PortInfo = Schema.Schema.Type<typeof PortInfoSchema>
export type PullRequestInfo = Schema.Schema.Type<typeof PullRequestInfoSchema>

export type WorkspaceErrorKind = Schema.Schema.Type<typeof WorkspaceErrorKindSchema>
export type WorkspaceErrorPayload = Schema.Schema.Type<typeof WorkspaceErrorPayloadSchema>
export type WorkspaceGitBranchResponse = Schema.Schema.Type<typeof WorkspaceGitBranchResponseSchema>
export type WorkspaceGitBranchesResponse = Schema.Schema.Type<
  typeof WorkspaceGitBranchesResponseSchema
>
export type WorkspaceGitWorktreesResponse = Schema.Schema.Type<
  typeof WorkspaceGitWorktreesResponseSchema
>
export type WorkspaceGitStatusResponse = Schema.Schema.Type<typeof WorkspaceGitStatusResponseSchema>
export type WorkspaceFileTreeResponse = Schema.Schema.Type<typeof WorkspaceFileTreeResponseSchema>
export type WorkspaceDiffPatchResponse = Schema.Schema.Type<typeof WorkspaceDiffPatchResponseSchema>
export type WorkspaceGitPathActionResponse = Schema.Schema.Type<
  typeof WorkspaceGitPathActionResponseSchema
>
export type WorkspacePortsResponse = Schema.Schema.Type<typeof WorkspacePortsResponseSchema>
export type WorkspacePullRequestResponse = Schema.Schema.Type<
  typeof WorkspacePullRequestResponseSchema
>
export type WorkspaceListResponse = Schema.Schema.Type<typeof WorkspaceListResponseSchema>
export type WorkspaceRecordResponse = Schema.Schema.Type<typeof WorkspaceRecordResponseSchema>
export type WorkspaceWorktreeResponse = Schema.Schema.Type<typeof WorkspaceWorktreeResponseSchema>
export type WorkspacePickDirectoryResponse = Schema.Schema.Type<
  typeof WorkspacePickDirectoryResponseSchema
>

export type WorkspaceIpcResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkspaceErrorPayload }

export class WorkspaceError extends Error {
  readonly kind: WorkspaceErrorKind

  constructor(kind: WorkspaceErrorKind, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.kind = kind
  }
}

export function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function decodeWorkspacePathFromUnknown(
  workspacePath: unknown,
): Effect.Effect<string, WorkspaceError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(WorkspacePathSchema)(workspacePath),
    catch: (error) => new WorkspaceError('invalid-path', errorMessageFromUnknown(error)),
  })
}

export function decodeWorkspacePathFromUnknownSync(
  workspacePath: unknown,
): string | WorkspaceError {
  try {
    return Schema.decodeUnknownSync(WorkspacePathSchema)(workspacePath)
  } catch (error) {
    return new WorkspaceError('invalid-path', errorMessageFromUnknown(error))
  }
}

export function decodeWorkspaceIpcResponse<A>(
  response: unknown,
  schema: Schema.Decoder<A>,
  channel: string,
): Effect.Effect<A, WorkspaceError> {
  const decoded = Schema.decodeUnknownOption(schema)(response)
  if (decoded._tag === 'Some') return Effect.succeed(decoded.value)

  return Effect.fail(new WorkspaceError('invalid-response', `Invalid response from ${channel}`))
}

export function workspaceErrorPayload(error: WorkspaceError): WorkspaceErrorPayload {
  return {
    name: 'WorkspaceError',
    kind: error.kind,
    message: error.message,
  }
}

export function workspaceErrorFromPayload(payload: WorkspaceErrorPayload): WorkspaceError {
  return new WorkspaceError(payload.kind, payload.message)
}

function workspaceErrorPayloadFromUnknown(error: unknown): WorkspaceErrorPayload | null {
  const decoded = Schema.decodeUnknownOption(WorkspaceErrorPayloadSchema)(error)
  if (decoded._tag === 'Some') return decoded.value

  if (typeof error !== 'object' || error === null || !('kind' in error)) return null

  const kind = Schema.decodeUnknownOption(WorkspaceErrorKindSchema)(error.kind)
  if (kind._tag === 'None') return null

  return {
    name: 'WorkspaceError',
    kind: kind.value,
    message:
      'message' in error && typeof error.message === 'string'
        ? error.message
        : errorMessageFromUnknown(error),
  }
}

export function workspaceErrorFromUnknown(
  error: unknown,
  fallbackKind: WorkspaceErrorKind = 'command-failed',
): WorkspaceError {
  if (error instanceof WorkspaceError) return error
  const payload = workspaceErrorPayloadFromUnknown(error)
  if (payload) return workspaceErrorFromPayload(payload)
  return new WorkspaceError(fallbackKind, errorMessageFromUnknown(error))
}

export function workspaceIpcSuccess<T>(value: T): WorkspaceIpcResponse<T> {
  return { ok: true, value }
}

export function workspaceIpcFailure(
  error: unknown,
  fallbackKind: WorkspaceErrorKind = 'command-failed',
): WorkspaceIpcResponse<never> {
  return { ok: false, error: workspaceErrorPayload(workspaceErrorFromUnknown(error, fallbackKind)) }
}
