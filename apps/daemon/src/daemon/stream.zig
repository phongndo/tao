const std = @import("std");
const event_log = @import("../event_log.zig");
const limits = @import("../limits.zig");
const rpc = @import("../rpc.zig");
const session = @import("../session.zig");
const snapshot = @import("../snapshot.zig");

const fd_io = @import("fd_io.zig");
const util = @import("util.zig");
const screen_mod = @import("screen.zig");

const setNonBlockingFd = fd_io.setNonBlockingFd;
const writeAllFd = fd_io.writeAllFd;
const writeAllFdNonBlocking = fd_io.writeAllFdNonBlocking;
const isLiveAttachable = util.isLiveAttachable;

const assert = std.debug.assert;
const max_pending_client_bytes = limits.pending_client_bytes_max;
const stack_stream_frame_bytes = 8 * 1024;

pub fn Context(comptime Daemon: type) type {
    return struct {
        daemon: Daemon,

        const Self = @This();

        pub fn init(daemon: Daemon) Self {
            return .{ .daemon = daemon };
        }

        pub fn streamAttachedSession(self: Self, socket_fd: std.c.fd_t, session_id: []const u8, initial_tail: []const u8) !void {
            return streamAttachedSessionImpl(self.daemon, socket_fd, session_id, initial_tail);
        }

        pub fn applyPendingClientFrames(self: Self, session_id: []const u8, pending: *std.ArrayList(u8)) !void {
            return applyPendingClientFramesImpl(self.daemon, session_id, pending);
        }

        pub fn addSubscriber(self: Self, session_id: []const u8, socket_fd: std.c.fd_t) !bool {
            return addSubscriberImpl(self.daemon, session_id, socket_fd);
        }

        pub fn removeSubscriber(self: Self, session_id: []const u8, socket_fd: std.c.fd_t) bool {
            return removeSubscriberImpl(self.daemon, session_id, socket_fd);
        }

        pub fn sessionCanContinueStreaming(self: Self, session_id: []const u8, socket_fd: std.c.fd_t) bool {
            return sessionCanContinueStreamingImpl(self.daemon, session_id, socket_fd);
        }

        pub fn applyClientFrame(self: Self, frame: rpc.StreamFrame) !void {
            return applyClientFrameImpl(self.daemon, frame);
        }

        pub fn broadcastExitFrameLocked(self: Self, item: *session.TerminalSession, seq: u64, exit_code: i32, signal_value: i32) !void {
            return broadcastExitFrameLockedImpl(self.daemon, item, seq, exit_code, signal_value);
        }

        pub fn broadcastStreamFrameLocked(self: Self, item: *session.TerminalSession, kind: rpc.StreamKind, seq: u64, payload: []const u8) !void {
            return broadcastStreamFrameLockedImpl(self.daemon, item, kind, seq, payload);
        }

        pub fn flushPendingOutputToSubscriberLocked(self: Self, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
            return flushPendingOutputToSubscriberLockedImpl(self.daemon, item, socket_fd);
        }
    };
}

fn appendPendingClientBytes(self: anytype, pending: *std.ArrayList(u8), bytes: []const u8) !bool {
    assert(pending.items.len <= max_pending_client_bytes);
    if (bytes.len > max_pending_client_bytes or pending.items.len > max_pending_client_bytes - bytes.len) {
        std.log.warn("closing taod stream with oversized pending client frame buffer", .{});
        return false;
    }
    try pending.appendSlice(self.allocator, bytes);
    assert(pending.items.len <= max_pending_client_bytes);
    return true;
}

fn ClientFrameVisitor(comptime Daemon: type) type {
    return struct {
        daemon: Daemon,
        session_id: []const u8,

        pub fn visit(self: *@This(), frame: rpc.StreamFrame) !void {
            if (!std.mem.eql(u8, frame.session_id, self.session_id)) return;
            try self.daemon.applyClientFrame(frame);
        }
    };
}

fn streamAttachedSessionImpl(self: anytype, socket_fd: std.c.fd_t, session_id: []const u8, initial_tail: []const u8) !void {
    assert(socket_fd >= 0);
    assert(session_id.len > 0);

    if (!try self.addSubscriber(session_id, socket_fd)) return;
    defer _ = self.removeSubscriber(session_id, socket_fd);

    var pending: std.ArrayList(u8) = .empty;
    defer pending.deinit(self.allocator);
    if (!try appendPendingClientBytes(self, &pending, initial_tail)) return;
    try self.applyPendingClientFrames(session_id, &pending);

    while (true) {
        if (!self.sessionCanContinueStreaming(session_id, socket_fd)) return;

        var poll_fds = [_]std.posix.pollfd{.{ .fd = socket_fd, .events = std.posix.POLL.IN, .revents = 0 }};

        _ = try std.posix.poll(&poll_fds, 250);

        if ((poll_fds[0].revents & (std.posix.POLL.IN | std.posix.POLL.HUP | std.posix.POLL.ERR)) != 0) {
            if ((poll_fds[0].revents & (std.posix.POLL.HUP | std.posix.POLL.ERR)) != 0) return;
            var buffer: [64 * 1024]u8 = undefined;
            const amount = std.c.read(socket_fd, &buffer, buffer.len);
            if (amount < 0) {
                switch (std.posix.errno(amount)) {
                    .INTR, .AGAIN => continue,
                    else => return,
                }
            }
            if (amount == 0) return;
            if (!try appendPendingClientBytes(self, &pending, buffer[0..@intCast(amount)])) return;
            try self.applyPendingClientFrames(session_id, &pending);
        }
    }
}

