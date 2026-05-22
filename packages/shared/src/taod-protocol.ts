import { Schema } from 'effect'

const NonEmptyString = Schema.Trim.check(Schema.isNonEmpty())

export const TAOD_STREAM_MAGIC = 0x54415346 // TASF
export const TAOD_STREAM_VERSION = 1
export const TAOD_STREAM_SESSION_ID_SIZE = 64
export const TAOD_STREAM_HEADER_SIZE = 88
export const TAOD_STREAM_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

export const TAOD_CONTROL_PROTOCOL_VERSION = 1
export const TAOD_CONTROL_CAPABILITIES = [
  'sessions-v1',
  'stream-frames-v1',
  'workspaces-v1',
  'worktrees-v1',
  'persistence-v1',
] as const

export const TaodStreamFrameKind = {
  Output: 1,
  Input: 2,
  Resize: 3,
  Snapshot: 4,
  Exit: 5,
  Agent: 6,
} as const

export type TaodStreamFrameKind = (typeof TaodStreamFrameKind)[keyof typeof TaodStreamFrameKind]
export type TaodControlCapability = (typeof TAOD_CONTROL_CAPABILITIES)[number]

export const TaodLifecycleStateSchema = Schema.Union([
  Schema.Literal('absent'),
  Schema.Literal('starting'),
  Schema.Literal('owned-live'),
  Schema.Literal('external-live'),
  Schema.Literal('stale-socket'),
  Schema.Literal('crashed'),
  Schema.Literal('version-mismatch'),
  Schema.Literal('stopping'),
  Schema.Literal('disposed'),
])

export const TaodDaemonOwnershipSchema = Schema.Union([
  Schema.Literal('none'),
  Schema.Literal('external'),
  Schema.Literal('owned-attached'),
  Schema.Literal('owned-detached'),
  Schema.Literal('released-detached'),
])

export const TaodLifecycleRecoveryActionSchema = Schema.Union([
  Schema.Literal('none'),
  Schema.Literal('start-daemon'),
  Schema.Literal('wait-for-start'),
  Schema.Literal('reuse-external-daemon'),
  Schema.Literal('keep-detached-daemon'),
  Schema.Literal('clear-stale-socket-and-start'),
  Schema.Literal('restart-owned-daemon'),
  Schema.Literal('replace-incompatible-daemon'),
])

export const TaodLifecycleRecoveryInputSchema = TaodLifecycleRecoveryActionSchema

export const TaodLifecycleEventSchema = Schema.Struct({
  state: TaodLifecycleStateSchema,
  at: Schema.Number,
  reason: Schema.optional(Schema.String),
})

export const TaodControlRequestDiagnosticsSchema = Schema.Struct({
  id: Schema.String,
  traceId: Schema.String,
  responseTraceId: Schema.optional(Schema.String),
  type: Schema.String,
  at: Schema.Number,
  durationMs: Schema.Number,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
})

export const TaodStreamDiagnosticsSchema = Schema.Struct({
  activeSubscribers: Schema.Number,
  pendingOutputSessions: Schema.Number,
  pendingOutputFrames: Schema.Number,
  pendingOutputBytes: Schema.Number,
  inputFramesTotal: Schema.Number,
  inputBytesTotal: Schema.Number,
  outputFramesTotal: Schema.Number,
  outputBytesTotal: Schema.Number,
  slowSubscriberDropsTotal: Schema.Number,
  pendingOutputDroppedFramesTotal: Schema.Number,
  pendingOutputDroppedBytesTotal: Schema.Number,
  pendingOutputTruncatedBytesTotal: Schema.Number,
})

export const TaodDaemonControlDiagnosticsSchema = Schema.Struct({
  requestCount: Schema.Number,
  failureCount: Schema.Number,
  lastRequestType: Schema.optional(Schema.String),
  lastTraceId: Schema.optional(Schema.String),
  lastDurationMs: Schema.optional(Schema.Number),
  lastOk: Schema.optional(Schema.Boolean),
  lastRecordedAtMs: Schema.optional(Schema.Number),
})

export const TaodLifecycleTimingDiagnosticsSchema = Schema.Struct({
  clientCreatedAt: Schema.Number,
  lastTransitionAt: Schema.Number,
  lastPingStartedAt: Schema.optional(Schema.Number),
  lastPingDurationMs: Schema.optional(Schema.Number),
  lastSuccessfulPingAt: Schema.optional(Schema.Number),
  lastFailedPingAt: Schema.optional(Schema.Number),
  lastStartRequestedAt: Schema.optional(Schema.Number),
  lastStartDurationMs: Schema.optional(Schema.Number),
})

export const TaodLifecycleDiagnosticsSchema = Schema.Struct({
  clientTraceId: Schema.String,
  state: TaodLifecycleStateSchema,
  socketPath: Schema.String,
  detachDaemon: Schema.Boolean,
  healthChecksEnabled: Schema.Boolean,
  healthChecksStarted: Schema.Boolean,
  startInFlight: Schema.Boolean,
  restartScheduled: Schema.Boolean,
  daemonOwnership: TaodDaemonOwnershipSchema,
  recoveryAction: TaodLifecycleRecoveryActionSchema,
  spawnedPid: Schema.optional(Schema.Number),
  releasedDetachedPid: Schema.optional(Schema.Number),
  daemonVersion: Schema.optional(Schema.String),
  protocolVersion: Schema.optional(Schema.Number),
  capabilities: Schema.Array(Schema.String),
  lastReason: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  controlRequestCount: Schema.Number,
  controlRequestFailureCount: Schema.Number,
  lastControlRequest: Schema.optional(TaodControlRequestDiagnosticsSchema),
  streamDiagnostics: Schema.optional(TaodStreamDiagnosticsSchema),
  daemonControlDiagnostics: Schema.optional(TaodDaemonControlDiagnosticsSchema),
  timing: TaodLifecycleTimingDiagnosticsSchema,
  transitions: Schema.Array(TaodLifecycleEventSchema),
})

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
export type TaodLifecycleState = Schema.Schema.Type<typeof TaodLifecycleStateSchema>
export type TaodDaemonOwnership = Schema.Schema.Type<typeof TaodDaemonOwnershipSchema>
export type TaodLifecycleRecoveryAction = Schema.Schema.Type<
  typeof TaodLifecycleRecoveryActionSchema
>
export type TaodLifecycleRecoveryInput = Schema.Schema.Type<typeof TaodLifecycleRecoveryInputSchema>
export type TaodLifecycleEvent = Schema.Schema.Type<typeof TaodLifecycleEventSchema>
export type TaodControlRequestDiagnostics = Schema.Schema.Type<
  typeof TaodControlRequestDiagnosticsSchema
>
export type TaodStreamDiagnostics = Schema.Schema.Type<typeof TaodStreamDiagnosticsSchema>
export type TaodDaemonControlDiagnostics = Schema.Schema.Type<
  typeof TaodDaemonControlDiagnosticsSchema
>
export type TaodLifecycleTimingDiagnostics = Schema.Schema.Type<
  typeof TaodLifecycleTimingDiagnosticsSchema
>
export type TaodLifecycleDiagnostics = Schema.Schema.Type<typeof TaodLifecycleDiagnosticsSchema>
