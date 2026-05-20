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
            item.assertInvariants();
            const daemon = self.daemon;
            if (item.pty_child) |*child| {
                if (child.master_fd >= 0) return;
                if (child.pid > 0) {
                    _ = try daemon.pty_driver.tryWait(child) orelse return error.SpawnFailed;
                }
                child.close();
                item.pty_child = null;
                item.reader_started = false;
            }
            if (argv.len == 0) return;

            var env_pairs: std.ArrayList(pty.EnvPair) = .empty;
            defer env_pairs.deinit(daemon.allocator);
            var workspace_row: ?@import("../db.zig").WorkspaceRow = null;
            defer if (workspace_row) |*row| row.deinit(daemon.allocator);
            var worktree_row: ?@import("../db.zig").WorktreeRow = null;
            defer if (worktree_row) |*row| row.deinit(daemon.allocator);
            if (daemon.database) |*database| {
                if (item.workspace_id) |workspace_id| {
                    workspace_row = database.findWorkspaceById(daemon.allocator, workspace_id) catch null;
                }
                if (item.worktree_id) |worktree_id| {
                    worktree_row = database.findWorktreeById(daemon.allocator, worktree_id) catch null;
                }
            }
            if (item.workspace_id) |workspace_id| try env_pairs.append(daemon.allocator, .{ .name = "TAO_WORKSPACE_ID", .value = workspace_id });
            if (workspace_row) |row| try env_pairs.append(daemon.allocator, .{ .name = "TAO_WORKSPACE_ROOT", .value = row.root_path });
            if (worktree_row) |row| {
                try env_pairs.append(daemon.allocator, .{ .name = "TAO_WORKTREE_ID", .value = row.id });
                try env_pairs.append(daemon.allocator, .{ .name = "TAO_WORKTREE_PATH", .value = row.path });
                try env_pairs.append(daemon.allocator, .{ .name = "TAO_WORKTREE_BRANCH", .value = row.branch });
                if (row.base_branch) |value| try env_pairs.append(daemon.allocator, .{ .name = "TAO_BASE_BRANCH", .value = value });
                if (row.target_branch) |value| try env_pairs.append(daemon.allocator, .{ .name = "TAO_TARGET_BRANCH", .value = value });
            }

            item.pty_child = try daemon.pty_driver.spawn(.{
                .argv = argv,
                .env = env_pairs.items,
                .cwd = item.cwd,
                .cols = item.cols,
                .rows = item.rows,
            });
            item.transitionTo(.live);
            item.assertInvariants();
        }

        pub fn startSessionReaderLocked(self: Self, item: *session.TerminalSession) !void {
            item.assertInvariants();
            if (item.reader_started) return;
            const child = item.pty_child orelse return;
            if (child.master_fd < 0) return;
            const owned_session_id = try std.heap.smp_allocator.dupe(u8, item.id);
            errdefer std.heap.smp_allocator.free(owned_session_id);
            _ = self.daemon.active_session_readers.fetchAdd(1, .release);
            errdefer _ = self.daemon.active_session_readers.fetchSub(1, .acquire);
            const thread = try std.Thread.spawn(.{}, sessionReaderThread, .{ self, owned_session_id });
            item.reader_started = true;
            thread.detach();
        }

        pub fn runSessionReader(self: Self, session_id: []const u8) !void {
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

        pub fn liveChildFd(self: Self, session_id: []const u8) ?std.c.fd_t {
            assert(session_id.len > 0);

            const daemon = self.daemon;
            daemon.lock();
            defer daemon.unlock();

            const item = daemon.sessions.find(session_id) orelse return null;
            if (item.status == .killed or item.status == .exited or item.status == .crashed) return null;
            const child = item.pty_child orelse return null;
            if (child.master_fd < 0) return null;
            return child.master_fd;
        }

        pub fn readPtyAndBroadcast(self: Self, session_id: []const u8) !void {
            assert(session_id.len > 0);

            const daemon = self.daemon;
            var child_copy: pty.Child = blk: {
                daemon.lock();
                defer daemon.unlock();
                const item = daemon.sessions.find(session_id) orelse return;
                item.assertInvariants();
                break :blk item.pty_child orelse return;
            };

            var buffer: [64 * 1024]u8 = undefined;
            const amount = daemon.pty_driver.read(&child_copy, &buffer) catch |err| {
                std.log.warn("PTY read failed for {s}: {t}", .{ session_id, err });
                _ = try self.markExitedAndBroadcast(session_id, -1, 0);
                return;
            };
            if (amount == 0) {
                _ = try self.markExitedAndBroadcast(session_id, -1, 0);
                return;
            }

            const payload = buffer[0..amount];
            daemon.lock();
            defer daemon.unlock();

            const item = daemon.sessions.find(session_id) orelse return;
            item.assertInvariants();
            item.writeVt(payload) catch |err| {
                std.log.warn("failed to feed VT state for {s}: {t}", .{ item.id, err });
            };
            const seq = seq: {
                if (item.event_log_path) |path| {
                    break :seq try event_log.appendOutput(daemon.allocator, path, item.excerpt_path, &item.last_seq, payload);
                }

                item.last_seq = std.math.add(u64, item.last_seq, 1) catch return error.SequenceOverflow;
                break :seq item.last_seq;
            };

            try daemon.broadcastStreamFrameLocked(item, .output, seq, payload);
            item.assertInvariants();
        }

        pub fn reapExitedChild(self: Self, session_id: []const u8) !bool {
            assert(session_id.len > 0);

            const daemon = self.daemon;
            daemon.lock();
            errdefer daemon.unlock();

            const item = daemon.sessions.find(session_id) orelse {
                daemon.unlock();
                return true;
            };
            item.assertInvariants();
            const child = if (item.pty_child) |*child| child else {
                daemon.unlock();
                return false;
            };
            const status = try daemon.pty_driver.tryWait(child) orelse {
                daemon.unlock();
                return false;
            };
            item.transitionTo(.exited);
            if (item.event_log_path) |path| {
                _ = event_log.appendExit(daemon.allocator, path, &item.last_seq, status.exit_code, status.signal) catch |err| {
                    std.log.warn("failed to append child exit frame for {s}: {t}", .{ item.id, err });
                };
            }
            child.close();
            item.pty_child = null;
            item.reader_started = false;
            try daemon.broadcastExitFrameLocked(item, item.last_seq, status.exit_code, status.signal);
            daemon.recordTerminalEndedLocked(item, status.exit_code, status.signal);
            item.assertInvariants();
            var search_snapshot = daemon.searchExcerptSnapshotLocked(item) catch |err| blk: {
                std.log.warn("failed to prepare search excerpt indexing for {s}: {t}", .{ item.id, err });
                break :blk null;
            };
            var agent_snapshot = daemon.agentDetectionSnapshotFromStoredArgvLocked(item, "ended") catch |err| blk: {
                std.log.warn("failed to prepare agent metadata refresh for {s}: {t}", .{ item.id, err });
                break :blk null;
            };
            daemon.unlock();
            defer if (search_snapshot) |*value| value.deinit(daemon.allocator);
            defer if (agent_snapshot) |*value| value.deinit(daemon.allocator);
            if (search_snapshot) |*value| daemon.indexSearchExcerptFromSnapshot(value);
            if (agent_snapshot) |*value| daemon.recordAgentSessionFromSnapshot(value);
            return true;
        }

        pub fn markExitedAndBroadcast(self: Self, session_id: []const u8, exit_code: i32, signal_value: i32) !bool {
            assert(session_id.len > 0);

            const daemon = self.daemon;
            daemon.lock();
            errdefer daemon.unlock();

            const item = daemon.sessions.find(session_id) orelse {
                daemon.unlock();
                return true;
            };
            if (item.status == .killed) {
                daemon.unlock();
                return true;
            }
            item.assertInvariants();
            item.transitionTo(.exited);
            releasePtyChildForBackgroundReap(item, "synthetic exit");
            item.reader_started = false;
            if (item.event_log_path) |path| {
                _ = event_log.appendExit(daemon.allocator, path, &item.last_seq, exit_code, signal_value) catch |err| {
                    std.log.warn("failed to append synthetic exit frame for {s}: {t}", .{ item.id, err });
                };
            }
            try daemon.broadcastExitFrameLocked(item, item.last_seq, exit_code, signal_value);
            daemon.recordTerminalEndedLocked(item, exit_code, signal_value);
            item.assertInvariants();
            var search_snapshot = daemon.searchExcerptSnapshotLocked(item) catch |err| blk: {
                std.log.warn("failed to prepare search excerpt indexing for {s}: {t}", .{ item.id, err });
                break :blk null;
            };
            var agent_snapshot = daemon.agentDetectionSnapshotFromStoredArgvLocked(item, "ended") catch |err| blk: {
                std.log.warn("failed to prepare agent metadata refresh for {s}: {t}", .{ item.id, err });
                break :blk null;
            };
            daemon.unlock();
            defer if (search_snapshot) |*value| value.deinit(daemon.allocator);
            defer if (agent_snapshot) |*value| value.deinit(daemon.allocator);
            if (search_snapshot) |*value| daemon.indexSearchExcerptFromSnapshot(value);
            if (agent_snapshot) |*value| daemon.recordAgentSessionFromSnapshot(value);
            return true;
        }

        fn sessionReaderThread(context: Self, session_id: []u8) void {
            defer {
                std.heap.smp_allocator.free(session_id);
                _ = context.daemon.active_session_readers.fetchSub(1, .acquire);
            }

            context.runSessionReader(session_id) catch |err| {
                std.log.warn("session reader failed for {s}: {t}", .{ session_id, err });
                _ = context.markExitedAndBroadcast(session_id, -1, 0) catch {};
            };
        }

        fn releasePtyChildForBackgroundReap(item: *session.TerminalSession, reason: []const u8) void {
            if (item.pty_child) |*child| {
                pty.reapInBackground(child) catch |err| {
                    std.log.warn("failed to start PTY reaper for {s} after {s}: {t}", .{ item.id, reason, err });
                    return;
                };
                item.pty_child = null;
            }
        }
    };
}
