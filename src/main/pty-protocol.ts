import { Schema } from 'effect'

export const PtySizeSchema = Schema.Struct({
  cols: Schema.Number,
  rows: Schema.Number,
})

export const PtyExitInfoSchema = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.Number),
})

export const PtyClientMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('renderer-ready') }),
  Schema.Struct({ type: Schema.Literal('write'), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal('resize'), cols: Schema.Number, rows: Schema.Number }),
  Schema.Struct({ type: Schema.Literal('dispose') }),
])

export const PtyServiceMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('ready'), size: PtySizeSchema }),
  Schema.Struct({ type: Schema.Literal('data'), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal('error'), error: Schema.String }),
  Schema.Struct({ type: Schema.Literal('exit'), info: PtyExitInfoSchema }),
])

export type PtySize = Schema.Schema.Type<typeof PtySizeSchema>
export type PtyExitInfo = Schema.Schema.Type<typeof PtyExitInfoSchema>
export type PtyClientMessage = Schema.Schema.Type<typeof PtyClientMessageSchema>
export type PtyServiceMessage = Schema.Schema.Type<typeof PtyServiceMessageSchema>
