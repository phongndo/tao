import { Schema } from 'effect'

export const TerminalSessionStatusSchema = Schema.Union([
  Schema.Literal('live'),
  Schema.Literal('detached'),
  Schema.Literal('exited'),
  Schema.Literal('crashed'),
  Schema.Literal('archived'),
  Schema.Literal('killed'),
])

export const AgentSessionStatusSchema = Schema.Union([
  Schema.Literal('detected'),
  Schema.Literal('running'),
  Schema.Literal('resumable'),
  Schema.Literal('resumed'),
  Schema.Literal('unknown'),
  Schema.Literal('ended'),
])

export const TerminalSessionMetadataSchema = Schema.Struct({
  id: Schema.String,
  terminalId: Schema.String,
  workspaceId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  argv: Schema.optional(Schema.Array(Schema.String)),
  status: TerminalSessionStatusSchema,
  pid: Schema.optional(Schema.Number),
  cols: Schema.Number,
  rows: Schema.Number,
  title: Schema.optional(Schema.String),
  eventLogPath: Schema.String,
  lastSeq: Schema.Number,
  snapshotPath: Schema.optional(Schema.String),
  snapshotSeq: Schema.optional(Schema.Number),
  startedAt: Schema.String,
  lastActivityAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.Number),
})

export const AgentSessionMetadataSchema = Schema.Struct({
  id: Schema.String,
  terminalSessionId: Schema.String,
  provider: Schema.String,
  nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  originalArgv: Schema.optional(Schema.Array(Schema.String)),
  resumeArgv: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  transcriptPath: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: AgentSessionStatusSchema,
  lastActivityAt: Schema.optional(Schema.String),
})

export const WorkspaceLayoutSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  projectPath: Schema.NullOr(Schema.String),
  branch: Schema.optional(Schema.String),
  worktrees: Schema.optional(Schema.Array(Schema.Unknown)),
  lastActiveTabId: Schema.optional(Schema.String),
  order: Schema.Number,
})

export const TabLayoutSchema = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  name: Schema.String,
  layout: Schema.Unknown,
  lastActivePaneId: Schema.optional(Schema.String),
  order: Schema.Number,
})

export const PaneLayoutSchema = Schema.Struct({
  id: Schema.String,
  terminalId: Schema.String,
  tabId: Schema.String,
  type: Schema.Union([Schema.Literal('terminal'), Schema.Literal('webview')]),
  name: Schema.String,
  cwd: Schema.optional(Schema.String),
  status: Schema.optional(
    Schema.Union([
      Schema.Literal('idle'),
      Schema.Literal('working'),
      Schema.Literal('permission'),
      Schema.Literal('review'),
    ]),
  ),
  lastSessionId: Schema.optional(Schema.String),
})

export const PaneLayoutDataSchema = Schema.Struct({
  version: Schema.Number,
  workspaces: Schema.Array(WorkspaceLayoutSchema),
  activeWorkspaceId: Schema.NullOr(Schema.String),
  lastActiveLocalTabId: Schema.optional(Schema.NullOr(Schema.String)),
  tabs: Schema.Array(TabLayoutSchema),
  panes: Schema.Array(PaneLayoutSchema),
  activeTabId: Schema.NullOr(Schema.String),
  activePaneId: Schema.NullOr(Schema.String),
  sidebarExpanded: Schema.Boolean,
  sidebarWidth: Schema.Number,
})

export const SettingsDataSchema = Schema.Struct({
  version: Schema.Number,
  persistence: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      retainDays: Schema.Number,
      maxSessionBytes: Schema.Number,
      persistInput: Schema.Boolean,
    }),
  ),
})

export type TerminalSessionStatus = Schema.Schema.Type<typeof TerminalSessionStatusSchema>
export type AgentSessionStatus = Schema.Schema.Type<typeof AgentSessionStatusSchema>
export type TerminalSessionMetadata = Schema.Schema.Type<typeof TerminalSessionMetadataSchema>
export type AgentSessionMetadata = Schema.Schema.Type<typeof AgentSessionMetadataSchema>
export type PaneLayoutData = Schema.Schema.Type<typeof PaneLayoutDataSchema>
export type SettingsData = Schema.Schema.Type<typeof SettingsDataSchema>
