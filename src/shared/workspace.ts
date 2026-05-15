import { Schema } from 'effect'

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

export const WorkspaceGitWorktreesResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Array(WorktreeInfoSchema) }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkspaceErrorPayloadSchema }),
])

export const WorkspaceGitStatusResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: GitStatusSchema }),
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

export type WorktreeInfo = Schema.Schema.Type<typeof WorktreeInfoSchema>
export type GitStatus = Schema.Schema.Type<typeof GitStatusSchema>
export type PortInfo = Schema.Schema.Type<typeof PortInfoSchema>
export type PullRequestInfo = Schema.Schema.Type<typeof PullRequestInfoSchema>

export type WorkspaceErrorKind = Schema.Schema.Type<typeof WorkspaceErrorKindSchema>
export type WorkspaceErrorPayload = Schema.Schema.Type<typeof WorkspaceErrorPayloadSchema>
export type WorkspaceGitBranchResponse = Schema.Schema.Type<typeof WorkspaceGitBranchResponseSchema>
export type WorkspaceGitWorktreesResponse = Schema.Schema.Type<
  typeof WorkspaceGitWorktreesResponseSchema
>
export type WorkspaceGitStatusResponse = Schema.Schema.Type<typeof WorkspaceGitStatusResponseSchema>
export type WorkspacePortsResponse = Schema.Schema.Type<typeof WorkspacePortsResponseSchema>
export type WorkspacePullRequestResponse = Schema.Schema.Type<
  typeof WorkspacePullRequestResponseSchema
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
      'message' in error && typeof error.message === 'string' ? error.message : String(error),
  }
}

export function workspaceErrorFromUnknown(
  error: unknown,
  fallbackKind: WorkspaceErrorKind = 'command-failed',
): WorkspaceError {
  if (error instanceof WorkspaceError) return error
  const payload = workspaceErrorPayloadFromUnknown(error)
  if (payload) return workspaceErrorFromPayload(payload)
  return new WorkspaceError(fallbackKind, error instanceof Error ? error.message : String(error))
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
