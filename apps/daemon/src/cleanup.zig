const std = @import("std");
const event_log = @import("event_log.zig");

pub const RetentionPolicy = struct {
    retain_days: u32 = 30,
    max_session_bytes: u64 = 2 * 1024 * 1024 * 1024,
};

pub const MaintenanceOptions = struct {
    retain_days: u32 = 30,
    max_session_bytes: u64 = 2 * 1024 * 1024 * 1024,
    active_session_ids: []const []const u8 = &.{},
};

pub const MaintenanceResult = struct {
    removed_sessions: u64 = 0,
    removed_bytes: u64 = 0,

    pub fn add(self: *MaintenanceResult, other: MaintenanceResult) void {
        self.removed_sessions += other.removed_sessions;
        self.removed_bytes += other.removed_bytes;
    }
};

const SessionDirInfo = struct {
    session_id: []u8,
    path: []u8,
    mtime_ms: i64,
    size: u64,

    fn deinit(self: *SessionDirInfo, allocator: std.mem.Allocator) void {
        allocator.free(self.session_id);
        allocator.free(self.path);
        self.* = undefined;
    }
};

pub fn shouldDeleteArchived(now_ms: i64, last_activity_ms: i64, policy: RetentionPolicy) bool {
    if (policy.retain_days == 0) return true;
    const retain_ms: i64 = @as(i64, policy.retain_days) * 24 * 60 * 60 * 1000;
    return now_ms - last_activity_ms > retain_ms;
}

pub fn deleteSessionDir(
    allocator: std.mem.Allocator,
    io: std.Io,
    sessions_dir: []const u8,
    session_id: []const u8,
) !MaintenanceResult {
    const sanitized_id = try event_log.sanitizeSessionId(allocator, session_id);
    defer allocator.free(sanitized_id);

    const path = try std.fs.path.join(allocator, &.{ sessions_dir, sanitized_id });
    defer allocator.free(path);

    const size = directorySize(allocator, io, path) catch 0;
    try deleteTree(io, path);

    return .{ .removed_sessions = 1, .removed_bytes = size };
}

pub fn deleteInactiveSessionDirs(
    allocator: std.mem.Allocator,
    io: std.Io,
    sessions_dir: []const u8,
    active_session_ids: []const []const u8,
) !MaintenanceResult {
    const dirs = try listSessionDirs(allocator, io, sessions_dir);
    defer deinitSessionDirs(allocator, dirs);

    var result: MaintenanceResult = .{};
    for (dirs) |dir| {
        if (isActiveSession(dir.session_id, active_session_ids)) continue;
        const removed = try deletePath(io, dir.path, dir.size);
        result.add(removed);
    }
    return result;
}

pub fn runSessionRetention(
    allocator: std.mem.Allocator,
    io: std.Io,
    sessions_dir: []const u8,
    options: MaintenanceOptions,
) !MaintenanceResult {
    const now_ms = nowMs();
    const retain_ms: i64 = @as(i64, options.retain_days) * 24 * 60 * 60 * 1000;
    const cutoff_ms = if (options.retain_days == 0) now_ms else now_ms - retain_ms;

    var result: MaintenanceResult = .{};
    {
        const dirs = try listSessionDirs(allocator, io, sessions_dir);
        defer deinitSessionDirs(allocator, dirs);
        std.mem.sort(SessionDirInfo, dirs, {}, sessionDirOlderThan);

        for (dirs) |dir| {
            if (isActiveSession(dir.session_id, options.active_session_ids)) continue;
            if (options.retain_days != 0 and dir.mtime_ms >= cutoff_ms) continue;
            const removed = try deletePath(io, dir.path, dir.size);
            result.add(removed);
        }
    }

    const dirs = try listSessionDirs(allocator, io, sessions_dir);
    defer deinitSessionDirs(allocator, dirs);
    std.mem.sort(SessionDirInfo, dirs, {}, sessionDirOlderThan);

    var total_bytes: u64 = 0;
    for (dirs) |dir| total_bytes += dir.size;

    for (dirs) |dir| {
        if (total_bytes <= options.max_session_bytes) break;
        if (isActiveSession(dir.session_id, options.active_session_ids)) continue;

        const removed = try deletePath(io, dir.path, dir.size);
        result.add(removed);
        total_bytes -|= dir.size;
    }

    return result;
}

pub fn isActiveSession(session_id: []const u8, active_session_ids: []const []const u8) bool {
    for (active_session_ids) |active_id| {
        if (std.mem.eql(u8, session_id, active_id)) return true;
    }
    return false;
}

