const std = @import("std");
const event_log = @import("../event_log.zig");
const pty = @import("../pty.zig");
const session = @import("../session.zig");

const assert = std.debug.assert;

pub fn Context(comptime Daemon: type) type {
    return struct {
        daemon: Daemon,

        const Self = @This();

        pub fn init(daemon: Daemon) Self {
            return .{ .daemon = daemon };
        }

        pub fn ensureSessionProcess(self: Self, item: *session.TerminalSession, argv: []const []const u8) !void {
            return ensureSessionProcessImpl(self.daemon, item, argv);
        }

        pub fn startSessionReaderLocked(self: Self, item: *session.TerminalSession) !void {
            return startSessionReaderLockedImpl(self.daemon, item);
        }

        pub fn runSessionReader(self: Self, session_id: []const u8) !void {
            return runSessionReaderImpl(self.daemon, session_id);
        }

        pub fn liveChildFd(self: Self, session_id: []const u8) ?std.c.fd_t {
            return liveChildFdImpl(self.daemon, session_id);
        }

        pub fn readPtyAndBroadcast(self: Self, session_id: []const u8) !void {
            return readPtyAndBroadcastImpl(self.daemon, session_id);
        }

        pub fn reapExitedChild(self: Self, session_id: []const u8) !bool {
            return reapExitedChildImpl(self.daemon, session_id);
        }

        pub fn markExitedAndBroadcast(self: Self, session_id: []const u8, exit_code: i32, signal_value: i32) !bool {
            return markExitedAndBroadcastImpl(self.daemon, session_id, exit_code, signal_value);
        }
    };
}

fn sessionReaderThread(daemon: anytype, session_id: []u8) void {
    defer std.heap.smp_allocator.free(session_id);

    daemon.runSessionReader(session_id) catch |err| {
        std.log.warn("session reader failed for {s}: {t}", .{ session_id, err });
        _ = daemon.markExitedAndBroadcast(session_id, -1, 0) catch {};
    };
}

fn ensureSessionProcessImpl(self: anytype, item: *session.TerminalSession, argv: []const []const u8) !void {
    item.assertInvariants();
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
    item.transitionTo(.live);
    item.assertInvariants();
}

fn startSessionReaderLockedImpl(self: anytype, item: *session.TerminalSession) !void {
    item.assertInvariants();
    if (item.reader_started) return;
    const child = item.pty_child orelse return;
    if (child.master_fd < 0) return;
    item.reader_started = true;
    const owned_session_id = try std.heap.smp_allocator.dupe(u8, item.id);
    errdefer std.heap.smp_allocator.free(owned_session_id);
    const thread = std.Thread.spawn(.{}, sessionReaderThread, .{ self, owned_session_id }) catch |err| {
        item.reader_started = false;
        return err;
    };
    thread.detach();
}

fn runSessionReaderImpl(self: anytype, session_id: []const u8) !void {
    assert(session_id.len > 0);

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

fn liveChildFdImpl(self: anytype, session_id: []const u8) ?std.c.fd_t {
    assert(session_id.len > 0);

    self.lock();
    defer self.unlock();

    const item = self.sessions.find(session_id) orelse return null;
    if (item.status == .killed or item.status == .exited or item.status == .crashed) return null;
    const child = item.pty_child orelse return null;
    if (child.master_fd < 0) return null;
    return child.master_fd;
}

fn readPtyAndBroadcastImpl(self: anytype, session_id: []const u8) !void {
    assert(session_id.len > 0);

    var child_copy: pty.Child = blk: {
        self.lock();
        defer self.unlock();
        const item = self.sessions.find(session_id) orelse return;
        item.assertInvariants();
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
    item.assertInvariants();
    item.writeVt(payload) catch |err| {
        std.log.warn("failed to feed VT state for {s}: {t}", .{ item.id, err });
    };
    const seq = seq: {
        if (item.event_log_path) |path| {
            break :seq try event_log.appendOutput(self.allocator, path, item.excerpt_path, &item.last_seq, payload);
        }

        item.last_seq = std.math.add(u64, item.last_seq, 1) catch return error.SequenceOverflow;
        break :seq item.last_seq;
    };

    try self.broadcastStreamFrameLocked(item, .output, seq, payload);
    item.assertInvariants();
}

fn reapExitedChildImpl(self: anytype, session_id: []const u8) !bool {
    assert(session_id.len > 0);

    self.lock();
    errdefer self.unlock();

    const item = self.sessions.find(session_id) orelse {
        self.unlock();
        return true;
    };
    item.assertInvariants();
    const child = if (item.pty_child) |*child| child else {
        self.unlock();
        return false;
    };
    const status = try self.pty_driver.tryWait(child) orelse {
        self.unlock();
        return false;
    };
    item.transitionTo(.exited);
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
    item.assertInvariants();
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

fn markExitedAndBroadcastImpl(self: anytype, session_id: []const u8, exit_code: i32, signal_value: i32) !bool {
    assert(session_id.len > 0);

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
    item.assertInvariants();
    item.transitionTo(.exited);
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
    item.assertInvariants();
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