fn applyPendingClientFramesImpl(self: anytype, session_id: []const u8, pending: *std.ArrayList(u8)) !void {
    assert(session_id.len > 0);
    assert(pending.items.len <= max_pending_client_bytes);
    if (pending.items.len == 0) return;

    var visitor = ClientFrameVisitor(@TypeOf(self)){ .daemon = self, .session_id = session_id };
    const result = try rpc.parseStreamFrames(pending.items, &visitor);
    if (result.valid_bytes > 0) try pending.replaceRange(self.allocator, 0, result.valid_bytes, &.{});
}

fn addSubscriberImpl(self: anytype, session_id: []const u8, socket_fd: std.c.fd_t) !bool {
    assert(session_id.len > 0);
    assert(socket_fd >= 0);

    self.lock();
    {
        defer self.unlock();

        const item = self.sessions.find(session_id) orelse return false;
        item.assertInvariants();
        if (!isLiveAttachable(item)) return false;
        if (!try self.sessions.addSubscriber(session_id, socket_fd)) return false;
        item.assertInvariants();
    }

    // Initial reattach hydration must be reliable. Current-screen snapshots for full-screen
    // apps such as nvim/vim can exceed the local socket's immediate non-blocking capacity,
    // especially because the Electron side pauses the socket after reading the attach response
    // and only resumes it once the renderer is wired. Use blocking writes for the initial
    // snapshot/backlog, then switch the subscriber to non-blocking for live broadcasts so slow
    // clients can still be dropped without stalling the daemon.
    screen_mod.sendCurrentScreenSnapshotToSubscriber(self, session_id, socket_fd) catch |err| {
        std.log.warn("failed to send current-screen snapshot for {s}: {t}", .{ session_id, err });
        _ = self.removeSubscriber(session_id, socket_fd);
        return false;
    };
    flushPendingOutputToSubscriber(self, session_id, socket_fd) catch |err| {
        std.log.warn("failed to flush pending output for {s}: {t}", .{ session_id, err });
        _ = self.removeSubscriber(session_id, socket_fd);
        return false;
    };
    setNonBlockingFd(socket_fd) catch |err| {
        std.log.warn("failed to set taod subscriber non-blocking for {s}: {t}", .{ session_id, err });
        _ = self.removeSubscriber(session_id, socket_fd);
        return false;
    };
    return true;
}

fn flushPendingOutputToSubscriber(self: anytype, session_id: []const u8, socket_fd: std.c.fd_t) !void {
    assert(session_id.len > 0);
    assert(socket_fd >= 0);

    const frames = frames: {
        self.lock();
        defer self.unlock();

        const item = self.sessions.find(session_id) orelse return error.SessionNotFound;
        item.assertInvariants();
        if (!self.sessions.hasSubscriber(session_id, socket_fd)) return error.SessionNotAttached;
        if (item.pending_output.items.len == 0) break :frames null;

        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(self.allocator);
        for (item.pending_output.items) |frame| {
            const encoded_len = rpc.encodedStreamFrameSize(frame.payload.len);
            var stack_buffer: [stack_stream_frame_bytes]u8 = undefined;
            var heap_buffer: ?[]u8 = null;
            defer if (heap_buffer) |buffer| self.allocator.free(buffer);
            const buffer = if (encoded_len <= stack_buffer.len)
                stack_buffer[0..encoded_len]
            else blk: {
                heap_buffer = try self.allocator.alloc(u8, encoded_len);
                break :blk heap_buffer.?;
            };
            const encoded = try rpc.encodeStreamFrame(buffer, .output, item.id, frame.seq, frame.payload);
            try out.appendSlice(self.allocator, encoded);
        }
        break :frames try out.toOwnedSlice(self.allocator);
    };

    const encoded_frames = frames orelse return;
    defer self.allocator.free(encoded_frames);
    try writeAllFd(socket_fd, encoded_frames);

    self.lock();
    defer self.unlock();
    const item = self.sessions.find(session_id) orelse return;
    item.assertInvariants();
    if (!self.sessions.hasSubscriber(session_id, socket_fd)) return;
    item.clearPendingOutput(self.allocator);
}

fn removeSubscriberImpl(self: anytype, session_id: []const u8, socket_fd: std.c.fd_t) bool {
    assert(session_id.len > 0);
    assert(socket_fd >= 0);

    self.lock();
    defer self.unlock();

    const removed = self.sessions.removeSubscriber(session_id, socket_fd);
    if (removed) {
        if (self.sessions.find(session_id)) |item| {
            if (item.subscribers.items.len == 0) self.checkpointCurrentScreenLocked(item);
            self.recordTerminalSessionLocked(item, null);
        }
    }
    return removed;
}

