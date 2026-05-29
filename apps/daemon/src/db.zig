const std = @import("std");
const limits = @import("limits.zig");
const sqlite = @import("sqlite");

const assert = std.debug.assert;

pub const event_log_refs_max = limits.db_event_log_refs_max;
pub const search_results_max = limits.db_search_results_max;

comptime {
    assert(event_log_refs_max > 0);
    assert(search_results_max > 0);
}

pub const migration_001_terminal_sessions =
    \\CREATE TABLE terminal_sessions (
    \\    id                 TEXT PRIMARY KEY,
    \\    terminal_id        TEXT NOT NULL,
    \\    workspace_id       TEXT,
    \\    cwd                TEXT,
    \\    argv_json          TEXT,
    \\    status             TEXT NOT NULL CHECK(status IN (
    \\        'live', 'detached', 'exited', 'crashed', 'archived', 'killed'
    \\    )),
    \\    daemon_id          TEXT,
    \\    pid                INTEGER,
    \\    cols               INTEGER NOT NULL,
    \\    rows               INTEGER NOT NULL,
    \\    title              TEXT,
    \\    event_log_path     TEXT NOT NULL,
    \\    last_seq           INTEGER NOT NULL DEFAULT 0,
    \\    snapshot_path      TEXT,
    \\    snapshot_seq       INTEGER NOT NULL DEFAULT 0,
    \\    snapshot_crc32     INTEGER,
    \\    snapshot_size      INTEGER,
    \\    scrollback_excerpt TEXT,
    \\    started_at         TEXT NOT NULL,
    \\    last_activity_at   TEXT,
    \\    ended_at           TEXT,
    \\    exit_code          INTEGER,
    \\    signal             INTEGER,
    \\    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    \\    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    \\) STRICT;
    \\CREATE INDEX idx_terminal_sessions_terminal ON terminal_sessions(terminal_id);
    \\CREATE INDEX idx_terminal_sessions_workspace ON terminal_sessions(workspace_id);
    \\CREATE INDEX idx_terminal_sessions_status ON terminal_sessions(status);
    \\CREATE INDEX idx_terminal_sessions_activity ON terminal_sessions(last_activity_at);
    \\CREATE TRIGGER update_terminal_sessions_updated_at
    \\    AFTER UPDATE ON terminal_sessions
    \\    BEGIN
    \\        UPDATE terminal_sessions SET updated_at = datetime('now') WHERE id = NEW.id;
    \\    END;
;

pub const migration_002_agent_sessions =
    \\CREATE TABLE agent_sessions (
    \\    id                  TEXT PRIMARY KEY,
    \\    terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
    \\    provider            TEXT NOT NULL,
    \\    native_session_id   TEXT,
    \\    original_argv_json  TEXT,
    \\    resume_argv_json    TEXT,
    \\    cwd                 TEXT,
    \\    transcript_path     TEXT,
    \\    model               TEXT,
    \\    title               TEXT,
    \\    status              TEXT NOT NULL CHECK(status IN (
    \\        'detected', 'running', 'resumable', 'resumed', 'unknown', 'ended'
    \\    )),
    \\    last_activity_at    TEXT,
    \\    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    \\    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    \\) STRICT;
    \\CREATE INDEX idx_agent_sessions_terminal ON agent_sessions(terminal_session_id);
    \\CREATE INDEX idx_agent_sessions_provider_native ON agent_sessions(provider, native_session_id);
    \\CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);
    \\CREATE TRIGGER update_agent_sessions_updated_at
    \\    AFTER UPDATE ON agent_sessions
    \\    BEGIN
    \\        UPDATE agent_sessions SET updated_at = datetime('now') WHERE id = NEW.id;
    \\    END;
;

pub const migration_003_terminal_search =
    \\CREATE VIRTUAL TABLE terminal_search USING fts5(
    \\    terminal_session_id UNINDEXED,
    \\    workspace_id UNINDEXED,
    \\    title,
    \\    excerpt,
    \\    tokenize = 'unicode61'
    \\);
;

pub const migration_004_workspace_worktrees =
    \\CREATE TABLE workspaces (
    \\    id TEXT PRIMARY KEY,
    \\    name TEXT NOT NULL,
    \\    root_path TEXT NOT NULL UNIQUE,
    \\    git_common_dir TEXT,
    \\    workspace_slug TEXT NOT NULL,
    \\    default_branch TEXT,
    \\    order_index INTEGER NOT NULL DEFAULT 0,
    \\    last_active_tab_id TEXT,
    \\    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    \\    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    \\    archived_at TEXT
    \\) STRICT;
    \\CREATE INDEX idx_workspaces_order ON workspaces(order_index);
    \\CREATE TRIGGER update_workspaces_updated_at
    \\    AFTER UPDATE ON workspaces
    \\    BEGIN
    \\        UPDATE workspaces SET updated_at = datetime('now') WHERE id = NEW.id;
    \\    END;
    \\CREATE TABLE worktrees (
    \\    id TEXT PRIMARY KEY,
    \\    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    \\    title TEXT,
    \\    folder_name TEXT NOT NULL,
    \\    path TEXT NOT NULL,
    \\    branch TEXT NOT NULL,
    \\    base_branch TEXT,
    \\    target_branch TEXT,
    \\    state TEXT NOT NULL CHECK(state IN (
    \\        'creating', 'active', 'missing', 'removing', 'archived', 'error',
    \\        'untracked'
    \\    )),
    \\    order_index INTEGER NOT NULL DEFAULT 0,
    \\    last_active_tab_id TEXT,
    \\    last_error TEXT,
    \\    created_by TEXT NOT NULL DEFAULT 'tau',
    \\    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    \\    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    \\    archived_at TEXT
    \\) STRICT;
    \\CREATE UNIQUE INDEX idx_worktrees_path ON worktrees(path) WHERE archived_at IS NULL;
    \\CREATE UNIQUE INDEX idx_worktrees_workspace_folder ON worktrees(workspace_id, folder_name) WHERE archived_at IS NULL;
    \\CREATE INDEX idx_worktrees_workspace_order ON worktrees(workspace_id, order_index);
    \\CREATE INDEX idx_worktrees_state ON worktrees(state);
    \\CREATE UNIQUE INDEX idx_worktrees_workspace_branch
    \\    ON worktrees(workspace_id, branch)
    \\    WHERE archived_at IS NULL;
    \\CREATE TRIGGER update_worktrees_updated_at
    \\    AFTER UPDATE ON worktrees
    \\    BEGIN
    \\        UPDATE worktrees SET updated_at = datetime('now') WHERE id = NEW.id;
    \\    END;
    \\ALTER TABLE terminal_sessions ADD COLUMN worktree_id TEXT REFERENCES worktrees(id);
    \\CREATE INDEX idx_terminal_sessions_worktree ON terminal_sessions(worktree_id);
;

pub const migration_005_worktree_branch_unique =
    \\DROP INDEX IF EXISTS idx_worktrees_branch;
    \\CREATE UNIQUE INDEX IF NOT EXISTS idx_worktrees_workspace_branch
    \\    ON worktrees(workspace_id, branch)
    \\    WHERE archived_at IS NULL;
