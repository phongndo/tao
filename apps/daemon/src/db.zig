const std = @import("std");

const sqlite3 = opaque {};
const sqlite3_stmt = opaque {};

extern "c" fn sqlite3_open_v2(filename: [*:0]const u8, ppDb: *?*sqlite3, flags: c_int, zVfs: ?[*:0]const u8) c_int;
extern "c" fn sqlite3_close(db: *sqlite3) c_int;
extern "c" fn sqlite3_exec(db: *sqlite3, sql: [*:0]const u8, callback: ?*const anyopaque, arg: ?*anyopaque, errmsg: *?[*:0]u8) c_int;
extern "c" fn sqlite3_free(value: ?*anyopaque) void;
extern "c" fn sqlite3_prepare_v2(db: *sqlite3, sql: [*:0]const u8, nByte: c_int, ppStmt: *?*sqlite3_stmt, pzTail: ?*[*:0]const u8) c_int;
extern "c" fn sqlite3_finalize(stmt: *sqlite3_stmt) c_int;
extern "c" fn sqlite3_step(stmt: *sqlite3_stmt) c_int;
extern "c" fn sqlite3_bind_int(stmt: *sqlite3_stmt, index: c_int, value: c_int) c_int;
extern "c" fn sqlite3_bind_int64(stmt: *sqlite3_stmt, index: c_int, value: i64) c_int;
extern "c" fn sqlite3_bind_null(stmt: *sqlite3_stmt, index: c_int) c_int;
extern "c" fn sqlite3_bind_text(stmt: *sqlite3_stmt, index: c_int, value: [*]const u8, value_len: c_int, destructor: ?*const anyopaque) c_int;

const sqlite_ok = 0;
const sqlite_row = 100;
const sqlite_done = 101;
const sqlite_open_readwrite = 0x0000_0002;
const sqlite_open_create = 0x0000_0004;
const sqlite_open_nomutex = 0x0000_8000;

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

pub const migrations = [_][]const u8{
    migration_001_terminal_sessions,
    migration_002_agent_sessions,
    migration_003_terminal_search,
};

const create_migrations_table_sql =
    \\CREATE TABLE IF NOT EXISTS schema_migrations (
    \\    version INTEGER PRIMARY KEY,
    \\    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    \\) STRICT;
;

const upsert_terminal_session_sql =
    \\INSERT INTO terminal_sessions (
    \\    id, terminal_id, workspace_id, cwd, argv_json, status, daemon_id, pid,
    \\    cols, rows, title, event_log_path, last_seq, started_at, last_activity_at
    \\) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    \\ON CONFLICT(id) DO UPDATE SET
    \\    terminal_id = excluded.terminal_id,
    \\    workspace_id = excluded.workspace_id,
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

