import { Schema } from 'effect'

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
    cols: Schema.Number,
    rows: Schema.Number,
    cwd: Schema.optional(CwdSchema),
  }),
  Schema.Struct({
    type: Schema.Literal('attach'),
    sessionId: SessionIdSchema,
    terminalId: Schema.optional(SessionIdSchema),
    cols: Schema.Number,
    rows: Schema.Number,
    cwd: Schema.optional(CwdSchema),
  }),
  Schema.Struct({ type: Schema.Literal('detach'), sessionId: SessionIdSchema }),
  Schema.Struct({ type: Schema.Literal('write'), sessionId: SessionIdSchema, data: Schema.String }),
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
])

export type PtySize = Schema.Schema.Type<typeof PtySizeSchema>
export type PtyExitInfo = Schema.Schema.Type<typeof PtyExitInfoSchema>
export type PtyClientMessage = Schema.Schema.Type<typeof PtyClientMessageSchema>
export type PtyServiceMessage = Schema.Schema.Type<typeof PtyServiceMessageSchema>
