const std = @import("std");
const builtin = @import("builtin");
const cleanup = @import("../cleanup.zig");
const db = @import("../db.zig");
const limits = @import("../limits.zig");
const rpc = @import("../rpc.zig");

const fd_io = @import("fd_io.zig");

const readControlPayloadWithTimeout = fd_io.readControlPayloadWithTimeout;
const writeAllFd = fd_io.writeAllFd;

const owner_dir_mode: std.c.mode_t = 0o700;
const owner_socket_mode: std.c.mode_t = 0o600;
const control_slow_log_threshold_ms: u64 = 250;
const assert = std.debug.assert;

const ControlLogKind = enum {
    none,
    failed,
    slow,
};

extern "c" fn getpeereid(socket: std.c.fd_t, euid: *std.c.uid_t, egid: *std.c.gid_t) c_int;

fn handleConnectionThread(context: anytype) void {
    defer context.daemon.allocator.destroy(context);
    defer context.daemon.releaseControlConnection();
    context.daemon.handleStream(context.stream) catch |err| {
        std.log.warn("control RPC connection failed: {s}", .{@errorName(err)});
    };
}

fn controlLogKind(ok: bool, duration_ms: u64) ControlLogKind {
    if (!ok) return .failed;
    if (duration_ms >= control_slow_log_threshold_ms) return .slow;
    return .none;
}

fn logControlRequestIfNeeded(request_type: rpc.RequestType, trace_id: ?[]const u8, duration_ms: u64, ok: bool) void {
    const trace = trace_id orelse "(none)";
    switch (controlLogKind(ok, duration_ms)) {
        .none => {},
        .failed => std.log.warn("control request failed type={s} trace_id={s} duration_ms={d}", .{ @tagName(request_type), trace, duration_ms }),
        .slow => std.log.warn("control request slow type={s} trace_id={s} duration_ms={d}", .{ @tagName(request_type), trace, duration_ms }),
    }
}

pub fn prepareStorage(self: anytype) !void {
    try ensureOwnerOnlyDir(self.allocator, self.config.root_dir);
    try ensureOwnerOnlyDir(self.allocator, self.config.run_dir);
    try std.fs.cwd().makePath(self.config.sessions_dir);
    try std.fs.cwd().makePath(self.config.adapters_dir);
    const worktrees_dir = try std.fs.path.join(self.allocator, &.{ self.config.root_dir, "worktrees" });
    defer self.allocator.free(worktrees_dir);
    try std.fs.cwd().makePath(worktrees_dir);
    self.reloadPersistencePolicyFromSettingsLocked();
    if (self.database == null) self.database = try db.Database.open(self.allocator, self.config.database_path);
    try self.writePidFile();
}

pub fn printConfig(self: anytype) void {
    std.debug.print(
        "root={s}\ndatabase={s}\nrun={s}\nsessions={s}\nadapters={s}\nsocket={s}\npid={s}\n",
        .{
            self.config.root_dir,
            self.config.database_path,
            self.config.run_dir,
            self.config.sessions_dir,
            self.config.adapters_dir,
            self.config.socket_path,
            self.config.pid_path,
        },
    );
}

pub fn runForever(self: anytype) !void {
    try removeInactiveSocketPath(self.config.socket_path);

    const address = try std.net.Address.initUnix(self.config.socket_path);
    var server = try address.listen(.{});
    defer server.deinit();
    try chmodPath(self.allocator, self.config.socket_path, owner_socket_mode);
    const socket_stat = try lstatPath(self.config.socket_path);
    assert(std.posix.S.ISSOCK(socket_stat.mode));
    assert(socket_stat.uid == std.c.geteuid());

    std.log.info("taod listening on {s}", .{self.config.socket_path});
    std.log.info("control RPC, PTY driver, event log, and binary attach stream enabled", .{});

    const ConnectionContext = struct {
        daemon: @TypeOf(self),
        stream: std.net.Stream,
    };

    while (true) {
        const connection = try server.accept();
        const stream = connection.stream;
        if (!self.reserveControlConnection()) {
            std.log.warn("refusing control RPC connection: active connection cap reached ({d})", .{limits.control_connections_max});
            stream.close();
            continue;
        }
        assert(self.active_control_connections.load(.monotonic) <= limits.control_connections_max);

        const context = self.allocator.create(ConnectionContext) catch |err| {
            self.releaseControlConnection();
            stream.close();
            return err;
        };
        context.* = .{ .daemon = self, .stream = stream };

        const thread = std.Thread.spawn(.{}, handleConnectionThread, .{context}) catch |err| {
            std.log.warn("failed to spawn control RPC thread: {s}; handling inline", .{@errorName(err)});
            self.handleStream(stream) catch |stream_err| {
                std.log.warn("control RPC connection failed: {s}", .{@errorName(stream_err)});
            };
            self.releaseControlConnection();
            self.allocator.destroy(context);
            continue;
        };
        thread.detach();
    }
}

