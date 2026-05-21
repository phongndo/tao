import { Schema } from 'effect'

const NonEmptyString = Schema.Trim.check(Schema.isNonEmpty())

export const TAOD_STREAM_MAGIC = 0x54415346 // TASF
export const TAOD_STREAM_VERSION = 1
export const TAOD_STREAM_SESSION_ID_SIZE = 64
export const TAOD_STREAM_HEADER_SIZE = 88
export const TAOD_STREAM_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

export const TaodStreamFrameKind = {
  Output: 1,
  Input: 2,
  Resize: 3,
  Snapshot: 4,
  Exit: 5,
  Agent: 6,
} as const

export type TaodStreamFrameKind = (typeof TaodStreamFrameKind)[keyof typeof TaodStreamFrameKind]

export const TaodStreamFrameKindSchema = Schema.Union([
  Schema.Literal(TaodStreamFrameKind.Output),
  Schema.Literal(TaodStreamFrameKind.Input),
  Schema.Literal(TaodStreamFrameKind.Resize),
  Schema.Literal(TaodStreamFrameKind.Snapshot),
  Schema.Literal(TaodStreamFrameKind.Exit),
  Schema.Literal(TaodStreamFrameKind.Agent),
])

export const AttachSessionModeSchema = Schema.Union([
  Schema.Literal('live'),
  Schema.Literal('fresh'),
  Schema.Literal('command-resume'),
  Schema.Literal('agent-resume'),
])

export const CreateSessionInputSchema = Schema.Struct({
  terminalId: NonEmptyString,
  workspaceId: NonEmptyString,
  worktreeId: Schema.optional(NonEmptyString),
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
  workspaceId: Schema.optional(NonEmptyString),
  worktreeId: Schema.optional(NonEmptyString),
  cols: Schema.optional(Schema.Number),
  rows: Schema.optional(Schema.Number),
  cwd: Schema.optional(Schema.String),
})

export const AttachSessionResultSchema = Schema.Struct({
  sessionId: NonEmptyString,
  seq: Schema.Number,
  cwd: Schema.optional(Schema.String),
  cols: Schema.Number,
  rows: Schema.Number,
  archived: Schema.optional(Schema.Boolean),
  attachMode: Schema.optional(AttachSessionModeSchema),
  agentProvider: Schema.optional(Schema.String),
  nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
})

export const OutputFrameSchema = Schema.Struct({
  sessionId: NonEmptyString,
  seq: Schema.Number,
  data: Schema.String,
})

export const CurrentScreenSnapshotFrameSchema = Schema.Struct({
  sessionId: NonEmptyString,
  seq: Schema.Number,
  dataBase64: Schema.String,
  live: Schema.optional(Schema.Boolean),
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
export type AttachSessionMode = Schema.Schema.Type<typeof AttachSessionModeSchema>
export type AttachSessionInput = Schema.Schema.Type<typeof AttachSessionInputSchema>
export type AttachSessionResult = Schema.Schema.Type<typeof AttachSessionResultSchema>
export type OutputFrame = Schema.Schema.Type<typeof OutputFrameSchema>
export type CurrentScreenSnapshotFrame = Schema.Schema.Type<typeof CurrentScreenSnapshotFrameSchema>
export type ExitInfo = Schema.Schema.Type<typeof ExitInfoSchema>
export type AgentStatus = Schema.Schema.Type<typeof AgentStatusSchema>
