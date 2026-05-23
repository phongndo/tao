import { Schema } from 'effect'
import { AgentStatusSchema, AttachSessionModeSchema } from '@tao/shared/taod-protocol'

export const PtySizeSchema = Schema.Struct({
  cols: Schema.Number,
  rows: Schema.Number,
})

export const PtyExitInfoSchema = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.Number),
})

const SessionIdSchema = Schema.Trim.check(Schema.isNonEmpty())
const CwdSchema = Schema.Trim.check(Schema.isNonEmpty())

export const PtyClientMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('renderer-ready') }),
  Schema.Struct({
    type: Schema.Literal('spawn'),
    sessionId: SessionIdSchema,
    terminalId: Schema.optional(SessionIdSchema),
    workspaceId: SessionIdSchema,
    worktreeId: Schema.optional(SessionIdSchema),
    cols: Schema.Number,
    rows: Schema.Number,
    cwd: Schema.optional(CwdSchema),
    argv: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal('attach'),
    sessionId: SessionIdSchema,
    terminalId: Schema.optional(SessionIdSchema),
    workspaceId: SessionIdSchema,
    worktreeId: Schema.optional(SessionIdSchema),
    cols: Schema.Number,
    rows: Schema.Number,
    cwd: Schema.optional(CwdSchema),
  }),
  Schema.Struct({ type: Schema.Literal('detach'), sessionId: SessionIdSchema }),
  Schema.Struct({
    type: Schema.Literal('write'),
    sessionId: SessionIdSchema,
    data: Schema.Union([Schema.String, Schema.Uint8Array]),
  }),
  Schema.Struct({
    type: Schema.Literal('resize'),
    sessionId: SessionIdSchema,
    cols: Schema.Number,
    rows: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal('kill'), sessionId: SessionIdSchema }),
  Schema.Struct({
    type: Schema.Literal('clear-history'),
    sessionIds: Schema.optional(Schema.Array(SessionIdSchema)),
  }),
])

export const PtyServiceMessageSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('ready'),
    sessionId: SessionIdSchema,
    size: PtySizeSchema,
    seq: Schema.optional(Schema.Number),
    archived: Schema.optional(Schema.Boolean),
    attachMode: Schema.optional(AttachSessionModeSchema),
    agentProvider: Schema.optional(Schema.String),
    nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal('data'),
    sessionId: SessionIdSchema,
    data: Schema.String,
    seq: Schema.optional(Schema.Number),
    replay: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('resize'),
    sessionId: SessionIdSchema,
    cols: Schema.Number,
    rows: Schema.Number,
    seq: Schema.optional(Schema.Number),
    replay: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('title'),
    sessionId: SessionIdSchema,
    title: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('snapshot'),
    sessionId: SessionIdSchema,
    dataBase64: Schema.String,
    seq: Schema.optional(Schema.Number),
    live: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('error'),
    sessionId: SessionIdSchema,
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('exit'),
    sessionId: SessionIdSchema,
    info: PtyExitInfoSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('agent'),
    sessionId: SessionIdSchema,
    status: AgentStatusSchema,
  }),
])

export const TaodPtyBridgeDiagnosticsSchema = Schema.Struct({
  portConnected: Schema.Boolean,
  activeSessions: Schema.Number,
  activeStreams: Schema.Number,
  messagesPostedTotal: Schema.Number,
  dataMessagesPostedTotal: Schema.Number,
  dataCharsPostedTotal: Schema.Number,
  snapshotMessagesPostedTotal: Schema.Number,
  snapshotBytesPostedTotal: Schema.Number,
  messagesDroppedNoPortTotal: Schema.Number,
  postFailuresTotal: Schema.Number,
  lastMessageType: Schema.optional(Schema.String),
  lastDataChars: Schema.optional(Schema.Number),
  lastPostedAt: Schema.optional(Schema.Number),
  lastFailureAt: Schema.optional(Schema.Number),
  lastError: Schema.optional(Schema.String),
})

export type PtySize = Schema.Schema.Type<typeof PtySizeSchema>
export type PtyExitInfo = Schema.Schema.Type<typeof PtyExitInfoSchema>
export type PtyClientMessage = Schema.Schema.Type<typeof PtyClientMessageSchema>
export type PtyServiceMessage = Schema.Schema.Type<typeof PtyServiceMessageSchema>
export type TaodPtyBridgeDiagnostics = Schema.Schema.Type<typeof TaodPtyBridgeDiagnosticsSchema>
