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
            assert(socket_fd >= 0);
            assert(session_id.len > 0);

            const daemon = self.daemon;
            if (!try self.addSubscriber(session_id, socket_fd)) return;
            defer _ = self.removeSubscriber(session_id, socket_fd);

            var pending: std.ArrayList(u8) = .empty;
            defer pending.deinit(daemon.allocator);
            if (!try self.appendPendingClientBytes(&pending, initial_tail)) return;
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
                    if (!try self.appendPendingClientBytes(&pending, buffer[0..@intCast(amount)])) return;
                    try self.applyPendingClientFrames(session_id, &pending);
                }
            }
        }

        pub fn applyPendingClientFrames(self: Self, session_id: []const u8, pending: *std.ArrayList(u8)) !void {
            assert(session_id.len > 0);
            assert(pending.items.len <= max_pending_client_bytes);
            if (pending.items.len == 0) return;

            const daemon = self.daemon;
            var visitor = ClientFrameVisitor{ .context = self, .session_id = session_id };
            const result = try rpc.parseStreamFrames(pending.items, &visitor);
            if (result.valid_bytes > 0) try pending.replaceRange(daemon.allocator, 0, result.valid_bytes, &.{});
        }

        pub fn addSubscriber(self: Self, session_id: []const u8, socket_fd: std.c.fd_t) !bool {
            assert(session_id.len > 0);
            assert(socket_fd >= 0);

            const daemon = self.daemon;
            daemon.lock();
            {
                defer daemon.unlock();

                const item = daemon.sessions.find(session_id) orelse return false;
                item.assertInvariants();
                if (!isLiveAttachable(item)) return false;
            }

            // Initial reattach hydration must be reliable. Current-screen snapshots for full-screen
            // apps such as nvim/vim can exceed the local socket's immediate non-blocking capacity,
            // especially because the Electron side pauses the socket after reading the attach response
            // and only resumes it once the renderer is wired. Use blocking writes for the initial
            // snapshot/backlog, then switch the subscriber to non-blocking for live broadcasts so slow
            // clients can still be dropped without stalling the daemon.
            screen_mod.sendCurrentScreenSnapshotToSubscriber(daemon, session_id, socket_fd) catch |err| {
                std.log.warn("failed to send current-screen snapshot for {s}: {t}", .{ session_id, err });
                return false;
            };

            while (true) {
                self.flushPendingOutputToSubscriber(session_id, socket_fd) catch |err| {
                    std.log.warn("failed to flush pending output for {s}: {t}", .{ session_id, err });
                    return false;
                };

                daemon.lock();
                defer daemon.unlock();
                const item = daemon.sessions.find(session_id) orelse return false;
                item.assertInvariants();
                if (!isLiveAttachable(item)) return false;
                if (item.pending_output.items.len != 0) continue;

                setNonBlockingFd(socket_fd) catch |err| {
                    std.log.warn("failed to set taod subscriber non-blocking for {s}: {t}", .{ session_id, err });
                    return false;
                };
                if (!try daemon.sessions.addSubscriber(session_id, socket_fd)) return false;
                item.assertInvariants();
                return true;
            }
        }

        pub fn removeSubscriber(self: Self, session_id: []const u8, socket_fd: std.c.fd_t) bool {
            assert(session_id.len > 0);
            assert(socket_fd >= 0);

            const daemon = self.daemon;
            daemon.lock();
            defer daemon.unlock();

            const removed = daemon.sessions.removeSubscriber(session_id, socket_fd);
            if (removed) {
                if (daemon.sessions.find(session_id)) |item| {
                    if (item.subscribers.items.len == 0) daemon.checkpointCurrentScreenLocked(item);
                    daemon.recordTerminalSessionLocked(item, null);
                }
            }
            return removed;
        }

        pub fn sessionCanContinueStreaming(self: Self, session_id: []const u8, socket_fd: std.c.fd_t) bool {
            assert(session_id.len > 0);
            assert(socket_fd >= 0);

            const daemon = self.daemon;
            daemon.lock();
            defer daemon.unlock();

            const item = daemon.sessions.find(session_id) orelse return false;
            if (!isLiveAttachable(item)) return false;
            return daemon.sessions.hasSubscriber(session_id, socket_fd);
        }

        pub fn applyClientFrame(self: Self, frame: rpc.StreamFrame) !void {
            assert(frame.session_id.len > 0);

            const daemon = self.daemon;
            daemon.lock();
            defer daemon.unlock();

            const item = daemon.sessions.find(frame.session_id) orelse return;
            item.assertInvariants();
            const child = if (item.pty_child) |*child| child else return;

            switch (frame.kind) {
                .input => {
                    if (daemon.persistence.enabled and daemon.persistence.persist_input) {
                        if (item.event_log_path) |path| {
                            _ = event_log.appendInput(daemon.allocator, path, &item.last_seq, frame.payload) catch |err| {
                                std.log.warn("failed to append input frame for {s}: {t}", .{ item.id, err });
                            };
                        }
                    }
                    try daemon.pty_driver.writeAll(child, frame.payload);
                },
                .resize => {
                    const resize = try rpc.decodeResizePayload(frame.payload);
                    try daemon.pty_driver.resize(child, resize.cols, resize.rows);
                    item.resizeVt(daemon.allocator, resize.cols, resize.rows) catch |err| {
                        std.log.warn("failed to resize VT state for {s}: {t}", .{ item.id, err });
                        item.cols = resize.cols;
                        item.rows = resize.rows;
                    };
                    if (item.event_log_path) |path| {
                        _ = try event_log.appendResize(daemon.allocator, path, &item.last_seq, resize.cols, resize.rows);
                    }
                    daemon.recordTerminalSessionLocked(item, null);
                },
                else => {},
            }
        }

        pub fn broadcastExitFrameLocked(self: Self, item: *session.TerminalSession, seq: u64, exit_code: i32, signal_value: i32) !void {
            var payload: [8]u8 = undefined;
            const encoded_payload = try rpc.encodeExitPayload(&payload, exit_code, signal_value);
            try self.broadcastStreamFrameLocked(item, .exit, seq, encoded_payload);
        }

        pub fn broadcastStreamFrameLocked(
            self: Self,
            item: *session.TerminalSession,
            kind: rpc.StreamKind,
            seq: u64,
            payload: []const u8,
        ) !void {
            item.assertInvariants();

            const daemon = self.daemon;
            if (item.subscribers.items.len == 0) {
                if (kind == .output) item.bufferPendingOutput(daemon.allocator, seq, payload) catch |err| {
                    std.log.warn("failed to buffer pending output for {s}: {t}", .{ item.id, err });
                };
                return;
            }

            const encoded_len = rpc.encodedStreamFrameSize(payload.len);
            var stack_buffer: [stack_stream_frame_bytes]u8 = undefined;
            var heap_buffer: ?[]u8 = null;
            defer if (heap_buffer) |buffer| daemon.allocator.free(buffer);
            const buffer = if (encoded_len <= stack_buffer.len)
                stack_buffer[0..encoded_len]
            else blk: {
                heap_buffer = try daemon.allocator.alloc(u8, encoded_len);
                break :blk heap_buffer.?;
            };
            const encoded = try rpc.encodeStreamFrame(buffer, kind, item.id, seq, payload);

            var index: usize = 0;
            while (index < item.subscribers.items.len) {
                const fd = item.subscribers.items[index];
                writeAllFdNonBlocking(fd, encoded) catch |err| {
                    std.log.warn("dropping slow taod subscriber for {s}: {t}", .{ item.id, err });
                    self.removeSubscriberAtLocked(item, index);
                    if (item.subscribers.items.len == 0) {
                        if (kind == .output) item.bufferPendingOutput(daemon.allocator, seq, payload) catch |buffer_err| {
                            std.log.warn("failed to buffer pending output for {s}: {t}", .{ item.id, buffer_err });
                        };
                        return;
                    }
                    continue;
                };
                index += 1;
            }
            item.assertInvariants();
        }

        pub fn flushPendingOutputToSubscriberLocked(self: Self, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
            item.assertInvariants();
            assert(socket_fd >= 0);
            if (item.pending_output.items.len == 0) return;

            const daemon = self.daemon;
            for (item.pending_output.items) |frame| {
                {
                    const encoded_len = rpc.encodedStreamFrameSize(frame.payload.len);
                    var stack_buffer: [stack_stream_frame_bytes]u8 = undefined;
                    var heap_buffer: ?[]u8 = null;
                    defer if (heap_buffer) |buffer| daemon.allocator.free(buffer);
                    const buffer = if (encoded_len <= stack_buffer.len)
                        stack_buffer[0..encoded_len]
                    else blk: {
                        heap_buffer = try daemon.allocator.alloc(u8, encoded_len);
                        break :blk heap_buffer.?;
                    };
                    const encoded = try rpc.encodeStreamFrame(buffer, .output, item.id, frame.seq, frame.payload);
                    try writeAllFd(socket_fd, encoded);
                }
            }

            item.clearPendingOutput(daemon.allocator);
        }

        fn appendPendingClientBytes(self: Self, pending: *std.ArrayList(u8), bytes: []const u8) !bool {
            assert(pending.items.len <= max_pending_client_bytes);
            if (bytes.len > max_pending_client_bytes or pending.items.len > max_pending_client_bytes - bytes.len) {
                std.log.warn("closing taod stream with oversized pending client frame buffer", .{});
                return false;
            }
            try pending.appendSlice(self.daemon.allocator, bytes);
            assert(pending.items.len <= max_pending_client_bytes);
            return true;
        }

        fn flushPendingOutputToSubscriber(self: Self, session_id: []const u8, socket_fd: std.c.fd_t) !void {
            assert(session_id.len > 0);
            assert(socket_fd >= 0);

            const daemon = self.daemon;
            const frames = frames: {
                daemon.lock();
                defer daemon.unlock();

                const item = daemon.sessions.find(session_id) orelse return error.SessionNotFound;
                item.assertInvariants();
                if (!isLiveAttachable(item)) return error.SessionNotAttached;
                if (item.pending_output.items.len == 0) break :frames null;

                var out: std.ArrayList(u8) = .empty;
                errdefer out.deinit(daemon.allocator);
                var last_flushed_seq: u64 = 0;
                for (item.pending_output.items) |frame| {
                    {
                        const encoded_len = rpc.encodedStreamFrameSize(frame.payload.len);
                        var stack_buffer: [stack_stream_frame_bytes]u8 = undefined;
                        var heap_buffer: ?[]u8 = null;
                        defer if (heap_buffer) |buffer| daemon.allocator.free(buffer);
                        const buffer = if (encoded_len <= stack_buffer.len)
                            stack_buffer[0..encoded_len]
                        else blk: {
                            heap_buffer = try daemon.allocator.alloc(u8, encoded_len);
                            break :blk heap_buffer.?;
                        };
                        const encoded = try rpc.encodeStreamFrame(buffer, .output, item.id, frame.seq, frame.payload);
                        try out.appendSlice(daemon.allocator, encoded);
                        last_flushed_seq = frame.seq;
                    }
                }
                break :frames .{ .data = try out.toOwnedSlice(daemon.allocator), .last_seq = last_flushed_seq };
            };

            const encoded_frames = frames orelse return;
            defer daemon.allocator.free(encoded_frames.data);
            try writeAllFd(socket_fd, encoded_frames.data);

            daemon.lock();
            defer daemon.unlock();
            const item = daemon.sessions.find(session_id) orelse return;
            item.assertInvariants();
            if (!isLiveAttachable(item)) return;
            self.clearPendingOutputThroughSeqLocked(item, encoded_frames.last_seq);
        }

        fn removeSubscriberAtLocked(self: Self, item: *session.TerminalSession, index: usize) void {
            item.assertInvariants();
            assert(index < item.subscribers.items.len);

            const daemon = self.daemon;
            _ = item.subscribers.orderedRemove(index);
            if (item.subscribers.items.len == 0 and item.status == .live) {
                item.transitionTo(.detached);
                daemon.checkpointCurrentScreenLocked(item);
            }
            daemon.recordTerminalSessionLocked(item, null);
            item.assertInvariants();
        }

        fn clearPendingOutputThroughSeqLocked(self: Self, item: *session.TerminalSession, seq: u64) void {
            item.assertInvariants();

            const daemon = self.daemon;
            while (item.pending_output.items.len > 0 and item.pending_output.items[0].seq <= seq) {
                var frame = item.pending_output.orderedRemove(0);
                assert(item.pending_output_bytes >= frame.payload.len);
                item.pending_output_bytes -= frame.payload.len;
                frame.deinit(daemon.allocator);
            }
            item.assertInvariants();
        }

        const ClientFrameVisitor = struct {
            context: Self,
            session_id: []const u8,

            pub fn visit(self: *@This(), frame: rpc.StreamFrame) !void {
                if (!std.mem.eql(u8, frame.session_id, self.session_id)) return;
                try self.context.applyClientFrame(frame);
            }
        };
    };
}
