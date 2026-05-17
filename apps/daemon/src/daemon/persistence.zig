const std = @import("std");
const cleanup = @import("../cleanup.zig");
const event_log = @import("../event_log.zig");
const rpc = @import("../rpc.zig");
const session = @import("../session.zig");
const snapshot = @import("../snapshot.zig");

const util = @import("util.zig");
const types = @import("types.zig");

const RestoreResult = types.RestoreResult;
const SearchExcerptSnapshot = types.SearchExcerptSnapshot;
const SettingsJson = types.SettingsJson;

const fileExists = util.fileExists;
const argvJsonAlloc = util.argvJsonAlloc;
const parseArgvJson = util.parseArgvJson;
const isLiveAttachable = util.isLiveAttachable;

pub fn restoreSessionFromDatabaseLocked(
    self: anytype,
    session_id: []const u8,
    request: rpc.ControlRequestJson,
) !?RestoreResult {
    if (!self.persistence.enabled) return null;
    const database = if (self.database) |*database| database else return null;
    var record = (try database.findTerminalSessionById(self.allocator, session_id)) orelse record: {
        const terminal_id = request.requestTerminalId() orelse return null;
        break :record (try database.findTerminalSessionByTerminalId(self.allocator, terminal_id)) orelse return null;
    };
    defer record.deinit(self.allocator);

    const resume_lookup = try database.findAgentResumeForTerminal(self.allocator, record.id);
    var mutable_resume_lookup = resume_lookup;
    defer if (mutable_resume_lookup) |*lookup| lookup.deinit(self.allocator);

    const cols = request.cols orelse record.cols;
    const rows = request.rows orelse record.rows;
    const cwd = request.cwd orelse record.cwd;
    const terminal_id = request.requestTerminalId() orelse record.terminal_id;

    if (mutable_resume_lookup) |lookup| {
        if (try self.restoreSessionWithArgvJsonLocked(session_id, terminal_id, cwd, cols, rows, lookup.resume_argv_json, "resumed")) |restored| {
            std.log.info("restored persisted session {s} with native agent resume", .{restored.id});
            var result: RestoreResult = .{
                .item = restored,
                .attach_kind = .agent_resume,
                .agent_provider = try self.allocator.dupe(u8, lookup.provider),
                .native_session_id = try self.allocator.dupe(u8, lookup.native_session_id),
            };
            errdefer result.deinit(self.allocator);
            return result;
        }

        std.log.warn("agent resume argv for {s} was unusable; falling back to saved command", .{record.id});
    }

    const restart_argv_json = record.argv_json orelse return null;
    const restored = (try self.restoreSessionWithArgvJsonLocked(session_id, terminal_id, cwd, cols, rows, restart_argv_json, "running")) orelse return null;
    std.log.info("restored persisted session {s} with saved command", .{restored.id});
    return .{
        .item = restored,
        .attach_kind = .command_resume,
    };
}

pub fn restoreSessionWithArgvJsonLocked(
    self: anytype,
    session_id: []const u8,
    terminal_id: []const u8,
    cwd: ?[]const u8,
    cols: u16,
    rows: u16,
    argv_json: []const u8,
    agent_status: []const u8,
) !?*session.TerminalSession {
    var parsed_argv = parseArgvJson(self.allocator, argv_json) catch |err| {
        std.log.warn("failed to parse restart argv for {s}: {t}", .{ session_id, err });
        return null;
    };
    defer parsed_argv.deinit();

    const argv = parsed_argv.items();
    if (argv.len == 0) return null;

    const restored = try self.sessions.create(.{
        .session_id = session_id,
        .terminal_id = terminal_id,
        .cols = cols,
        .rows = rows,
        .cwd = cwd,
        .argv = argv,
    });
    var restore_committed = false;
    errdefer {
        if (!restore_committed) _ = self.sessions.remove(session_id);
    }
    restored.status = .live;

    try self.ensureSessionPersistence(restored);
    self.ensureSessionProcess(restored, argv) catch |err| {
        std.log.warn("failed to restore session process for {s}: {t}", .{ session_id, err });
        _ = self.sessions.remove(session_id);
        return null;
    };
    if (!isLiveAttachable(restored)) {
        _ = self.sessions.remove(session_id);
        return null;
    }
    const restored_id = try self.allocator.dupe(u8, restored.id);
    defer self.allocator.free(restored_id);

    if (restored.event_log_path) |path| {
        _ = event_log.appendResize(self.allocator, path, &restored.last_seq, cols, rows) catch |err| {
            std.log.warn("failed to append restored resize frame for {s}: {t}", .{ restored.id, err });
        };
    }

    const current_argv_json = try argvJsonAlloc(self.allocator, argv);
    defer if (current_argv_json) |json| self.allocator.free(json);
    self.recordTerminalSessionLocked(restored, current_argv_json);
    var agent_snapshot = self.agentDetectionSnapshotFromArgvLocked(restored, argv, current_argv_json, agent_status) catch |err| blk: {
        std.log.warn("failed to prepare restored agent metadata for {s}: {t}", .{ restored.id, err });
        break :blk null;
    };
    try self.startSessionReaderLocked(restored);

    restore_committed = true;
    self.unlock();
    defer if (agent_snapshot) |*value| value.deinit(self.allocator);
    if (agent_snapshot) |*value| self.recordAgentSessionFromSnapshot(value);
    self.lock();

    return self.sessions.find(restored_id);
}

