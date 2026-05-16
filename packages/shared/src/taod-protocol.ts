import { Schema } from 'effect'

const NonEmptyString = Schema.Trim.check(Schema.isNonEmpty())

export const CreateSessionInputSchema = Schema.Struct({
  terminalId: NonEmptyString,
  cols: Schema.Number,
  rows: Schema.Number,
  cwd: Schema.optional(Schema.String),
  argv: Schema.optional(Schema.Array(Schema.String)),
})

export const CreateSessionResultSchema = Schema.Struct({
  sessionId: NonEmptyString,
  pid: Schema.optional(Schema.Number),
})

export const AttachSessionInputSchema = Schema.Struct({
  sessionId: Schema.optional(NonEmptyString),
  terminalId: Schema.optional(NonEmptyString),
})

export const AttachSessionResultSchema = Schema.Struct({
  sessionId: NonEmptyString,
  seq: Schema.Number,
  cwd: Schema.optional(Schema.String),
  cols: Schema.Number,
  rows: Schema.Number,
  archived: Schema.optional(Schema.Boolean),
})

export const OutputFrameSchema = Schema.Struct({
  sessionId: NonEmptyString,
  seq: Schema.Number,
  data: Schema.String,
})

export const ExitInfoSchema = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.Number),
})

export const AgentStatusSchema = Schema.Struct({
  provider: Schema.String,
  status: Schema.String,
  nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
})

export type CreateSessionInput = Schema.Schema.Type<typeof CreateSessionInputSchema>
export type CreateSessionResult = Schema.Schema.Type<typeof CreateSessionResultSchema>
export type AttachSessionInput = Schema.Schema.Type<typeof AttachSessionInputSchema>
export type AttachSessionResult = Schema.Schema.Type<typeof AttachSessionResultSchema>
export type OutputFrame = Schema.Schema.Type<typeof OutputFrameSchema>
export type ExitInfo = Schema.Schema.Type<typeof ExitInfoSchema>
export type AgentStatus = Schema.Schema.Type<typeof AgentStatusSchema>
