const std = @import("std");
const adapter = @import("../adapter.zig");
const cleanup = @import("../cleanup.zig");
const db = @import("../db.zig");
const event_log = @import("../event_log.zig");
const pty = @import("../pty.zig");
const rpc = @import("../rpc.zig");
const session = @import("../session.zig");
const snapshot = @import("../snapshot.zig");
const vt = @import("../vt.zig");

const fd_io = @import("fd_io.zig");
const protocol = @import("protocol.zig");
const util = @import("util.zig");
const types = @import("types.zig");

const AttachKind = protocol.AttachKind;
const SessionResponseMetadata = protocol.SessionResponseMetadata;
const RestoreResult = types.RestoreResult;
const AgentDetectionSnapshot = types.AgentDetectionSnapshot;
const SearchExcerptSnapshot = types.SearchExcerptSnapshot;
const CurrentScreenCheckpoint = types.CurrentScreenCheckpoint;
const SettingsJson = types.SettingsJson;

const readControlPayload = fd_io.readControlPayload;
const setNonBlockingFd = fd_io.setNonBlockingFd;
const writeAllFd = fd_io.writeAllFd;
const writeAllFdNonBlocking = fd_io.writeAllFdNonBlocking;
const fileExists = util.fileExists;
const readSmallFileAlloc = util.readSmallFileAlloc;
const generateSessionId = util.generateSessionId;
const argvJsonAlloc = util.argvJsonAlloc;
const parseArgvJson = util.parseArgvJson;
const isLiveAttachable = util.isLiveAttachable;
const isResumableAgentStatus = util.isResumableAgentStatus;
const missingField = protocol.missingField;
const notFound = protocol.notFound;
const sessionResponse = protocol.sessionResponse;

fn sessionReaderThread(daemon: anytype, session_id: []const u8) void {
    daemon.runSessionReader(session_id) catch |err| {
        std.log.warn("session reader failed for {s}: {t}", .{ session_id, err });
        _ = daemon.markExitedAndBroadcast(session_id, -1, 0) catch {};
    };
}

pub fn ensureSessionProcess(self: anytype, item: *session.TerminalSession, argv: []const []const u8) !void {
    if (item.pty_child) |child| {
        if (child.master_fd >= 0) return;
        item.pty_child = null;
        item.reader_started = false;
    }
    if (argv.len == 0) return;

    item.pty_child = try self.pty_driver.spawn(.{
        .argv = argv,
        .cwd = item.cwd,
        .cols = item.cols,
        .rows = item.rows,
    });
    item.status = .live;
}

pub fn startSessionReaderLocked(self: anytype, item: *session.TerminalSession) !void {
    if (item.reader_started) return;
    const child = item.pty_child orelse return;
    if (child.master_fd < 0) return;
    item.reader_started = true;
    const thread = std.Thread.spawn(.{}, sessionReaderThread, .{ self, item.id }) catch |err| {
        item.reader_started = false;
        return err;
    };
    thread.detach();
}

pub fn runSessionReader(self: anytype, session_id: []const u8) !void {
    while (true) {
        const child_fd = self.liveChildFd(session_id) orelse return;
        var poll_fds = [_]std.posix.pollfd{.{ .fd = child_fd, .events = std.posix.POLL.IN, .revents = 0 }};

        _ = try std.posix.poll(&poll_fds, 250);
        if ((poll_fds[0].revents & (std.posix.POLL.IN | std.posix.POLL.HUP | std.posix.POLL.ERR)) != 0) {
            try self.readPtyAndBroadcast(session_id);
        }

        if (try self.reapExitedChild(session_id)) return;
    }
}

pub fn liveChildFd(self: anytype, session_id: []const u8) ?std.c.fd_t {
    self.lock();
    defer self.unlock();

    const item = self.sessions.find(session_id) orelse return null;
    if (item.status == .killed or item.status == .exited or item.status == .crashed) return null;
    const child = item.pty_child orelse return null;
    if (child.master_fd < 0) return null;
    return child.master_fd;
}

