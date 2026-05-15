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
    cols: Schema.Number,
    rows: Schema.Number,
    cwd: Schema.optional(CwdSchema),
  }),
  Schema.Struct({ type: Schema.Literal('write'), sessionId: SessionIdSchema, data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('resize'),
    sessionId: SessionIdSchema,
    cols: Schema.Number,
    rows: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal('kill'), sessionId: SessionIdSchema }),
])

export const PtyServiceMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('ready'), sessionId: SessionIdSchema, size: PtySizeSchema }),
  Schema.Struct({ type: Schema.Literal('data'), sessionId: SessionIdSchema, data: Schema.String }),
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