pub fn handleControlPayload(self: anytype, allocator: std.mem.Allocator, payload: []const u8) ![]u8 {
    var parsed = std.json.parseFromSlice(rpc.ControlRequestJson, allocator, payload, .{
        .ignore_unknown_fields = true,
    }) catch |err| {
        return rpc.responseJsonAlloc(allocator, .{
            .ok = false,
            .error_message = @errorName(err),
        });
    };
    defer parsed.deinit();

    const response = try self.handleControlRequest(allocator, parsed.value);
    defer allocator.free(response);
    return rpc.responseJsonWithTraceAlloc(allocator, response, parsed.value.requestTraceId());
}

pub fn handleControlRequest(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    var lock = self.acquireLock();
    defer lock.deinit();

    const request_type = request.requestType();
    const trace_id = request.requestTraceId();
    const started_ns = std.time.nanoTimestamp();
    var ok = false;
    defer {
        const elapsed_ns = std.time.nanoTimestamp() - started_ns;
        const duration_ms: u64 = if (elapsed_ns > 0) @intCast(@divTrunc(elapsed_ns, std.time.ns_per_ms)) else 0;
        self.recordControlDiagnosticsLocked(request_type, trace_id, duration_ms, ok);
        logControlRequestIfNeeded(request_type, trace_id, duration_ms, ok);
    }

    const response = try switch (request_type) {
        .create => self.handleCreateLocked(allocator, request),
        .attach => self.handleAttachLocked(allocator, request),
        .resize => self.handleResizeLocked(allocator, request),
        .detach => self.handleDetachLocked(allocator, request),
        .kill => self.handleKillLocked(allocator, request),
        .clear_history => self.handleClearHistoryLocked(allocator, request),
        .cleanup => self.handleCleanupLocked(allocator, request),
        .configure_persistence => self.handleConfigurePersistenceLocked(allocator, request),
        .workspace_list => self.handleWorkspaceListLocked(allocator, request),
        .workspace_add => self.handleWorkspaceAddLocked(allocator, request),
        .workspace_remove => self.handleWorkspaceRemoveLocked(allocator, request),
        .workspace_refresh => self.handleWorkspaceRefreshLocked(allocator, request),
        .workspace_reorder => self.handleWorkspaceReorderLocked(allocator, request),
        .workspace_branch => self.handleWorkspaceBranchLocked(allocator, request),
        .workspace_branches => self.handleWorkspaceBranchesLocked(allocator, request),
        .workspace_git_worktrees => self.handleWorkspaceGitWorktreesLocked(allocator, request),
        .workspace_status => self.handleWorkspaceStatusLocked(allocator, request),
        .workspace_file_tree => self.handleWorkspaceFileTreeLocked(allocator, request),
        .workspace_diff => self.handleWorkspaceDiffLocked(allocator, request),
        .workspace_stage_path => self.handleWorkspaceStagePathLocked(allocator, request),
        .workspace_unstage_path => self.handleWorkspaceUnstagePathLocked(allocator, request),
        .workspace_revert_path => self.handleWorkspaceRevertPathLocked(allocator, request),
        .workspace_ports => self.handleWorkspacePortsLocked(allocator, request),
        .workspace_pull_request => self.handleWorkspacePullRequestLocked(allocator, request),
        .worktree_list => self.handleWorktreeListLocked(allocator, request),
        .worktree_create => self.handleWorktreeCreateLocked(allocator, request),
        .worktree_remove => self.handleWorktreeRemoveLocked(allocator, request),
        .worktree_adopt => self.handleWorktreeAdoptLocked(allocator, request),
        .worktree_handoff => self.handleWorktreeHandoffLocked(allocator, request),
        .worktree_refresh => self.handleWorktreeRefreshLocked(allocator, request),
        .worktree_reorder => self.handleWorktreeReorderLocked(allocator, request),
        .ping => blk: {
            const response = try rpc.responseJsonAlloc(allocator, .{
                .id = request.requestId(),
                .ok = true,
                .status = "ok",
                .protocol_version = rpc.control_protocol_version,
                .daemon_version = rpc.daemon_version,
                .capabilities = rpc.control_capabilities[0..],
                .stream_diagnostics = self.streamDiagnosticsLocked(),
            });
            defer allocator.free(response);
            break :blk rpc.responseJsonWithControlDiagnosticsAlloc(allocator, response, self.controlDiagnosticsLocked());
        },
        .unknown => rpc.responseJsonAlloc(allocator, .{
            .id = request.requestId(),
            .ok = false,
            .error_message = "unknown method",
        }),
    };
    ok = responsePayloadOk(allocator, response);
    return response;
}