;

pub const migrations = [_][]const u8{
    migration_001_terminal_sessions,
    migration_002_agent_sessions,
    migration_003_terminal_search,
    migration_004_workspace_worktrees,
    migration_005_worktree_branch_unique,
};

const create_migrations_table_sql =
    \\CREATE TABLE IF NOT EXISTS schema_migrations (
    \\    version INTEGER PRIMARY KEY,
    \\    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    \\) STRICT;
;

const upsert_terminal_session_sql =
    \\INSERT INTO terminal_sessions (
    \\    id, terminal_id, workspace_id, worktree_id, cwd, argv_json, status, daemon_id, pid,
    \\    cols, rows, title, event_log_path, last_seq,
    \\    snapshot_path, snapshot_seq, snapshot_crc32, snapshot_size,
    \\    started_at, last_activity_at
    \\) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    \\ON CONFLICT(id) DO UPDATE SET
    \\    terminal_id = excluded.terminal_id,
    \\    workspace_id = excluded.workspace_id,
    \\    worktree_id = excluded.worktree_id,
    \\    cwd = excluded.cwd,
    \\    argv_json = COALESCE(excluded.argv_json, terminal_sessions.argv_json),
    \\    status = excluded.status,
    \\    daemon_id = excluded.daemon_id,
    \\    pid = excluded.pid,
    \\    cols = excluded.cols,
    \\    rows = excluded.rows,
    \\    title = COALESCE(excluded.title, terminal_sessions.title),
    \\    event_log_path = excluded.event_log_path,
    \\    last_seq = excluded.last_seq,
    \\    snapshot_path = COALESCE(excluded.snapshot_path, terminal_sessions.snapshot_path),
    \\    snapshot_seq = CASE WHEN excluded.snapshot_path IS NULL THEN terminal_sessions.snapshot_seq ELSE excluded.snapshot_seq END,
    \\    snapshot_crc32 = CASE WHEN excluded.snapshot_path IS NULL THEN terminal_sessions.snapshot_crc32 ELSE excluded.snapshot_crc32 END,
    \\    snapshot_size = CASE WHEN excluded.snapshot_path IS NULL THEN terminal_sessions.snapshot_size ELSE excluded.snapshot_size END,
    \\    last_activity_at = datetime('now')
    \\;
;

const update_terminal_ended_sql =
    \\UPDATE terminal_sessions
    \\SET status = ?, pid = NULL, cols = ?, rows = ?, last_seq = ?,
    \\    ended_at = datetime('now'), last_activity_at = datetime('now'),
    \\    exit_code = ?, signal = ?
    \\WHERE id = ?;
;

const find_terminal_by_id_sql =
    \\SELECT id, terminal_id, workspace_id, worktree_id, cwd, argv_json, status,
    \\       cols, rows, event_log_path, last_seq
    \\FROM terminal_sessions
    \\WHERE id = ?
    \\LIMIT 1;
;

const find_terminal_by_terminal_id_sql =
    \\SELECT id, terminal_id, workspace_id, worktree_id, cwd, argv_json, status,
    \\       cols, rows, event_log_path, last_seq
    \\FROM terminal_sessions
    \\WHERE terminal_id = ?
    \\ORDER BY updated_at DESC
    \\LIMIT 1;
;

const list_terminal_event_logs_sql =
    \\SELECT id, event_log_path FROM terminal_sessions;
;

const clear_terminal_history_metadata_sql =
    \\UPDATE terminal_sessions
    \\SET scrollback_excerpt = NULL,
    \\    last_seq = 0,
    \\    snapshot_path = NULL,
    \\    snapshot_seq = 0,
    \\    snapshot_crc32 = NULL,
    \\    snapshot_size = NULL,
    \\    last_activity_at = datetime('now')
    \\WHERE id = ?;
;

const delete_terminal_search_sql =
    \\DELETE FROM terminal_search WHERE terminal_session_id = ?;
;

const delete_terminal_session_sql =
    \\DELETE FROM terminal_sessions WHERE id = ?;
;

const upsert_agent_session_sql =
    \\INSERT INTO agent_sessions (
    \\    id, terminal_session_id, provider, native_session_id, original_argv_json,
    \\    resume_argv_json, cwd, transcript_path, model, title, status, last_activity_at
    \\) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    \\ON CONFLICT(id) DO UPDATE SET
    \\    provider = excluded.provider,
    \\    native_session_id = COALESCE(excluded.native_session_id, agent_sessions.native_session_id),
    \\    original_argv_json = COALESCE(excluded.original_argv_json, agent_sessions.original_argv_json),
    \\    resume_argv_json = COALESCE(excluded.resume_argv_json, agent_sessions.resume_argv_json),
    \\    cwd = COALESCE(excluded.cwd, agent_sessions.cwd),
    \\    transcript_path = COALESCE(excluded.transcript_path, agent_sessions.transcript_path),
    \\    model = COALESCE(excluded.model, agent_sessions.model),
    \\    title = COALESCE(excluded.title, agent_sessions.title),
    \\    status = excluded.status,
    \\    last_activity_at = datetime('now')
    \\;
;

const find_agent_resume_by_terminal_sql =
    \\SELECT id, provider, native_session_id, resume_argv_json, status
    \\FROM agent_sessions
    \\WHERE terminal_session_id = ?
    \\  AND native_session_id IS NOT NULL
    \\  AND resume_argv_json IS NOT NULL
    \\  AND status IN ('detected', 'running', 'resumable', 'resumed')
    \\ORDER BY updated_at DESC
    \\LIMIT 1;
;

const insert_terminal_search_sql =
    \\INSERT INTO terminal_search (terminal_session_id, workspace_id, title, excerpt)
    \\VALUES (?, ?, ?, ?);
;

const search_terminal_excerpts_sql =
    \\SELECT terminal_session_id, title, excerpt
    \\FROM terminal_search
    \\WHERE terminal_search MATCH ?
    \\LIMIT ?;
;

const insert_workspace_sql =
    \\INSERT INTO workspaces (
    \\    id, name, root_path, git_common_dir, workspace_slug, default_branch,
    \\    order_index, last_active_tab_id
    \\) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
;

const update_workspace_sql =
    \\UPDATE workspaces
    \\SET name = ?, git_common_dir = ?, workspace_slug = ?, default_branch = ?,
    \\    order_index = ?, last_active_tab_id = ?
    \\WHERE id = ?;
;

const reactivate_workspace_sql =
    \\UPDATE workspaces
    \\SET name = ?, git_common_dir = ?, workspace_slug = ?, default_branch = ?,
    \\    order_index = ?, last_active_tab_id = ?, archived_at = NULL
    \\WHERE id = ?;
;

const archive_workspace_sql =
    \\UPDATE workspaces SET archived_at = datetime('now') WHERE id = ?;
;

const find_workspace_by_id_sql =
    \\SELECT id, name, root_path, git_common_dir, workspace_slug, default_branch,
    \\       order_index, last_active_tab_id, created_at, updated_at, archived_at
    \\FROM workspaces WHERE id = ? LIMIT 1;