pub const TerminalSessionRecord = struct {
    id: []const u8,
    terminal_id: []const u8,
    workspace_id: ?[]const u8 = null,
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

pub const Database = struct {
    allocator: std.mem.Allocator,
    handle: *sqlite3,

    pub fn open(allocator: std.mem.Allocator, path: []const u8) !Database {
        const path_z = try allocator.dupeZ(u8, path);
        defer allocator.free(path_z);

        var maybe_handle: ?*sqlite3 = null;
        const flags = sqlite_open_readwrite | sqlite_open_create | sqlite_open_nomutex;
        if (sqlite3_open_v2(path_z.ptr, &maybe_handle, flags, null) != sqlite_ok) {
            if (maybe_handle) |handle| _ = sqlite3_close(handle);
            return error.SqliteOpenFailed;
        }

        var database = Database{ .allocator = allocator, .handle = maybe_handle.? };
        errdefer database.deinit();

        try database.exec("PRAGMA journal_mode = WAL;");
        try database.exec("PRAGMA foreign_keys = ON;");
        try database.exec("PRAGMA busy_timeout = 5000;");
        try database.migrate();

        return database;
    }

    pub fn openInMemory(allocator: std.mem.Allocator) !Database {
        return open(allocator, ":memory:");
    }

    pub fn deinit(self: *Database) void {
        _ = sqlite3_close(self.handle);
        self.* = undefined;
    }

    pub fn migrate(self: *Database) !void {
        try self.exec(create_migrations_table_sql);
        for (migrations, 0..) |migration, index| {
            const version: c_int = @intCast(index + 1);
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
        var stmt = try self.prepare(upsert_terminal_session_sql);
        defer stmt.deinit();

        try stmt.bindText(1, record.id);
        try stmt.bindText(2, record.terminal_id);
        try stmt.bindNullableText(3, record.workspace_id);
        try stmt.bindNullableText(4, record.cwd);
        try stmt.bindNullableText(5, record.argv_json);
        try stmt.bindText(6, record.status);
        try stmt.bindNullableText(7, record.daemon_id);
        try stmt.bindNullableInt64(8, record.pid);
        try stmt.bindInt64(9, record.cols);
        try stmt.bindInt64(10, record.rows);
        try stmt.bindNullableText(11, record.title);
        try stmt.bindText(12, record.event_log_path);
        try stmt.bindInt64(13, record.last_seq);
        try stmt.stepDone();
    }

    pub fn recordTerminalEnded(self: *Database, record: TerminalEndedRecord) !void {
        var stmt = try self.prepare(update_terminal_ended_sql);
        defer stmt.deinit();

        try stmt.bindText(1, record.status);
        try stmt.bindInt64(2, record.cols);
        try stmt.bindInt64(3, record.rows);
        try stmt.bindInt64(4, record.last_seq);
        try stmt.bindInt64(5, record.exit_code);
        try stmt.bindInt64(6, record.signal);
        try stmt.bindText(7, record.id);
        try stmt.stepDone();
    }

    pub fn countTerminalSessions(self: *Database) !u64 {
        var stmt = try self.prepare("SELECT COUNT(*) FROM terminal_sessions;");
        defer stmt.deinit();
        return stmt.stepCount();
    }

    pub fn countTerminalSessionsByStatus(self: *Database, status: []const u8) !u64 {
        var stmt = try self.prepare("SELECT COUNT(*) FROM terminal_sessions WHERE status = ?;");
        defer stmt.deinit();
        try stmt.bindText(1, status);
        return stmt.stepCount();
    }

    fn exec(self: *Database, sql: []const u8) !void {
        const sql_z = try self.allocator.dupeZ(u8, sql);
        defer self.allocator.free(sql_z);

        var error_message: ?[*:0]u8 = null;
        const rc = sqlite3_exec(self.handle, sql_z.ptr, null, null, &error_message);
        if (error_message) |message| sqlite3_free(message);
        if (rc != sqlite_ok) return error.SqliteExecFailed;
    }

    fn prepare(self: *Database, sql: []const u8) !Statement {
        const sql_z = try self.allocator.dupeZ(u8, sql);
        defer self.allocator.free(sql_z);

        var maybe_stmt: ?*sqlite3_stmt = null;
        if (sqlite3_prepare_v2(self.handle, sql_z.ptr, -1, &maybe_stmt, null) != sqlite_ok) return error.SqlitePrepareFailed;
        return .{ .handle = maybe_stmt.? };
    }

    fn hasMigration(self: *Database, version: c_int) !bool {
        var stmt = try self.prepare("SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1;");
        defer stmt.deinit();
        try stmt.bindInt(1, version);
        return try stmt.stepRowExists();
    }

    fn markMigration(self: *Database, version: c_int) !void {
        var stmt = try self.prepare("INSERT INTO schema_migrations(version) VALUES (?);");
        defer stmt.deinit();
        try stmt.bindInt(1, version);
        try stmt.stepDone();
    }
};

const Statement = struct {
    handle: *sqlite3_stmt,

    fn deinit(self: *Statement) void {
        _ = sqlite3_finalize(self.handle);
        self.* = undefined;
    }

    fn bindInt(self: *Statement, index: c_int, value: c_int) !void {
        if (sqlite3_bind_int(self.handle, index, value) != sqlite_ok) return error.SqliteBindFailed;
    }

    fn bindInt64(self: *Statement, index: c_int, value: anytype) !void {
        if (sqlite3_bind_int64(self.handle, index, @intCast(value)) != sqlite_ok) return error.SqliteBindFailed;
    }

    fn bindNullableInt64(self: *Statement, index: c_int, value: ?i64) !void {
        if (value) |some| return self.bindInt64(index, some);
        if (sqlite3_bind_null(self.handle, index) != sqlite_ok) return error.SqliteBindFailed;
    }

    fn bindText(self: *Statement, index: c_int, value: []const u8) !void {
        if (value.len > std.math.maxInt(c_int)) return error.SqliteValueTooLarge;
        if (sqlite3_bind_text(self.handle, index, value.ptr, @intCast(value.len), null) != sqlite_ok) return error.SqliteBindFailed;
    }

    fn bindNullableText(self: *Statement, index: c_int, value: ?[]const u8) !void {
        if (value) |some| return self.bindText(index, some);
        if (sqlite3_bind_null(self.handle, index) != sqlite_ok) return error.SqliteBindFailed;
    }

    fn stepDone(self: *Statement) !void {
        const rc = sqlite3_step(self.handle);
        if (rc != sqlite_done) return error.SqliteStepFailed;
    }

    fn stepRowExists(self: *Statement) !bool {
        const rc = sqlite3_step(self.handle);
        return switch (rc) {
            sqlite_row => true,
            sqlite_done => false,
            else => error.SqliteStepFailed,
        };
    }

    fn stepCount(self: *Statement) !u64 {
        const rc = sqlite3_step(self.handle);
        if (rc != sqlite_row) return error.SqliteStepFailed;
        return @intCast(sqlite3_column_int64(self.handle, 0));
    }
};

extern "c" fn sqlite3_column_int64(stmt: *sqlite3_stmt, index: c_int) i64;

test "sqlite migrations are registered in order" {
    try std.testing.expectEqual(@as(usize, 3), migrations.len);
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
        .event_log_path = "/tmp/events.taoev",
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