fn responsePayloadOk(allocator: std.mem.Allocator, response: []const u8) bool {
    const MinimalResponse = struct { ok: bool = false };
    var parsed = std.json.parseFromSlice(MinimalResponse, allocator, response, .{
        .ignore_unknown_fields = true,
    }) catch return false;
    defer parsed.deinit();
    return parsed.value.ok;
}

pub fn handleStream(self: anytype, stream: std.net.Stream) !void {
    defer stream.close();
    assert(stream.handle >= 0);

    try verifyPeerOwner(stream.handle);

    var control = try readControlPayloadWithTimeout(self.allocator, stream.handle, limits.control_first_line_timeout_ms);
    defer control.deinit(self.allocator);

    var parsed = std.json.parseFromSlice(rpc.ControlRequestJson, self.allocator, control.payload, .{
        .ignore_unknown_fields = true,
    }) catch |err| {
        const response = try rpc.responseJsonAlloc(self.allocator, .{
            .ok = false,
            .error_message = @errorName(err),
        });
        defer self.allocator.free(response);
        try writeAllFd(stream.handle, response);
        return;
    };
    defer parsed.deinit();

    const request = parsed.value;
    const response = try self.handleControlRequest(self.allocator, request);
    defer self.allocator.free(response);
    const traced_response = try rpc.responseJsonWithTraceAlloc(self.allocator, response, request.requestTraceId());
    defer self.allocator.free(traced_response);
    try writeAllFd(stream.handle, traced_response);

    if (request.requestType() == .attach) {
        if (request.requestSessionId()) |session_id| {
            try self.streamAttachedSession(stream.handle, session_id, control.tail);
        }
    }
}

pub fn writePidFile(self: anytype) !void {
    var buffer: [64]u8 = undefined;
    const pid_text = try std.fmt.bufPrint(&buffer, "{d}\n", .{std.c.getpid()});
    try std.fs.cwd().writeFile(.{ .sub_path = self.config.pid_path, .data = pid_text });
}

fn ensureOwnerOnlyDir(allocator: std.mem.Allocator, path: []const u8) !void {
    assert(path.len > 0);
    try std.fs.cwd().makePath(path);
    const stat = try lstatPath(path);
    if (!std.posix.S.ISDIR(stat.mode) or stat.uid != std.c.geteuid()) return error.UnsafeSocketPath;
    try chmodPath(allocator, path, owner_dir_mode);
    const updated = try lstatPath(path);
    assert(std.posix.S.ISDIR(updated.mode));
    assert(updated.uid == std.c.geteuid());
}

fn removeInactiveSocketPath(path: []const u8) !void {
    assert(path.len > 0);
    const stat = lstatPath(path) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    if (!std.posix.S.ISSOCK(stat.mode) or stat.uid != std.c.geteuid()) return error.UnsafeSocketPath;

    if (std.net.connectUnixSocket(path)) |stream| {
        stream.close();
        return error.ActiveSocketAlreadyExists;
    } else |err| switch (err) {
        error.ConnectionRefused => {},
        else => return err,
    }

    std.fs.cwd().deleteFile(path) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };
}

fn lstatPath(path: []const u8) !std.posix.Stat {
    return std.posix.fstatat(std.fs.cwd().fd, path, std.posix.AT.SYMLINK_NOFOLLOW);
}

fn chmodPath(allocator: std.mem.Allocator, path: []const u8, mode: std.c.mode_t) !void {
    assert(path.len > 0);
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    if (std.c.chmod(path_z.ptr, mode) != 0) return error.ChmodFailed;
}

