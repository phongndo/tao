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

pub const migrations = [_][]const u8{
    migration_001_terminal_sessions,
    migration_002_agent_sessions,
    migration_003_terminal_search,
};

test "sqlite migrations are registered in order" {
    const std = @import("std");
    try std.testing.expectEqual(@as(usize, 3), migrations.len);
    try std.testing.expect(std.mem.indexOf(u8, migrations[0], "terminal_sessions") != null);
}
