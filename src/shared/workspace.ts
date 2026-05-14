import { Schema } from 'effect'

export const WorkspacePathSchema = Schema.NonEmptyTrimmedString

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

export type WorktreeInfo = Schema.Schema.Type<typeof WorktreeInfoSchema>
export type GitStatus = Schema.Schema.Type<typeof GitStatusSchema>
export type PortInfo = Schema.Schema.Type<typeof PortInfoSchema>

export type WorkspaceErrorKind = 'invalid-path' | 'command-failed' | 'parse-failed'

export class WorkspaceError extends Error {
  readonly kind: WorkspaceErrorKind

  constructor(kind: WorkspaceErrorKind, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.kind = kind
  }
}