fn verifyPeerOwner(socket_fd: std.c.fd_t) !void {
    assert(socket_fd >= 0);
    switch (builtin.os.tag) {
        .linux => {
            const UCred = extern struct {
                pid: std.c.pid_t,
                uid: std.c.uid_t,
                gid: std.c.gid_t,
            };
            var credentials: UCred = undefined;
            try std.posix.getsockopt(
                socket_fd,
                std.posix.SOL.SOCKET,
                std.posix.SO.PEERCRED,
                std.mem.asBytes(&credentials),
            );
            if (credentials.uid != std.c.geteuid()) return error.UnauthorizedPeer;
        },
        .macos => {
            var euid: std.c.uid_t = undefined;
            var egid: std.c.gid_t = undefined;
            if (getpeereid(socket_fd, &euid, &egid) != 0) return error.UnauthorizedPeer;
            if (euid != std.c.geteuid()) return error.UnauthorizedPeer;
        },
        else => return error.UnsupportedPlatform,
    }
}

test "control trace logging policy is quiet unless failed or slow" {
    try std.testing.expectEqual(ControlLogKind.none, controlLogKind(true, 0));
    try std.testing.expectEqual(ControlLogKind.none, controlLogKind(true, control_slow_log_threshold_ms - 1));
    try std.testing.expectEqual(ControlLogKind.slow, controlLogKind(true, control_slow_log_threshold_ms));
    try std.testing.expectEqual(ControlLogKind.failed, controlLogKind(false, 0));
}

test "daemon storage and socket paths are owner-only" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try @import("config.zig").Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    var daemon = @import("../daemon.zig").Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();
    try daemon.prepareStorage();

    const root_stat = try std.fs.cwd().statFile(config.root_dir);
    const run_stat = try std.fs.cwd().statFile(config.run_dir);
    try std.testing.expectEqual(@as(std.fs.File.Mode, owner_dir_mode), root_stat.mode & 0o777);
    try std.testing.expectEqual(@as(std.fs.File.Mode, owner_dir_mode), run_stat.mode & 0o777);

    const address = try std.net.Address.initUnix(config.socket_path);
    var listener = try address.listen(.{});
    defer listener.deinit();
    try chmodPath(std.testing.allocator, config.socket_path, owner_socket_mode);

    const socket_stat = try std.fs.cwd().statFile(config.socket_path);
    try std.testing.expectEqual(@as(std.fs.File.Mode, owner_socket_mode), socket_stat.mode & 0o777);
}

test "daemon stale socket cleanup refuses unsafe paths" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try @import("config.zig").Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    try ensureOwnerOnlyDir(std.testing.allocator, config.root_dir);
    try ensureOwnerOnlyDir(std.testing.allocator, config.run_dir);
    try std.fs.cwd().writeFile(.{ .sub_path = config.socket_path, .data = "not a socket" });
    try std.testing.expectError(error.UnsafeSocketPath, removeInactiveSocketPath(config.socket_path));

    const stat = try std.fs.cwd().statFile(config.socket_path);
    try std.testing.expectEqual(@as(u64, "not a socket".len), stat.size);
}

test "daemon stale socket cleanup refuses live sockets and removes stale owned sockets" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try @import("config.zig").Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    try ensureOwnerOnlyDir(std.testing.allocator, config.root_dir);
    try ensureOwnerOnlyDir(std.testing.allocator, config.run_dir);

    const address = try std.net.Address.initUnix(config.socket_path);
    var listener = try address.listen(.{});
    try chmodPath(std.testing.allocator, config.socket_path, owner_socket_mode);
    try std.testing.expectError(error.ActiveSocketAlreadyExists, removeInactiveSocketPath(config.socket_path));
    listener.deinit();

    try removeInactiveSocketPath(config.socket_path);
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().statFile(config.socket_path));
}

test "daemon peer owner check accepts same-user local sockets" {
    if (builtin.os.tag != .linux and builtin.os.tag != .macos) return;

    var sockets: [2]std.c.fd_t = undefined;
    if (std.c.socketpair(std.c.AF.UNIX, std.c.SOCK.STREAM, 0, &sockets) != 0) {
        return error.SocketPairFailed;
    }
    defer _ = std.c.close(sockets[0]);
    defer _ = std.c.close(sockets[1]);

    try verifyPeerOwner(sockets[0]);
    try verifyPeerOwner(sockets[1]);
}