;

const find_workspace_by_root_sql =
    \\SELECT id, name, root_path, git_common_dir, workspace_slug, default_branch,
    \\       order_index, last_active_tab_id, created_at, updated_at, archived_at
    \\FROM workspaces WHERE root_path = ? LIMIT 1;
;

const list_workspaces_sql =
    \\SELECT id, name, root_path, git_common_dir, workspace_slug, default_branch,
    \\       order_index, last_active_tab_id, created_at, updated_at, archived_at
    \\FROM workspaces
    \\WHERE archived_at IS NULL
    \\ORDER BY order_index ASC, created_at ASC;
;

const count_workspaces_sql =
    \\SELECT COUNT(*) FROM workspaces;
;

const next_workspace_order_sql =
    \\SELECT COALESCE(MAX(order_index), -1) + 1 FROM workspaces WHERE archived_at IS NULL;
;

const reorder_workspace_sql =
    \\UPDATE workspaces SET order_index = ? WHERE id = ?;
;

const insert_worktree_sql =
    \\INSERT INTO worktrees (
    \\    id, workspace_id, title, folder_name, path, branch, base_branch,
    \\    target_branch, state, order_index, last_active_tab_id, last_error, created_by
    \\) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
;

const reactivate_worktree_sql =
    \\UPDATE worktrees
    \\SET workspace_id = ?, title = ?, folder_name = ?, path = ?, branch = ?,
    \\    base_branch = ?, target_branch = ?, state = ?, order_index = ?,
    \\    last_active_tab_id = ?, last_error = ?, created_by = ?, archived_at = NULL
    \\WHERE id = ?;
;

const update_worktree_state_sql =
    \\UPDATE worktrees
    \\SET state = ?, last_error = ?
    \\WHERE id = ?;
;

const update_worktree_git_sql =
    \\UPDATE worktrees
    \\SET branch = ?, state = ?, last_error = NULL, archived_at = NULL
    \\WHERE id = ?;
;

const archive_worktree_sql =
    \\UPDATE worktrees
    \\SET state = 'archived', archived_at = datetime('now')
    \\WHERE id = ?;
;

const archive_worktrees_for_workspace_sql =
    \\UPDATE worktrees
    \\SET state = 'archived', archived_at = datetime('now')
    \\WHERE workspace_id = ? AND archived_at IS NULL;
;

const find_worktree_by_id_sql =
    \\SELECT id, workspace_id, title, folder_name, path, branch, base_branch,
    \\       target_branch, state, order_index, last_active_tab_id, last_error,
    \\       created_by, created_at, updated_at, archived_at
    \\FROM worktrees WHERE id = ? LIMIT 1;
;

const find_worktree_by_path_sql =
    \\SELECT id, workspace_id, title, folder_name, path, branch, base_branch,
    \\       target_branch, state, order_index, last_active_tab_id, last_error,
    \\       created_by, created_at, updated_at, archived_at
    \\FROM worktrees WHERE path = ? AND archived_at IS NULL LIMIT 1;
;

const find_archived_worktree_by_path_sql =
    \\SELECT id, workspace_id, title, folder_name, path, branch, base_branch,
    \\       target_branch, state, order_index, last_active_tab_id, last_error,
    \\       created_by, created_at, updated_at, archived_at
    \\FROM worktrees WHERE path = ? AND archived_at IS NOT NULL
    \\ORDER BY updated_at DESC LIMIT 1;
;

const find_archived_worktree_by_folder_sql =
    \\SELECT id, workspace_id, title, folder_name, path, branch, base_branch,
    \\       target_branch, state, order_index, last_active_tab_id, last_error,
    \\       created_by, created_at, updated_at, archived_at
    \\FROM worktrees
    \\WHERE workspace_id = ? AND folder_name = ? AND archived_at IS NOT NULL
    \\ORDER BY updated_at DESC LIMIT 1;
;

const find_archived_worktree_by_branch_sql =
    \\SELECT id, workspace_id, title, folder_name, path, branch, base_branch,
    \\       target_branch, state, order_index, last_active_tab_id, last_error,
    \\       created_by, created_at, updated_at, archived_at
    \\FROM worktrees
    \\WHERE workspace_id = ? AND branch = ? AND archived_at IS NOT NULL
    \\ORDER BY updated_at DESC LIMIT 1;
;

const list_worktrees_for_workspace_sql =
    \\SELECT id, workspace_id, title, folder_name, path, branch, base_branch,
    \\       target_branch, state, order_index, last_active_tab_id, last_error,
    \\       created_by, created_at, updated_at, archived_at
    \\FROM worktrees
    \\WHERE workspace_id = ? AND archived_at IS NULL
    \\ORDER BY order_index ASC, created_at ASC;
;

const count_worktrees_sql =
    \\SELECT COUNT(*) FROM worktrees;
;

const worktree_path_exists_sql =
    \\SELECT 1 FROM worktrees WHERE path = ? AND archived_at IS NULL LIMIT 1;
;

const archived_worktree_path_exists_sql =
    \\SELECT 1 FROM worktrees WHERE path = ? AND archived_at IS NOT NULL LIMIT 1;
;

const worktree_branch_exists_sql =
    \\SELECT 1 FROM worktrees WHERE workspace_id = ? AND branch = ? AND archived_at IS NULL LIMIT 1;
;

const worktree_folder_exists_sql =
    \\SELECT 1 FROM worktrees WHERE workspace_id = ? AND folder_name = ? AND archived_at IS NULL LIMIT 1;
;

const next_worktree_order_sql =
    \\SELECT COALESCE(MAX(order_index), -1) + 1 FROM worktrees WHERE workspace_id = ? AND archived_at IS NULL;
;

const reorder_worktree_sql =
    \\UPDATE worktrees SET order_index = ? WHERE id = ?;
;

pub const TerminalSessionRecord = struct {
    id: []const u8,
    terminal_id: []const u8,
    workspace_id: ?[]const u8 = null,
    worktree_id: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    argv_json: ?[]const u8 = null,
    status: []const u8,
    daemon_id: ?[]const u8 = null,
    pid: ?i64 = null,
    cols: u16,
    rows: u16,
    title: ?[]const u8 = null,
    event_log_path: []const u8,
    last_seq: u64,
    snapshot_path: ?[]const u8 = null,
    snapshot_seq: u64 = 0,
    snapshot_crc32: ?u32 = null,
    snapshot_size: ?usize = null,
};

pub const TerminalEndedRecord = struct {
    id: []const u8,
    status: []const u8,
    cols: u16,
    rows: u16,
    last_seq: u64,
    exit_code: i32,
    signal: i32,
};