fn sessionCanContinueStreamingImpl(self: anytype, session_id: []const u8, socket_fd: std.c.fd_t) bool {
    assert(session_id.len > 0);
    assert(socket_fd >= 0);

    self.lock();
    defer self.unlock();

    const item = self.sessions.find(session_id) orelse return false;
    if (!isLiveAttachable(item)) return false;
    return self.sessions.hasSubscriber(session_id, socket_fd);
}

fn applyClientFrameImpl(self: anytype, frame: rpc.StreamFrame) !void {
    assert(frame.session_id.len > 0);

    self.lock();
    defer self.unlock();

    const item = self.sessions.find(frame.session_id) orelse return;
    item.assertInvariants();
    const child = if (item.pty_child) |*child| child else return;

    switch (frame.kind) {
        .input => {
            if (self.persistence.enabled and self.persistence.persist_input) {
                if (item.event_log_path) |path| {
                    _ = event_log.appendInput(self.allocator, path, &item.last_seq, frame.payload) catch |err| {
                        std.log.warn("failed to append input frame for {s}: {t}", .{ item.id, err });
                    };
                }
            }
            try self.pty_driver.writeAll(child, frame.payload);
        },
        .resize => {
            const resize = try rpc.decodeResizePayload(frame.payload);
            try self.pty_driver.resize(child, resize.cols, resize.rows);
            item.resizeVt(self.allocator, resize.cols, resize.rows) catch |err| {
                std.log.warn("failed to resize VT state for {s}: {t}", .{ item.id, err });
                item.cols = resize.cols;
                item.rows = resize.rows;
            };
            if (item.event_log_path) |path| {
                _ = try event_log.appendResize(self.allocator, path, &item.last_seq, resize.cols, resize.rows);
            }
            self.recordTerminalSessionLocked(item, null);
        },
        else => {},
    }
}

fn broadcastExitFrameLockedImpl(self: anytype, item: *session.TerminalSession, seq: u64, exit_code: i32, signal_value: i32) !void {
    var payload: [8]u8 = undefined;
    const encoded_payload = try rpc.encodeExitPayload(&payload, exit_code, signal_value);
    try self.broadcastStreamFrameLocked(item, .exit, seq, encoded_payload);
}

fn broadcastStreamFrameLockedImpl(
    self: anytype,
    item: *session.TerminalSession,
    kind: rpc.StreamKind,
    seq: u64,
    payload: []const u8,
) !void {
    item.assertInvariants();

    if (item.subscribers.items.len == 0) {
        if (kind == .output) item.bufferPendingOutput(self.allocator, seq, payload) catch |err| {
            std.log.warn("failed to buffer pending output for {s}: {t}", .{ item.id, err });
        };
        return;
    }

    const encoded_len = rpc.encodedStreamFrameSize(payload.len);
    var stack_buffer: [stack_stream_frame_bytes]u8 = undefined;
    var heap_buffer: ?[]u8 = null;
    defer if (heap_buffer) |buffer| self.allocator.free(buffer);
    const buffer = if (encoded_len <= stack_buffer.len)
        stack_buffer[0..encoded_len]
    else blk: {
        heap_buffer = try self.allocator.alloc(u8, encoded_len);
        break :blk heap_buffer.?;
    };
    const encoded = try rpc.encodeStreamFrame(buffer, kind, item.id, seq, payload);

    var index: usize = 0;
    while (index < item.subscribers.items.len) {
        const fd = item.subscribers.items[index];
        writeAllFdNonBlocking(fd, encoded) catch |err| {
            std.log.warn("dropping slow taod subscriber for {s}: {t}", .{ item.id, err });
            _ = item.subscribers.orderedRemove(index);
            continue;
        };
        index += 1;
    }
    item.assertInvariants();
}

fn flushPendingOutputToSubscriberLockedImpl(self: anytype, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
    item.assertInvariants();
    assert(socket_fd >= 0);
    if (item.pending_output.items.len == 0) return;

    for (item.pending_output.items) |frame| {
        const encoded_len = rpc.encodedStreamFrameSize(frame.payload.len);
        var stack_buffer: [stack_stream_frame_bytes]u8 = undefined;
        var heap_buffer: ?[]u8 = null;
        defer if (heap_buffer) |buffer| self.allocator.free(buffer);
        const buffer = if (encoded_len <= stack_buffer.len)
            stack_buffer[0..encoded_len]
        else blk: {
            heap_buffer = try self.allocator.alloc(u8, encoded_len);
            break :blk heap_buffer.?;
        };
        const encoded = try rpc.encodeStreamFrame(buffer, .output, item.id, frame.seq, frame.payload);
        try writeAllFd(socket_fd, encoded);
    }

    item.clearPendingOutput(self.allocator);
}