pub fn readPtyAndBroadcast(self: anytype, session_id: []const u8) !void {
    var child_copy: pty.Child = blk: {
        self.lock();
        defer self.unlock();
        const item = self.sessions.find(session_id) orelse return;
        break :blk item.pty_child orelse return;
    };

    var buffer: [64 * 1024]u8 = undefined;
    const amount = self.pty_driver.read(&child_copy, &buffer) catch |err| {
        std.log.warn("PTY read failed for {s}: {t}", .{ session_id, err });
        _ = try self.markExitedAndBroadcast(session_id, -1, 0);
        return;
    };
    if (amount == 0) {
        _ = try self.markExitedAndBroadcast(session_id, -1, 0);
        return;
    }

    const payload = buffer[0..amount];
    self.lock();
    defer self.unlock();

    const item = self.sessions.find(session_id) orelse return;
    item.writeVt(payload) catch |err| {
        std.log.warn("failed to feed VT state for {s}: {t}", .{ item.id, err });
    };
    const seq = seq: {
        if (item.event_log_path) |path| {
            break :seq try event_log.appendOutput(self.allocator, path, item.excerpt_path, &item.last_seq, payload);
        }

        item.last_seq += 1;
        break :seq item.last_seq;
    };

    try self.broadcastStreamFrameLocked(item, .output, seq, payload);
}

pub fn reapExitedChild(self: anytype, session_id: []const u8) !bool {
    self.lock();
    errdefer self.unlock();

    const item = self.sessions.find(session_id) orelse {
        self.unlock();
        return true;
    };
    const child = if (item.pty_child) |*child| child else {
        self.unlock();
        return false;
    };
    const status = try self.pty_driver.tryWait(child) orelse {
        self.unlock();
        return false;
    };
    item.status = .exited;
    if (item.event_log_path) |path| {
        _ = event_log.appendExit(self.allocator, path, &item.last_seq, status.exit_code, status.signal) catch |err| {
            std.log.warn("failed to append child exit frame for {s}: {t}", .{ item.id, err });
        };
    }
    child.close();
    item.pty_child = null;
    item.reader_started = false;
    try self.broadcastExitFrameLocked(item, item.last_seq, status.exit_code, status.signal);
    self.recordTerminalEndedLocked(item, status.exit_code, status.signal);
    var search_snapshot = self.searchExcerptSnapshotLocked(item) catch |err| blk: {
        std.log.warn("failed to prepare search excerpt indexing for {s}: {t}", .{ item.id, err });
        break :blk null;
    };
    var agent_snapshot = self.agentDetectionSnapshotFromStoredArgvLocked(item, "ended") catch |err| blk: {
        std.log.warn("failed to prepare agent metadata refresh for {s}: {t}", .{ item.id, err });
        break :blk null;
    };
    self.unlock();
    defer if (search_snapshot) |*value| value.deinit(self.allocator);
    defer if (agent_snapshot) |*value| value.deinit(self.allocator);
    if (search_snapshot) |*value| self.indexSearchExcerptFromSnapshot(value);
    if (agent_snapshot) |*value| self.recordAgentSessionFromSnapshot(value);
    return true;
}

pub fn markExitedAndBroadcast(self: anytype, session_id: []const u8, exit_code: i32, signal_value: i32) !bool {
    self.lock();
    errdefer self.unlock();

    const item = self.sessions.find(session_id) orelse {
        self.unlock();
        return true;
    };
    if (item.status == .killed) {
        self.unlock();
        return true;
    }
    item.status = .exited;
    if (item.pty_child) |*child| child.close();
    item.pty_child = null;
    item.reader_started = false;
    if (item.event_log_path) |path| {
        _ = event_log.appendExit(self.allocator, path, &item.last_seq, exit_code, signal_value) catch |err| {
            std.log.warn("failed to append synthetic exit frame for {s}: {t}", .{ item.id, err });
        };
    }
    try self.broadcastExitFrameLocked(item, item.last_seq, exit_code, signal_value);
    self.recordTerminalEndedLocked(item, exit_code, signal_value);
    var search_snapshot = self.searchExcerptSnapshotLocked(item) catch |err| blk: {
        std.log.warn("failed to prepare search excerpt indexing for {s}: {t}", .{ item.id, err });
        break :blk null;
    };
    var agent_snapshot = self.agentDetectionSnapshotFromStoredArgvLocked(item, "ended") catch |err| blk: {
        std.log.warn("failed to prepare agent metadata refresh for {s}: {t}", .{ item.id, err });
        break :blk null;
    };
    self.unlock();
    defer if (search_snapshot) |*value| value.deinit(self.allocator);
    defer if (agent_snapshot) |*value| value.deinit(self.allocator);
    if (search_snapshot) |*value| self.indexSearchExcerptFromSnapshot(value);
    if (agent_snapshot) |*value| self.recordAgentSessionFromSnapshot(value);
    return true;
}