fn listSessionDirs(allocator: std.mem.Allocator, io: std.Io, sessions_dir: []const u8) ![]SessionDirInfo {
    var dir = std.Io.Dir.cwd().openDir(io, sessions_dir, .{ .iterate = true }) catch |err| switch (err) {
        error.FileNotFound => return allocator.alloc(SessionDirInfo, 0),
        else => return err,
    };
    defer dir.close(io);

    var dirs: std.ArrayList(SessionDirInfo) = .empty;
    errdefer {
        for (dirs.items) |*item| item.deinit(allocator);
        dirs.deinit(allocator);
    }

    var iterator = dir.iterate();
    while (try iterator.next(io)) |entry| {
        if (entry.kind != .directory) continue;

        const stat = dir.statFile(io, entry.name, .{}) catch continue;

        const session_id = try allocator.dupe(u8, entry.name);
        errdefer allocator.free(session_id);
        const path = try std.fs.path.join(allocator, &.{ sessions_dir, entry.name });
        errdefer allocator.free(path);

        const size = directorySize(allocator, io, path) catch 0;
        try dirs.append(allocator, .{
            .session_id = session_id,
            .path = path,
            .mtime_ms = stat.mtime.toMilliseconds(),
            .size = size,
        });
    }

    return dirs.toOwnedSlice(allocator);
}

fn deinitSessionDirs(allocator: std.mem.Allocator, dirs: []SessionDirInfo) void {
    for (dirs) |*dir| dir.deinit(allocator);
    allocator.free(dirs);
}

fn directorySize(allocator: std.mem.Allocator, io: std.Io, path: []const u8) !u64 {
    var dir = std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch |err| switch (err) {
        error.FileNotFound => return 0,
        else => return err,
    };
    defer dir.close(io);

    var total: u64 = 0;
    var iterator = dir.iterate();
    while (try iterator.next(io)) |entry| {
        switch (entry.kind) {
            .directory => {
                const child_path = try std.fs.path.join(allocator, &.{ path, entry.name });
                defer allocator.free(child_path);
                total += directorySize(allocator, io, child_path) catch 0;
            },
            .file => {
                const stat = dir.statFile(io, entry.name, .{}) catch continue;
                total += stat.size;
            },
            else => {},
        }
    }

    return total;
}

fn deletePath(io: std.Io, path: []const u8, size: u64) !MaintenanceResult {
    try deleteTree(io, path);
    return .{ .removed_sessions = 1, .removed_bytes = size };
}

fn deleteTree(io: std.Io, path: []const u8) !void {
    return std.Io.Dir.cwd().deleteTree(io, path);
}

fn sessionDirOlderThan(_: void, lhs: SessionDirInfo, rhs: SessionDirInfo) bool {
    return lhs.mtime_ms < rhs.mtime_ms;
}

fn nowMs() i64 {
    var tv: std.c.timeval = undefined;
    if (std.c.gettimeofday(&tv, null) != 0) return 0;
    return @as(i64, @intCast(tv.sec)) * 1000 + @as(i64, @intCast(@divTrunc(tv.usec, 1000)));
}

test "retention policy removes sessions older than retain window" {
    const day_ms: i64 = 24 * 60 * 60 * 1000;
    try std.testing.expect(shouldDeleteArchived(10 * day_ms, 0, .{ .retain_days = 1 }));
    try std.testing.expect(!shouldDeleteArchived(day_ms, 0, .{ .retain_days = 2 }));
}

test "active session matching is exact" {
    const active = [_][]const u8{ "session-1", "session-2" };
    try std.testing.expect(isActiveSession("session-1", &active));
    try std.testing.expect(!isActiveSession("session", &active));
}

test "retention cleanup removes inactive session dirs and preserves active ones" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const allocator = std.testing.allocator;
    const sessions_dir = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}/sessions", .{tmp.sub_path});
    defer allocator.free(sessions_dir);

    var active = try event_log.resetPersistentSession(allocator, sessions_dir, "active-session");
    defer active.deinit(allocator);
    var inactive = try event_log.resetPersistentSession(allocator, sessions_dir, "inactive-session");
    defer inactive.deinit(allocator);

    try event_log.appendFramePath(allocator, active.event_log_path, .output, 1, "keep");
    try event_log.appendFramePath(allocator, inactive.event_log_path, .output, 1, "delete-me");

    const active_ids = [_][]const u8{"active-session"};
    const result = try runSessionRetention(allocator, std.testing.io, sessions_dir, .{
        .retain_days = 30,
        .max_session_bytes = 1,
        .active_session_ids = &active_ids,
    });

    try std.testing.expectEqual(@as(u64, 1), result.removed_sessions);
    var reopened_active = (try event_log.openExistingSession(allocator, sessions_dir, "active-session")).?;
    defer reopened_active.deinit(allocator);
    var reopened_inactive = try event_log.openExistingSession(allocator, sessions_dir, "inactive-session");
    defer if (reopened_inactive) |*files| files.deinit(allocator);
    try std.testing.expect(reopened_inactive == null);
}