pub fn ensureSessionPersistence(self: anytype, item: *session.TerminalSession) !void {
    if (!self.persistence.enabled) {
        item.disablePersistence(self.allocator);
        return;
    }
    if (item.event_log_path != null and item.excerpt_path != null and item.session_dir != null and item.snapshot_path != null) return;

    var files = try event_log.openPersistentSession(self.allocator, self.config.sessions_dir, item.id);
    errdefer files.deinit(self.allocator);
    try item.installPersistence(self.allocator, files);
}

pub fn applyPersistencePolicyToSessionsLocked(self: anytype) void {
    for (self.sessions.sessions.items) |*item| {
        if (self.persistence.enabled) {
            self.ensureSessionPersistence(item) catch |err| {
                std.log.warn("failed to enable persistence for {s}: {t}", .{ item.id, err });
            };
        } else {
            item.disablePersistence(self.allocator);
        }
    }
}

pub fn reloadPersistencePolicyFromSettingsLocked(self: anytype) void {
    const settings_path = std.fs.path.join(self.allocator, &.{ self.config.root_dir, "settings.json" }) catch |err| {
        std.log.warn("failed to allocate settings path: {t}", .{err});
        return;
    };
    defer self.allocator.free(settings_path);

    const bytes = std.fs.cwd().readFileAlloc(self.allocator, settings_path, 64 * 1024) catch |err| switch (err) {
        error.FileNotFound => return,
        else => {
            std.log.warn("failed to read persistence settings: {t}", .{err});
            return;
        },
    };
    defer self.allocator.free(bytes);

    var parsed = std.json.parseFromSlice(SettingsJson, self.allocator, bytes, .{
        .ignore_unknown_fields = true,
    }) catch |err| {
        std.log.warn("failed to parse persistence settings: {t}", .{err});
        return;
    };
    defer parsed.deinit();

    const persistence = parsed.value.persistence orelse return;
    if (persistence.enabled) |enabled| self.persistence.enabled = enabled;
    if (persistence.persistInput orelse persistence.persist_input) |persist_input| self.persistence.persist_input = persist_input;
    self.applyPersistencePolicyToSessionsLocked();
}

pub fn resetSessionHistoryLocked(self: anytype, item: *session.TerminalSession) !void {
    const item_id = try self.allocator.dupe(u8, item.id);
    defer self.allocator.free(item_id);
    const snapshot_path = if (item.snapshot_path) |path| try self.allocator.dupe(u8, path) else null;
    defer if (snapshot_path) |path| self.allocator.free(path);

    if (!self.persistence.enabled) {
        self.unlock();
        if (snapshot_path) |path| {
            snapshot.deleteCurrentScreenPath(path) catch |err| {
                std.log.warn("failed to delete current-screen snapshot for {s}: {t}", .{ item_id, err });
            };
        }
        _ = cleanup.deleteSessionDir(self.allocator, self.config.sessions_dir, item_id) catch |err| {
            std.log.warn("failed to delete disabled-persistence history for {s}: {t}", .{ item_id, err });
        };
        self.lock();
        const current = self.sessions.find(item_id) orelse return;
        current.disablePersistence(self.allocator);
        current.clearPendingOutput(self.allocator);
        if (self.database) |*database| {
            database.deleteTerminalSessionMetadata(item_id) catch |err| {
                std.log.warn("failed to delete disabled-persistence metadata for {s}: {t}", .{ item_id, err });
            };
        }
        return;
    }
    self.unlock();
    if (snapshot_path) |path| {
        snapshot.deleteCurrentScreenPath(path) catch |err| {
            std.log.warn("failed to delete current-screen snapshot for {s}: {t}", .{ item_id, err });
        };
    }
    var files = event_log.resetPersistentSession(self.allocator, self.config.sessions_dir, item_id) catch |err| {
        self.lock();
        return err;
    };
    self.lock();
    errdefer files.deinit(self.allocator);
    const current = self.sessions.find(item_id) orelse {
        files.deinit(self.allocator);
        return;
    };
    try current.installPersistence(self.allocator, files);
    current.clearPendingOutput(self.allocator);
    current.clearSnapshotMetadata();

    if (self.database) |*database| {
        database.clearTerminalHistoryMetadata(current.id) catch |err| {
            std.log.warn("failed to clear metadata history for {s}: {t}", .{ current.id, err });
        };
    }

    if (isLiveAttachable(current)) {
        if (current.event_log_path) |path| {
            _ = event_log.appendResize(self.allocator, path, &current.last_seq, current.cols, current.rows) catch |err| {
                std.log.warn("failed to append reset resize frame for {s}: {t}", .{ current.id, err });
            };
        }
    }

    self.recordTerminalSessionLocked(current, null);
}