pub const TerminalSessionLookup = struct {
    id: []u8,
    terminal_id: []u8,
    workspace_id: ?[]u8,
    worktree_id: ?[]u8,
    cwd: ?[]u8,
    argv_json: ?[]u8,
    status: []u8,
    cols: u16,
    rows: u16,
    event_log_path: []u8,
    last_seq: u64,

    pub fn deinit(self: *TerminalSessionLookup, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.terminal_id);
        if (self.workspace_id) |value| allocator.free(value);
        if (self.worktree_id) |value| allocator.free(value);
        if (self.cwd) |value| allocator.free(value);
        if (self.argv_json) |value| allocator.free(value);
        allocator.free(self.status);
        allocator.free(self.event_log_path);
        self.* = undefined;
    }
};

pub const TerminalEventLogRef = struct {
    id: []u8,
    event_log_path: []u8,

    pub fn deinit(self: *TerminalEventLogRef, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.event_log_path);
        self.* = undefined;
    }
};

pub const AgentSessionRecord = struct {
    id: []const u8,
    terminal_session_id: []const u8,
    provider: []const u8,
    native_session_id: ?[]const u8 = null,
    original_argv_json: ?[]const u8 = null,
    resume_argv_json: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    transcript_path: ?[]const u8 = null,
    model: ?[]const u8 = null,
    title: ?[]const u8 = null,
    status: []const u8,
};

pub const AgentResumeLookup = struct {
    id: []u8,
    provider: []u8,
    native_session_id: []u8,
    resume_argv_json: []u8,
    status: []u8,

    pub fn deinit(self: *AgentResumeLookup, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.provider);
        allocator.free(self.native_session_id);
        allocator.free(self.resume_argv_json);
        allocator.free(self.status);
        self.* = undefined;
    }
};

pub const TerminalSearchRecord = struct {
    terminal_session_id: []const u8,
    workspace_id: ?[]const u8 = null,
    title: ?[]const u8 = null,
    excerpt: []const u8,
};

pub const TerminalSearchResult = struct {
    terminal_session_id: []u8,
    title: ?[]u8,
    excerpt: []u8,

    pub fn deinit(self: *TerminalSearchResult, allocator: std.mem.Allocator) void {
        allocator.free(self.terminal_session_id);
        if (self.title) |value| allocator.free(value);
        allocator.free(self.excerpt);
        self.* = undefined;
    }
};

pub const WorkspaceRecord = struct {
    id: []const u8,
    name: []const u8,
    root_path: []const u8,
    git_common_dir: ?[]const u8 = null,
    workspace_slug: []const u8,
    default_branch: ?[]const u8 = null,
    order_index: i64 = 0,
    last_active_tab_id: ?[]const u8 = null,
};

pub const WorkspaceRow = struct {
    id: []u8,
    name: []u8,
    root_path: []u8,
    git_common_dir: ?[]u8,
    workspace_slug: []u8,
    default_branch: ?[]u8,
    order_index: i64,
    last_active_tab_id: ?[]u8,
    created_at: []u8,
    updated_at: []u8,
    archived_at: ?[]u8,

    pub fn deinit(self: *WorkspaceRow, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.name);
        allocator.free(self.root_path);
        if (self.git_common_dir) |value| allocator.free(value);
        allocator.free(self.workspace_slug);
        if (self.default_branch) |value| allocator.free(value);
        if (self.last_active_tab_id) |value| allocator.free(value);
        allocator.free(self.created_at);
        allocator.free(self.updated_at);
        if (self.archived_at) |value| allocator.free(value);
        self.* = undefined;
    }
};

pub const WorktreeRecord = struct {
    id: []const u8,
    workspace_id: []const u8,
    title: ?[]const u8 = null,
    folder_name: []const u8,
    path: []const u8,
    branch: []const u8,
    base_branch: ?[]const u8 = null,
    target_branch: ?[]const u8 = null,
    state: []const u8,
    order_index: i64 = 0,
    last_active_tab_id: ?[]const u8 = null,
    last_error: ?[]const u8 = null,
    created_by: []const u8 = "tau",
};

pub const WorktreeRow = struct {
    id: []u8,
    workspace_id: []u8,
    title: ?[]u8,
    folder_name: []u8,
    path: []u8,
    branch: []u8,
    base_branch: ?[]u8,
    target_branch: ?[]u8,
    state: []u8,
    order_index: i64,
    last_active_tab_id: ?[]u8,
    last_error: ?[]u8,
    created_by: []u8,
    created_at: []u8,
    updated_at: []u8,
    archived_at: ?[]u8,

    pub fn deinit(self: *WorktreeRow, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.workspace_id);
        if (self.title) |value| allocator.free(value);
        allocator.free(self.folder_name);
        allocator.free(self.path);
        allocator.free(self.branch);
        if (self.base_branch) |value| allocator.free(value);
        if (self.target_branch) |value| allocator.free(value);
        allocator.free(self.state);
        if (self.last_active_tab_id) |value| allocator.free(value);
        if (self.last_error) |value| allocator.free(value);
        allocator.free(self.created_by);
        allocator.free(self.created_at);
        allocator.free(self.updated_at);
        if (self.archived_at) |value| allocator.free(value);
        self.* = undefined;
    }
};