pub fn recordTerminalSessionLocked(self: anytype, item: *const session.TerminalSession, argv_json: ?[]const u8) void {
    if (!self.persistence.enabled) return;
    const database = if (self.database) |*database| database else return;
    const event_log_path = item.event_log_path orelse return;
    const pid: ?i64 = if (item.pidU32()) |value| @intCast(value) else null;
    const snapshot_path = if (item.snapshot_crc32 != null) item.snapshot_path else null;

    database.recordTerminalSession(.{
        .id = item.id,
        .terminal_id = item.terminal_id,
        .cwd = item.cwd,
        .argv_json = argv_json,
        .status = item.status.text(),
        .pid = pid,
        .cols = item.cols,
        .rows = item.rows,
        .event_log_path = event_log_path,
        .last_seq = item.last_seq,
        .snapshot_path = snapshot_path,
        .snapshot_seq = item.snapshot_seq,
        .snapshot_crc32 = item.snapshot_crc32,
        .snapshot_size = if (item.snapshot_crc32 != null) item.snapshot_size else null,
    }) catch |err| {
        std.log.warn("failed to record terminal session {s}: {t}", .{ item.id, err });
    };
}

pub fn recordTerminalEndedLocked(self: anytype, item: *const session.TerminalSession, exit_code: i32, signal_value: i32) void {
    if (!self.persistence.enabled) return;
    const database = if (self.database) |*database| database else return;

    database.recordTerminalEnded(.{
        .id = item.id,
        .status = item.status.text(),
        .cols = item.cols,
        .rows = item.rows,
        .last_seq = item.last_seq,
        .exit_code = exit_code,
        .signal = signal_value,
    }) catch |err| {
        std.log.warn("failed to record terminal session exit {s}: {t}", .{ item.id, err });
    };
}

pub fn searchExcerptSnapshotLocked(self: anytype, item: *const session.TerminalSession) !?SearchExcerptSnapshot {
    if (!self.persistence.enabled) return null;
    if (self.database == null) return null;
    const excerpt_path = item.excerpt_path orelse return null;

    const terminal_session_id = try self.allocator.dupe(u8, item.id);
    errdefer self.allocator.free(terminal_session_id);
    const title = try self.allocator.dupe(u8, item.terminal_id);
    errdefer self.allocator.free(title);
    const owned_excerpt_path = try self.allocator.dupe(u8, excerpt_path);

    return .{
        .terminal_session_id = terminal_session_id,
        .title = title,
        .excerpt_path = owned_excerpt_path,
    };
}

pub fn pruneMissingEventLogMetadataLocked(self: anytype) void {
    const MissingEventLogRef = struct {
        id: []u8,
        event_log_path: []u8,

        fn deinit(item: *@This(), allocator: std.mem.Allocator) void {
            allocator.free(item.id);
            allocator.free(item.event_log_path);
            item.* = undefined;
        }
    };

    const database = if (self.database) |*database| database else return;
    const refs = database.listTerminalEventLogs(self.allocator) catch |err| {
        std.log.warn("failed to list terminal metadata for pruning: {t}", .{err});
        return;
    };
    defer {
        for (refs) |*item| item.deinit(self.allocator);
        self.allocator.free(refs);
    }

    var missing_refs: std.ArrayList(MissingEventLogRef) = .empty;
    defer {
        for (missing_refs.items) |*item| item.deinit(self.allocator);
        missing_refs.deinit(self.allocator);
    }

    self.unlock();
    for (refs) |ref| {
        if (fileExists(ref.event_log_path)) continue;
        const id = self.allocator.dupe(u8, ref.id) catch |err| {
            std.log.warn("failed to copy missing session id {s}: {t}", .{ ref.id, err });
            continue;
        };
        const event_log_path = self.allocator.dupe(u8, ref.event_log_path) catch |err| {
            std.log.warn("failed to copy missing event log path for {s}: {t}", .{ ref.id, err });
            self.allocator.free(id);
            continue;
        };
        missing_refs.append(self.allocator, .{ .id = id, .event_log_path = event_log_path }) catch |err| {
            self.allocator.free(id);
            self.allocator.free(event_log_path);
            std.log.warn("failed to track missing session metadata {s}: {t}", .{ ref.id, err });
        };
    }
    self.lock();

    for (missing_refs.items) |ref| {
        const should_delete = should_delete: {
            const path = if (self.sessions.find(ref.id)) |item|
                item.event_log_path orelse ref.event_log_path
            else
                ref.event_log_path;
            break :should_delete !fileExists(path);
        };
        if (!should_delete) continue;

        const pruning_database = if (self.database) |*value| value else return;
        pruning_database.deleteTerminalSessionMetadata(ref.id) catch |err| {
            std.log.warn("failed to prune missing session metadata {s}: {t}", .{ ref.id, err });
        };
    }
}