pub const Database = struct {
    allocator: std.mem.Allocator,
    handle: sqlite.Db,

    const open_flags = sqlite.Db.OpenFlags{ .write = true, .create = true };
    const threading_mode = sqlite.ThreadingMode.MultiThread;

    pub fn open(allocator: std.mem.Allocator, path: []const u8) !Database {
        const path_z = try allocator.dupeZ(u8, path);
        defer allocator.free(path_z);

        var diags = sqlite.Diagnostics{};
        const handle = sqlite.Db.init(.{
            .mode = .{ .File = path_z },
            .open_flags = open_flags,
            .threading_mode = threading_mode,
            .diags = &diags,
        }) catch |err| {
            std.log.err("failed to open sqlite database {s}: {f}", .{ path, diags });
            return err;
        };

        return initOpened(allocator, handle);
    }

    pub fn openInMemory(allocator: std.mem.Allocator) !Database {
        var diags = sqlite.Diagnostics{};
        const handle = sqlite.Db.init(.{
            .mode = .Memory,
            .open_flags = open_flags,
            .threading_mode = threading_mode,
            .diags = &diags,
        }) catch |err| {
            std.log.err("failed to open in-memory sqlite database: {f}", .{diags});
            return err;
        };

        return initOpened(allocator, handle);
    }

    fn initOpened(allocator: std.mem.Allocator, handle: sqlite.Db) !Database {
        var database = Database{ .allocator = allocator, .handle = handle };
        errdefer database.deinit();

        try database.configure();
        return database;
    }

    pub fn deinit(self: *Database) void {
        self.handle.deinit();
        self.* = undefined;
    }

    fn configure(self: *Database) !void {
        _ = try self.handle.one([32:0]u8, "PRAGMA journal_mode = WAL;", .{}, .{});
        try self.handle.exec("PRAGMA foreign_keys = ON;", .{}, .{});
        _ = try self.handle.one(u32, "PRAGMA busy_timeout = 5000;", .{}, .{});
        try self.migrate();
    }

    pub fn migrate(self: *Database) !void {
        try self.exec(create_migrations_table_sql);
        for (migrations, 0..) |migration, index| {
            const version: i64 = @intCast(index + 1);
            if (try self.hasMigration(version)) continue;

            try self.exec("BEGIN IMMEDIATE;");
            self.exec(migration) catch |err| {
                self.exec("ROLLBACK;") catch {};
                return err;
            };
            self.markMigration(version) catch |err| {
                self.exec("ROLLBACK;") catch {};
                return err;
            };
            try self.exec("COMMIT;");
        }
    }

    pub fn recordTerminalSession(self: *Database, record: TerminalSessionRecord) !void {
        var stmt = try self.handle.prepareDynamic(upsert_terminal_session_sql);
        defer stmt.deinit();

        const last_seq: i64 = @intCast(record.last_seq);
        const snapshot_seq: i64 = @intCast(record.snapshot_seq);
        const snapshot_crc32: ?i64 = if (record.snapshot_crc32) |value| @intCast(value) else null;
        const snapshot_size: ?i64 = if (record.snapshot_size) |value| @intCast(value) else null;

        try stmt.exec(.{}, .{
            record.id,
            record.terminal_id,
            record.workspace_id,
            record.worktree_id,
            record.cwd,
            record.argv_json,
            record.status,
            record.daemon_id,
            record.pid,
            record.cols,
            record.rows,
            record.title,
            record.event_log_path,
            last_seq,
            record.snapshot_path,
            snapshot_seq,
            snapshot_crc32,
            snapshot_size,
        });
    }

    pub fn recordTerminalEnded(self: *Database, record: TerminalEndedRecord) !void {
        var stmt = try self.handle.prepareDynamic(update_terminal_ended_sql);
        defer stmt.deinit();

        const last_seq: i64 = @intCast(record.last_seq);
        try stmt.exec(.{}, .{
            record.status,
            record.cols,
            record.rows,
            last_seq,
            record.exit_code,
            record.signal,
            record.id,
        });
    }

    pub fn findTerminalSessionById(self: *Database, allocator: std.mem.Allocator, id: []const u8) !?TerminalSessionLookup {
        var stmt = try self.handle.prepareDynamic(find_terminal_by_id_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(TerminalSessionLookup, allocator, .{}, .{id});
    }

    pub fn findTerminalSessionByTerminalId(self: *Database, allocator: std.mem.Allocator, terminal_id: []const u8) !?TerminalSessionLookup {
        var stmt = try self.handle.prepareDynamic(find_terminal_by_terminal_id_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(TerminalSessionLookup, allocator, .{}, .{terminal_id});
    }

    pub fn listTerminalEventLogs(self: *Database, allocator: std.mem.Allocator) ![]TerminalEventLogRef {
        var stmt = try self.handle.prepareDynamic(list_terminal_event_logs_sql);
        defer stmt.deinit();
        var iter = try stmt.iteratorAlloc(TerminalEventLogRef, allocator, .{});

        var refs: std.ArrayList(TerminalEventLogRef) = .empty;
        errdefer {
            for (refs.items) |*item| item.deinit(allocator);
            refs.deinit(allocator);
        }

        while (try iter.nextAlloc(allocator, .{})) |row_value| {
            var row = row_value;
            errdefer row.deinit(allocator);
            if (refs.items.len >= event_log_refs_max) return error.TooManyEventLogRefs;
            try refs.append(allocator, row);
        }

        return refs.toOwnedSlice(allocator);
    }

    pub fn clearTerminalHistoryMetadata(self: *Database, session_id: []const u8) !void {
        {
            var stmt = try self.handle.prepareDynamic(delete_terminal_search_sql);
            defer stmt.deinit();
            try stmt.exec(.{}, .{session_id});
        }
        {
            var stmt = try self.handle.prepareDynamic(clear_terminal_history_metadata_sql);
            defer stmt.deinit();
            try stmt.exec(.{}, .{session_id});
        }
    }

    pub fn deleteTerminalSessionMetadata(self: *Database, session_id: []const u8) !void {
        {
            var stmt = try self.handle.prepareDynamic(delete_terminal_search_sql);
            defer stmt.deinit();
            try stmt.exec(.{}, .{session_id});
        }
        {
            var stmt = try self.handle.prepareDynamic(delete_terminal_session_sql);
            defer stmt.deinit();
            try stmt.exec(.{}, .{session_id});
        }
    }

    pub fn recordAgentSession(self: *Database, record: AgentSessionRecord) !void {
        var stmt = try self.handle.prepareDynamic(upsert_agent_session_sql);
        defer stmt.deinit();

        try stmt.exec(.{}, .{
            record.id,
            record.terminal_session_id,
            record.provider,
            record.native_session_id,
            record.original_argv_json,
            record.resume_argv_json,
            record.cwd,
            record.transcript_path,
            record.model,
            record.title,
            record.status,
        });
    }

    pub fn findAgentResumeForTerminal(self: *Database, allocator: std.mem.Allocator, terminal_session_id: []const u8) !?AgentResumeLookup {
        var stmt = try self.handle.prepareDynamic(find_agent_resume_by_terminal_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(AgentResumeLookup, allocator, .{}, .{terminal_session_id});
    }

    pub fn recordTerminalSearch(self: *Database, record: TerminalSearchRecord) !void {
        {
            var stmt = try self.handle.prepareDynamic(delete_terminal_search_sql);
            defer stmt.deinit();
            try stmt.exec(.{}, .{record.terminal_session_id});
        }
        {
            var stmt = try self.handle.prepareDynamic(insert_terminal_search_sql);
            defer stmt.deinit();
            try stmt.exec(.{}, .{
                record.terminal_session_id,
                record.workspace_id,
                record.title,
                record.excerpt,
            });
        }
    }

    pub fn searchTerminalExcerpts(self: *Database, allocator: std.mem.Allocator, query: []const u8, limit: u32) ![]TerminalSearchResult {
        if (limit > search_results_max) return error.SearchLimitTooLarge;

        var stmt = try self.handle.prepareDynamic(search_terminal_excerpts_sql);
        defer stmt.deinit();
        var iter = try stmt.iteratorAlloc(TerminalSearchResult, allocator, .{ query, limit });

        var results: std.ArrayList(TerminalSearchResult) = .empty;
        errdefer {
            for (results.items) |*item| item.deinit(allocator);
            results.deinit(allocator);
        }

        while (try iter.nextAlloc(allocator, .{})) |row_value| {
            var row = row_value;
            errdefer row.deinit(allocator);
            if (results.items.len >= search_results_max) return error.TooManySearchResults;
            try results.append(allocator, row);
        }

        return results.toOwnedSlice(allocator);
    }

    pub fn insertWorkspace(self: *Database, record: WorkspaceRecord) !void {
        var stmt = try self.handle.prepareDynamic(insert_workspace_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{
            record.id,
            record.name,
            record.root_path,
            record.git_common_dir,
            record.workspace_slug,
            record.default_branch,
            record.order_index,
            record.last_active_tab_id,
        });
    }

    pub fn updateWorkspace(self: *Database, record: WorkspaceRecord) !void {
        var stmt = try self.handle.prepareDynamic(update_workspace_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{
            record.name,
            record.git_common_dir,
            record.workspace_slug,
            record.default_branch,
            record.order_index,
            record.last_active_tab_id,
            record.id,
        });
    }

    pub fn reactivateWorkspace(self: *Database, record: WorkspaceRecord) !void {
        var stmt = try self.handle.prepareDynamic(reactivate_workspace_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{
            record.name,
            record.git_common_dir,
            record.workspace_slug,
            record.default_branch,
            record.order_index,
            record.last_active_tab_id,
            record.id,
        });
    }

    pub fn archiveWorkspace(self: *Database, workspace_id: []const u8) !void {
        var stmt = try self.handle.prepareDynamic(archive_workspace_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{workspace_id});
    }

    pub fn findWorkspaceById(self: *Database, allocator: std.mem.Allocator, workspace_id: []const u8) !?WorkspaceRow {
        var stmt = try self.handle.prepareDynamic(find_workspace_by_id_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(WorkspaceRow, allocator, .{}, .{workspace_id});
    }

    pub fn findWorkspaceByRoot(self: *Database, allocator: std.mem.Allocator, root_path: []const u8) !?WorkspaceRow {
        var stmt = try self.handle.prepareDynamic(find_workspace_by_root_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(WorkspaceRow, allocator, .{}, .{root_path});
    }

    pub fn listWorkspaces(self: *Database, allocator: std.mem.Allocator) ![]WorkspaceRow {
        var stmt = try self.handle.prepareDynamic(list_workspaces_sql);
        defer stmt.deinit();
        var iter = try stmt.iteratorAlloc(WorkspaceRow, allocator, .{});

        var rows: std.ArrayList(WorkspaceRow) = .empty;
        errdefer {
            for (rows.items) |*row| row.deinit(allocator);
            rows.deinit(allocator);
        }

        while (try iter.nextAlloc(allocator, .{})) |row_value| {
            var row = row_value;
            errdefer row.deinit(allocator);
            try rows.append(allocator, row);
        }

        return rows.toOwnedSlice(allocator);
    }

    pub fn nextWorkspaceOrder(self: *Database) !i64 {
        return (try self.handle.one(i64, next_workspace_order_sql, .{}, .{})) orelse error.SqliteUnexpectedNull;
    }

    pub fn reorderWorkspace(self: *Database, workspace_id: []const u8, order_index: i64) !void {
        var stmt = try self.handle.prepareDynamic(reorder_workspace_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{ order_index, workspace_id });
    }

    pub fn insertWorktree(self: *Database, record: WorktreeRecord) !void {
        if (try self.findReusableArchivedWorktree(record)) |archived_row| {
            var row = archived_row;
            defer row.deinit(self.allocator);
            try self.reactivateWorktree(row.id, record);
            return;
        }

        var stmt = try self.handle.prepareDynamic(insert_worktree_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{
            record.id,
            record.workspace_id,
            record.title,
            record.folder_name,
            record.path,
            record.branch,
            record.base_branch,
            record.target_branch,
            record.state,
            record.order_index,
            record.last_active_tab_id,
            record.last_error,
            record.created_by,
        });
    }

    fn reactivateWorktree(self: *Database, worktree_id: []const u8, record: WorktreeRecord) !void {
        var stmt = try self.handle.prepareDynamic(reactivate_worktree_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{
            record.workspace_id,
            record.title,
            record.folder_name,
            record.path,
            record.branch,
            record.base_branch,
            record.target_branch,
            record.state,
            record.order_index,
            record.last_active_tab_id,
            record.last_error,
            record.created_by,
            worktree_id,
        });
    }

    fn findReusableArchivedWorktree(self: *Database, record: WorktreeRecord) !?WorktreeRow {
        if (try self.findArchivedWorktreeByPath(record.path)) |row| return row;
        if (try self.findArchivedWorktreeByFolder(record.workspace_id, record.folder_name)) |row| return row;
        return try self.findArchivedWorktreeByBranch(record.workspace_id, record.branch);
    }

    fn findArchivedWorktreeByPath(self: *Database, path: []const u8) !?WorktreeRow {
        var stmt = try self.handle.prepareDynamic(find_archived_worktree_by_path_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(WorktreeRow, self.allocator, .{}, .{path});
    }

    fn findArchivedWorktreeByFolder(self: *Database, workspace_id: []const u8, folder_name: []const u8) !?WorktreeRow {
        var stmt = try self.handle.prepareDynamic(find_archived_worktree_by_folder_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(WorktreeRow, self.allocator, .{}, .{ workspace_id, folder_name });
    }

    fn findArchivedWorktreeByBranch(self: *Database, workspace_id: []const u8, branch: []const u8) !?WorktreeRow {
        var stmt = try self.handle.prepareDynamic(find_archived_worktree_by_branch_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(WorktreeRow, self.allocator, .{}, .{ workspace_id, branch });
    }

    pub fn updateWorktreeState(self: *Database, worktree_id: []const u8, state: []const u8, last_error: ?[]const u8) !void {
        var stmt = try self.handle.prepareDynamic(update_worktree_state_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{ state, last_error, worktree_id });
    }

    pub fn updateWorktreeGit(self: *Database, worktree_id: []const u8, branch: []const u8, state: []const u8) !void {
        var stmt = try self.handle.prepareDynamic(update_worktree_git_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{ branch, state, worktree_id });
    }

    pub fn archiveWorktree(self: *Database, worktree_id: []const u8) !void {
        var stmt = try self.handle.prepareDynamic(archive_worktree_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{worktree_id});
    }

    pub fn archiveWorktreesForWorkspace(self: *Database, workspace_id: []const u8) !void {
        var stmt = try self.handle.prepareDynamic(archive_worktrees_for_workspace_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{workspace_id});
    }

    pub fn findWorktreeById(self: *Database, allocator: std.mem.Allocator, worktree_id: []const u8) !?WorktreeRow {
        var stmt = try self.handle.prepareDynamic(find_worktree_by_id_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(WorktreeRow, allocator, .{}, .{worktree_id});
    }

    pub fn findWorktreeByPath(self: *Database, allocator: std.mem.Allocator, path: []const u8) !?WorktreeRow {
        var stmt = try self.handle.prepareDynamic(find_worktree_by_path_sql);
        defer stmt.deinit();
        return try stmt.oneAlloc(WorktreeRow, allocator, .{}, .{path});
    }

    pub fn listWorktreesForWorkspace(self: *Database, allocator: std.mem.Allocator, workspace_id: []const u8) ![]WorktreeRow {
        var stmt = try self.handle.prepareDynamic(list_worktrees_for_workspace_sql);
        defer stmt.deinit();
        var iter = try stmt.iteratorAlloc(WorktreeRow, allocator, .{workspace_id});

        var rows: std.ArrayList(WorktreeRow) = .empty;
        errdefer {
            for (rows.items) |*row| row.deinit(allocator);
            rows.deinit(allocator);
        }

        while (try iter.nextAlloc(allocator, .{})) |row_value| {
            var row = row_value;
            errdefer row.deinit(allocator);
            try rows.append(allocator, row);
        }

        return rows.toOwnedSlice(allocator);
    }

    pub fn nextWorktreeOrder(self: *Database, workspace_id: []const u8) !i64 {
        var stmt = try self.handle.prepareDynamic(next_worktree_order_sql);
        defer stmt.deinit();
        return (try stmt.one(i64, .{}, .{workspace_id})) orelse error.SqliteUnexpectedNull;
    }

    pub fn reorderWorktree(self: *Database, worktree_id: []const u8, order_index: i64) !void {
        var stmt = try self.handle.prepareDynamic(reorder_worktree_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{ order_index, worktree_id });
    }

    pub fn worktreePathExists(self: *Database, path: []const u8) !bool {
        var stmt = try self.handle.prepareDynamic(worktree_path_exists_sql);
        defer stmt.deinit();
        return (try stmt.one(u8, .{}, .{path})) != null;
    }

    pub fn archivedWorktreePathExists(self: *Database, path: []const u8) !bool {
        var stmt = try self.handle.prepareDynamic(archived_worktree_path_exists_sql);
        defer stmt.deinit();
        return (try stmt.one(u8, .{}, .{path})) != null;
    }

    pub fn worktreeBranchExists(self: *Database, workspace_id: []const u8, branch: []const u8) !bool {
        var stmt = try self.handle.prepareDynamic(worktree_branch_exists_sql);
        defer stmt.deinit();
        return (try stmt.one(u8, .{}, .{ workspace_id, branch })) != null;
    }

    pub fn worktreeFolderExists(self: *Database, workspace_id: []const u8, folder_name: []const u8) !bool {
        var stmt = try self.handle.prepareDynamic(worktree_folder_exists_sql);
        defer stmt.deinit();
        return (try stmt.one(u8, .{}, .{ workspace_id, folder_name })) != null;
    }

    pub fn countTerminalSessions(self: *Database) !u64 {
        return (try self.handle.one(u64, "SELECT COUNT(*) FROM terminal_sessions;", .{}, .{})) orelse error.SqliteUnexpectedNull;
    }

    pub fn countWorkspaces(self: *Database) !u64 {
        return (try self.handle.one(u64, count_workspaces_sql, .{}, .{})) orelse error.SqliteUnexpectedNull;
    }

    pub fn countWorktrees(self: *Database) !u64 {
        return (try self.handle.one(u64, count_worktrees_sql, .{}, .{})) orelse error.SqliteUnexpectedNull;
    }

    pub fn countTerminalSessionsByStatus(self: *Database, status: []const u8) !u64 {
        var stmt = try self.handle.prepare("SELECT COUNT(*) FROM terminal_sessions WHERE status = ?;");
        defer stmt.deinit();
        return (try stmt.one(u64, .{}, .{status})) orelse error.SqliteUnexpectedNull;
    }

    pub fn countAgentSessions(self: *Database) !u64 {
        return (try self.handle.one(u64, "SELECT COUNT(*) FROM agent_sessions;", .{}, .{})) orelse error.SqliteUnexpectedNull;
    }

    pub fn countSearchRows(self: *Database) !u64 {
        return (try self.handle.one(u64, "SELECT COUNT(*) FROM terminal_search;", .{}, .{})) orelse error.SqliteUnexpectedNull;
    }

    fn exec(self: *Database, sql: []const u8) !void {
        try self.handle.execMulti(sql, .{});
    }

    fn hasMigration(self: *Database, version: i64) !bool {
        var stmt = try self.handle.prepare("SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1;");
        defer stmt.deinit();
        return (try stmt.one(u8, .{}, .{version})) != null;
    }

    fn markMigration(self: *Database, version: i64) !void {
        var stmt = try self.handle.prepare("INSERT INTO schema_migrations(version) VALUES (?);");
        defer stmt.deinit();
        try stmt.exec(.{}, .{version});
    }
};

test "sqlite migrations are registered in order" {
    try std.testing.expectEqual(@as(usize, 5), migrations.len);
    try std.testing.expect(std.mem.indexOf(u8, migrations[0], "terminal_sessions") != null);
}

test "sqlite database applies migrations and records terminal sessions" {
    var database = try Database.openInMemory(std.testing.allocator);
    defer database.deinit();

    try database.recordTerminalSession(.{
        .id = "session-1",
        .terminal_id = "terminal-1",
        .cwd = "/tmp",
        .argv_json = "[\"bash\"]",
        .status = "live",
        .pid = 123,
        .cols = 80,
        .rows = 24,
        .event_log_path = "/tmp/events.tauev",
        .last_seq = 1,
    });

    try std.testing.expectEqual(@as(u64, 1), try database.countTerminalSessions());
    try std.testing.expectEqual(@as(u64, 1), try database.countTerminalSessionsByStatus("live"));

    try database.recordTerminalEnded(.{
        .id = "session-1",
        .status = "exited",
        .cols = 80,
        .rows = 24,
        .last_seq = 2,
        .exit_code = 0,
        .signal = 0,
    });

    try std.testing.expectEqual(@as(u64, 0), try database.countTerminalSessionsByStatus("live"));
    try std.testing.expectEqual(@as(u64, 1), try database.countTerminalSessionsByStatus("exited"));
}

test "sqlite database looks up terminal restart metadata" {
    var database = try Database.openInMemory(std.testing.allocator);
    defer database.deinit();

    try database.recordTerminalSession(.{
        .id = "session-restart",
        .terminal_id = "terminal-restart",
        .cwd = "/project",
        .argv_json = "[\"bash\",\"-lc\",\"echo ok\"]",
        .status = "detached",
        .cols = 100,
        .rows = 30,
        .event_log_path = "/tmp/restart/events.tauev",
        .last_seq = 42,
    });

    var by_id = (try database.findTerminalSessionById(std.testing.allocator, "session-restart")).?;
    defer by_id.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("terminal-restart", by_id.terminal_id);
    try std.testing.expectEqualStrings("/project", by_id.cwd.?);
    try std.testing.expectEqual(@as(u16, 100), by_id.cols);
    try std.testing.expectEqual(@as(u64, 42), by_id.last_seq);

    var by_terminal = (try database.findTerminalSessionByTerminalId(std.testing.allocator, "terminal-restart")).?;
    defer by_terminal.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("session-restart", by_terminal.id);
}

test "sqlite database records agent resume metadata and FTS excerpts" {
    var database = try Database.openInMemory(std.testing.allocator);
    defer database.deinit();

    try database.recordTerminalSession(.{
        .id = "session-agent",
        .terminal_id = "terminal-agent",
        .status = "live",
        .cols = 80,
        .rows = 24,
        .event_log_path = "/tmp/agent/events.tauev",
        .last_seq = 1,
    });

    try database.recordAgentSession(.{
        .id = "agent-session-agent-codex",
        .terminal_session_id = "session-agent",
        .provider = "codex",
        .native_session_id = "native-123",
        .original_argv_json = "[\"codex\"]",
        .resume_argv_json = "[\"codex\",\"resume\",\"native-123\"]",
        .status = "resumable",
    });

    try std.testing.expectEqual(@as(u64, 1), try database.countAgentSessions());
    var agent_resume = (try database.findAgentResumeForTerminal(std.testing.allocator, "session-agent")).?;
    defer agent_resume.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("codex", agent_resume.provider);
    try std.testing.expectEqualStrings("native-123", agent_resume.native_session_id);

    try database.recordTerminalSearch(.{
        .terminal_session_id = "session-agent",
        .title = "Agent",
        .excerpt = "build failed with uniqueerror",
    });
    try std.testing.expectEqual(@as(u64, 1), try database.countSearchRows());

    const results = try database.searchTerminalExcerpts(std.testing.allocator, "uniqueerror", 10);
    defer {
        for (results) |*result| result.deinit(std.testing.allocator);
        std.testing.allocator.free(results);
    }
    try std.testing.expectEqual(@as(usize, 1), results.len);
    try std.testing.expectEqualStrings("session-agent", results[0].terminal_session_id);

    try database.clearTerminalHistoryMetadata("session-agent");
    try std.testing.expectEqual(@as(u64, 0), try database.countSearchRows());
}

test "sqlite database records workspaces and worktrees" {
    var database = try Database.openInMemory(std.testing.allocator);
    defer database.deinit();

    const branch_unique_index_count = (try database.handle.one(
        u64,
        "SELECT COUNT(*) FROM pragma_index_list('worktrees') WHERE name = 'idx_worktrees_workspace_branch' AND \"unique\" = 1;",
        .{},
        .{},
    )) orelse error.SqliteUnexpectedNull;
    try std.testing.expectEqual(@as(u64, 1), branch_unique_index_count);

    try database.insertWorkspace(.{
        .id = "workspace-1",
        .name = "tau",
        .root_path = "/repo/tau",
        .git_common_dir = "/repo/tau/.git",
        .workspace_slug = "tau",
        .default_branch = "main",
        .order_index = 0,
    });
    try std.testing.expectEqual(@as(u64, 1), try database.countWorkspaces());

    var workspace = (try database.findWorkspaceById(std.testing.allocator, "workspace-1")).?;
    defer workspace.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("/repo/tau", workspace.root_path);

    try database.insertWorktree(.{
        .id = "worktree-1",
        .workspace_id = "workspace-1",
        .title = "New worktree",
        .folder_name = "luminous-galileo-a13f",
        .path = "/tmp/luminous-galileo-a13f",
        .branch = "luminous-galileo-a13f",
        .base_branch = "main",
        .target_branch = "main",
        .state = "creating",
        .order_index = 0,
    });
    try database.updateWorktreeGit("worktree-1", "renamed", "active");
    try std.testing.expectEqual(@as(u64, 1), try database.countWorktrees());
    try std.testing.expect(try database.worktreePathExists("/tmp/luminous-galileo-a13f"));
    try std.testing.expect(try database.worktreeBranchExists("workspace-1", "renamed"));

    const worktrees = try database.listWorktreesForWorkspace(std.testing.allocator, "workspace-1");
    defer {
        for (worktrees) |*row| row.deinit(std.testing.allocator);
        std.testing.allocator.free(worktrees);
    }
    try std.testing.expectEqual(@as(usize, 1), worktrees.len);
    try std.testing.expectEqualStrings("active", worktrees[0].state);
    try std.testing.expectEqualStrings("renamed", worktrees[0].branch);

    try database.archiveWorktree("worktree-1");
    const remaining = try database.listWorktreesForWorkspace(std.testing.allocator, "workspace-1");
    defer std.testing.allocator.free(remaining);
    try std.testing.expectEqual(@as(usize, 0), remaining.len);
    try std.testing.expect(!try database.worktreePathExists("/tmp/luminous-galileo-a13f"));
    try std.testing.expect(!try database.worktreeFolderExists("workspace-1", "luminous-galileo-a13f"));

    try database.insertWorktree(.{
        .id = "worktree-2",
        .workspace_id = "workspace-1",
        .title = "Recreated worktree",
        .folder_name = "luminous-galileo-a13f",
        .path = "/tmp/luminous-galileo-a13f",
        .branch = "luminous-galileo-a13f",
        .state = "untracked",
        .order_index = 1,
    });
    var recreated = (try database.findWorktreeByPath(std.testing.allocator, "/tmp/luminous-galileo-a13f")).?;
    defer recreated.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(u64, 1), try database.countWorktrees());
    try std.testing.expectEqualStrings("worktree-1", recreated.id);
    try std.testing.expectEqualStrings("untracked", recreated.state);

    try database.archiveWorkspace("workspace-1");
    var archived_workspace = (try database.findWorkspaceById(std.testing.allocator, "workspace-1")).?;
    defer archived_workspace.deinit(std.testing.allocator);
    try std.testing.expect(archived_workspace.archived_at != null);
    try database.updateWorkspace(.{
        .id = "workspace-1",
        .name = "tau",
        .root_path = "/repo/tau",
        .git_common_dir = "/repo/tau/.git",
        .workspace_slug = "tau",
        .default_branch = "main",
        .order_index = 0,
    });
    var still_archived_workspace = (try database.findWorkspaceById(std.testing.allocator, "workspace-1")).?;
    defer still_archived_workspace.deinit(std.testing.allocator);
    try std.testing.expect(still_archived_workspace.archived_at != null);
    try database.reactivateWorkspace(.{
        .id = "workspace-1",
        .name = "tau",
        .root_path = "/repo/tau",
        .git_common_dir = "/repo/tau/.git",
        .workspace_slug = "tau",
        .default_branch = "main",
        .order_index = 0,
    });
    var reactivated_workspace = (try database.findWorkspaceById(std.testing.allocator, "workspace-1")).?;
    defer reactivated_workspace.deinit(std.testing.allocator);
    try std.testing.expect(reactivated_workspace.archived_at == null);
    try database.archiveWorktreesForWorkspace("workspace-1");
    const archived_worktrees = try database.listWorktreesForWorkspace(std.testing.allocator, "workspace-1");
    defer std.testing.allocator.free(archived_worktrees);
    try std.testing.expectEqual(@as(usize, 0), archived_worktrees.len);
    try std.testing.expect(!try database.worktreePathExists("/tmp/luminous-galileo-a13f"));
    try std.testing.expect(!try database.worktreeFolderExists("workspace-1", "luminous-galileo-a13f"));
    try std.testing.expect(!try database.worktreeBranchExists("workspace-1", "luminous-galileo-a13f"));

    try database.insertWorktree(.{
        .id = "worktree-3",
        .workspace_id = "workspace-1",
        .title = "Reused branch",
        .folder_name = "luminous-galileo-a13f",
        .path = "/tmp/luminous-galileo-a13f",
        .branch = "luminous-galileo-a13f",
        .state = "active",
        .order_index = 3,
    });
    var reused = (try database.findWorktreeByPath(std.testing.allocator, "/tmp/luminous-galileo-a13f")).?;
    defer reused.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(u64, 1), try database.countWorktrees());
    try std.testing.expectEqualStrings("worktree-1", reused.id);
    try std.testing.expectEqualStrings("active", reused.state);
}
