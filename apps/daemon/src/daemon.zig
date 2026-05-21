const std = @import("std");
const db = @import("db.zig");
const event_log = @import("event_log.zig");
const limits = @import("limits.zig");
const pty = @import("pty.zig");
const rpc = @import("rpc.zig");
const session = @import("session.zig");
const snapshot = @import("snapshot.zig");
const vt = @import("vt.zig");
const workspace_mod = @import("workspace.zig");
const worktree_mod = @import("worktree.zig");

const daemon_config = @import("daemon/config.zig");
const fd_io = @import("daemon/fd_io.zig");
const protocol = @import("daemon/protocol.zig");
const util = @import("daemon/util.zig");
const types = @import("daemon/types.zig");
const server = @import("daemon/server.zig");
const control = @import("daemon/control.zig");
const persistence = @import("daemon/persistence.zig");
const process = @import("daemon/process.zig");
const stream_mod = @import("daemon/stream.zig");
const agent_index = @import("daemon/agent_index.zig");
const screen = @import("daemon/screen.zig");

const fileExists = util.fileExists;

const PersistencePolicy = types.PersistencePolicy;
const RestoreResult = types.RestoreResult;
const AgentDetectionSnapshot = types.AgentDetectionSnapshot;
const SearchExcerptSnapshot = types.SearchExcerptSnapshot;
const CurrentScreenCheckpoint = types.CurrentScreenCheckpoint;

pub const Config = daemon_config.Config;

test {
    _ = daemon_config;
    _ = fd_io;
    _ = protocol;
    _ = util;
    _ = types;
    _ = server;
    _ = control;
    _ = persistence;
    _ = process;
    _ = stream_mod;
    _ = agent_index;
    _ = screen;
    _ = workspace_mod;
    _ = worktree_mod;
}

pub const Daemon = struct {
    allocator: std.mem.Allocator,
    config: Config,
    sessions: session.Manager,
    pty_driver: pty.Driver,
    database: ?db.Database,
    persistence: PersistencePolicy,
    mutex: std.Thread.Mutex = .{},
    active_control_connections: std.atomic.Value(usize) = std.atomic.Value(usize).init(0),
    active_session_readers: std.atomic.Value(usize) = std.atomic.Value(usize).init(0),

    const ProcessContext = process.Context(*Daemon);
    const StreamContext = stream_mod.Context(*Daemon);

    pub fn init(allocator: std.mem.Allocator, config: Config) Daemon {
        return .{
            .allocator = allocator,
            .config = config,
            .sessions = session.Manager.init(allocator),
            .pty_driver = pty.Driver.init(allocator),
            .database = null,
            .persistence = .{},
        };
    }

    pub fn deinit(self: *Daemon) void {
        self.stopSessionProcessesForDeinit();
        self.waitForSessionReadersForDeinit();
        if (self.database) |*database| database.deinit();
        self.sessions.deinit();
    }

    fn stopSessionProcessesForDeinit(self: *Daemon) void {
        self.lock();
        defer self.unlock();

        for (self.sessions.sessions.items) |*item| {
            if (item.pty_child) |*child| {
                if (child.pid > 0) {
                    self.pty_driver.terminate(child) catch |err| {
                        std.log.warn("failed to terminate PTY during daemon teardown for {s}: {t}", .{ item.id, err });
                        child.close();
                    };
                    _ = self.pty_driver.wait(child) catch |err| {
                        std.log.warn("failed to reap PTY during daemon teardown for {s}: {t}", .{ item.id, err });
                    };
                } else {
                    child.close();
                }
                item.pty_child = null;
            }
            item.reader_started = false;
            item.assertInvariants();
        }
    }

    fn waitForSessionReadersForDeinit(self: *Daemon) void {
        var spins: usize = 0;
        while (self.active_session_readers.load(.acquire) != 0) : (spins += 1) {
            if (spins != 0 and spins % 400 == 0) {
                std.log.warn("daemon teardown still waiting for {d} session readers", .{self.active_session_readers.load(.acquire)});
            }
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }
    }

    pub fn prepareStorage(self: *Daemon) !void {
        return server.prepareStorage(self);
    }

    pub fn printConfig(self: *Daemon) void {
        return server.printConfig(self);
    }

    pub fn runForever(self: *Daemon) !void {
        return server.runForever(self);
    }

    pub fn handleControlPayload(self: *Daemon, allocator: std.mem.Allocator, payload: []const u8) ![]u8 {
        return server.handleControlPayload(self, allocator, payload);
    }

    pub fn handleControlRequest(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return server.handleControlRequest(self, allocator, request);
    }

    pub fn handleStream(self: *Daemon, stream: std.net.Stream) !void {
        return server.handleStream(self, stream);
    }

    pub fn handleCreateLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleCreateLocked(self, allocator, request);
    }

    pub fn handleAttachLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleAttachLocked(self, allocator, request);
    }

    pub fn handleResizeLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleResizeLocked(self, allocator, request);
    }

    pub fn handleDetachLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleDetachLocked(self, allocator, request);
    }

    pub fn handleKillLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleKillLocked(self, allocator, request);
    }

    pub fn handleClearHistoryLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleClearHistoryLocked(self, allocator, request);
    }

    pub fn handleCleanupLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleCleanupLocked(self, allocator, request);
    }

    pub fn handleConfigurePersistenceLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleConfigurePersistenceLocked(self, allocator, request);
    }

    pub fn handleWorkspaceListLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return workspace_mod.handleListLocked(self, allocator, request);
    }

    pub fn handleWorkspaceAddLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return workspace_mod.handleAddLocked(self, allocator, request);
    }

    pub fn handleWorkspaceRemoveLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return workspace_mod.handleRemoveLocked(self, allocator, request);
    }

    pub fn handleWorkspaceRefreshLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return workspace_mod.handleRefreshLocked(self, allocator, request);
    }

    pub fn handleWorkspaceReorderLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return workspace_mod.handleReorderLocked(self, allocator, request);
    }

    pub fn handleWorktreeListLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return worktree_mod.handleListLocked(self, allocator, request);
    }

    pub fn handleWorktreeCreateLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return worktree_mod.handleCreateLocked(self, allocator, request);
    }

    pub fn handleWorktreeRemoveLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return worktree_mod.handleRemoveLocked(self, allocator, request);
    }

    pub fn handleWorktreeAdoptLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return worktree_mod.handleAdoptLocked(self, allocator, request);
    }

    pub fn handleWorktreeRefreshLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return worktree_mod.handleRefreshLocked(self, allocator, request);
    }

    pub fn handleWorktreeReorderLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return worktree_mod.handleReorderLocked(self, allocator, request);
    }

    pub fn restoreSessionFromDatabaseLocked(
        self: *Daemon,
        session_id: []const u8,
        request: rpc.ControlRequestJson,
    ) !?RestoreResult {
        return persistence.restoreSessionFromDatabaseLocked(self, session_id, request);
    }

    pub fn restoreSessionWithArgvJsonLocked(
        self: *Daemon,
        session_id: []const u8,
        terminal_id: []const u8,
        workspace_id: ?[]const u8,
        worktree_id: ?[]const u8,
        cwd: ?[]const u8,
        cols: u16,
        rows: u16,
        argv_json: []const u8,
        agent_status: []const u8,
    ) !?*session.TerminalSession {
        return persistence.restoreSessionWithArgvJsonLocked(self, session_id, terminal_id, workspace_id, worktree_id, cwd, cols, rows, argv_json, agent_status);
    }

    pub fn ensureSessionPersistence(self: *Daemon, item: *session.TerminalSession) !void {
        return persistence.ensureSessionPersistence(self, item);
    }

    pub fn applyPersistencePolicyToSessionsLocked(self: *Daemon) void {
        return persistence.applyPersistencePolicyToSessionsLocked(self);
    }

    pub fn reloadPersistencePolicyFromSettingsLocked(self: *Daemon) void {
        return persistence.reloadPersistencePolicyFromSettingsLocked(self);
    }

    pub fn resetSessionHistoryLocked(self: *Daemon, item: *session.TerminalSession) !void {
        return persistence.resetSessionHistoryLocked(self, item);
    }

    pub fn ensureSessionProcess(self: *Daemon, item: *session.TerminalSession, argv: []const []const u8) !void {
        return ProcessContext.init(self).ensureSessionProcess(item, argv);
    }

    pub fn startSessionReaderLocked(self: *Daemon, item: *session.TerminalSession) !void {
        return ProcessContext.init(self).startSessionReaderLocked(item);
    }

    pub fn streamAttachedSession(self: *Daemon, socket_fd: std.c.fd_t, session_id: []const u8, initial_tail: []const u8) !void {
        return StreamContext.init(self).streamAttachedSession(socket_fd, session_id, initial_tail);
    }

    pub fn applyPendingClientFrames(self: *Daemon, session_id: []const u8, pending: *std.ArrayList(u8)) !void {
        return StreamContext.init(self).applyPendingClientFrames(session_id, pending);
    }

    pub fn addSubscriber(self: *Daemon, session_id: []const u8, socket_fd: std.c.fd_t) !bool {
        return StreamContext.init(self).addSubscriber(session_id, socket_fd);
    }

    pub fn removeSubscriber(self: *Daemon, session_id: []const u8, socket_fd: std.c.fd_t) bool {
        return StreamContext.init(self).removeSubscriber(session_id, socket_fd);
    }

    pub fn sessionCanContinueStreaming(self: *Daemon, session_id: []const u8, socket_fd: std.c.fd_t) bool {
        return StreamContext.init(self).sessionCanContinueStreaming(session_id, socket_fd);
    }

    pub fn runSessionReader(self: *Daemon, session_id: []const u8) !void {
        return ProcessContext.init(self).runSessionReader(session_id);
    }

    pub fn liveChildFd(self: *Daemon, session_id: []const u8) ?std.c.fd_t {
        return ProcessContext.init(self).liveChildFd(session_id);
    }

    pub fn readPtyAndBroadcast(self: *Daemon, session_id: []const u8) !void {
        return ProcessContext.init(self).readPtyAndBroadcast(session_id);
    }

    pub fn applyClientFrame(self: *Daemon, frame: rpc.StreamFrame) !void {
        return StreamContext.init(self).applyClientFrame(frame);
    }

    pub fn reapExitedChild(self: *Daemon, session_id: []const u8) !bool {
        return ProcessContext.init(self).reapExitedChild(session_id);
    }

    pub fn markExitedAndBroadcast(self: *Daemon, session_id: []const u8, exit_code: i32, signal_value: i32) !bool {
        return ProcessContext.init(self).markExitedAndBroadcast(session_id, exit_code, signal_value);
    }

    pub fn recordTerminalSessionLocked(self: *Daemon, item: *const session.TerminalSession, argv_json: ?[]const u8) void {
        return persistence.recordTerminalSessionLocked(self, item, argv_json);
    }

    pub fn recordTerminalEndedLocked(self: *Daemon, item: *const session.TerminalSession, exit_code: i32, signal_value: i32) void {
        return persistence.recordTerminalEndedLocked(self, item, exit_code, signal_value);
    }

    pub fn searchExcerptSnapshotLocked(self: *Daemon, item: *const session.TerminalSession) !?SearchExcerptSnapshot {
        return persistence.searchExcerptSnapshotLocked(self, item);
    }

    pub fn agentDetectionSnapshotFromStoredArgvLocked(self: *Daemon, item: *const session.TerminalSession, status: []const u8) !?AgentDetectionSnapshot {
        return agent_index.agentDetectionSnapshotFromStoredArgvLocked(self, item, status);
    }

    pub fn agentDetectionSnapshotFromArgvLocked(
        self: *Daemon,
        item: *const session.TerminalSession,
        argv_items: []const []const u8,
        original_argv_json: ?[]const u8,
        status: []const u8,
    ) !?AgentDetectionSnapshot {
        return agent_index.agentDetectionSnapshotFromArgvLocked(self, item, argv_items, original_argv_json, status);
    }

    pub fn recordAgentSessionFromSnapshot(self: *Daemon, snapshot_input: *const AgentDetectionSnapshot) void {
        return agent_index.recordAgentSessionFromSnapshot(self, snapshot_input);
    }

    pub fn refreshAgentSessionMetadataFromStoredArgvLocked(self: *Daemon, item: *const session.TerminalSession, status: []const u8) void {
        return agent_index.refreshAgentSessionMetadataFromStoredArgvLocked(self, item, status);
    }

    pub fn recordAgentSessionLocked(
        self: *Daemon,
        item: *const session.TerminalSession,
        argv: []const []const u8,
        original_argv_json: ?[]const u8,
        status: []const u8,
    ) void {
        return agent_index.recordAgentSessionLocked(self, item, argv, original_argv_json, status);
    }

    pub fn indexSearchExcerptFromSnapshot(self: *Daemon, snapshot_input: *const SearchExcerptSnapshot) void {
        return agent_index.indexSearchExcerptFromSnapshot(self, snapshot_input);
    }

    pub fn pruneMissingEventLogMetadataLocked(self: *Daemon) void {
        return persistence.pruneMissingEventLogMetadataLocked(self);
    }

    pub fn broadcastExitFrameLocked(self: *Daemon, item: *session.TerminalSession, seq: u64, exit_code: i32, signal_value: i32) !void {
        return StreamContext.init(self).broadcastExitFrameLocked(item, seq, exit_code, signal_value);
    }

    pub fn checkpointCurrentScreenLocked(self: *Daemon, item: *session.TerminalSession) void {
        return screen.checkpointCurrentScreenLocked(self, item);
    }

    pub fn currentScreenCheckpointLocked(self: *Daemon, item: *const session.TerminalSession) !?CurrentScreenCheckpoint {
        return screen.currentScreenCheckpointLocked(self, item);
    }

    pub fn clearSnapshotFileLocked(self: *Daemon, item: *session.TerminalSession) void {
        return screen.clearSnapshotFileLocked(self, item);
    }

    pub fn sendCurrentScreenSnapshotToSubscriberLocked(self: *Daemon, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
        return screen.sendCurrentScreenSnapshotToSubscriberLocked(self, item, socket_fd);
    }

    pub fn broadcastStreamFrameLocked(
        self: *Daemon,
        item: *session.TerminalSession,
        kind: rpc.StreamKind,
        seq: u64,
        payload: []const u8,
    ) !void {
        return StreamContext.init(self).broadcastStreamFrameLocked(item, kind, seq, payload);
    }

    pub fn flushPendingOutputToSubscriberLocked(self: *Daemon, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
        return StreamContext.init(self).flushPendingOutputToSubscriberLocked(item, socket_fd);
    }

    /// Guarded daemon mutex ownership. Most daemon methods still expose the
    /// legacy `lock`/`unlock` pair because the control path deliberately drops
    /// the lock around filesystem, SQLite, and adapter work. New code should
    /// prefer this guard so lock ownership is local and mechanically paired.
    pub const LockGuard = struct {
        daemon: *Daemon,
        held: bool = true,

        pub fn release(self: *LockGuard) void {
            std.debug.assert(self.held);
            self.daemon.unlock();
            self.held = false;
        }

        pub fn reacquire(self: *LockGuard) void {
            std.debug.assert(!self.held);
            self.daemon.lock();
            self.held = true;
        }

        pub const UnlockedPhase = struct {
            guard: *LockGuard,

            pub fn deinit(self: *UnlockedPhase) void {
                self.guard.reacquire();
            }
        };

        pub fn unlocked(self: *LockGuard) UnlockedPhase {
            self.release();
            return .{ .guard = self };
        }

        pub fn deinit(self: *LockGuard) void {
            if (self.held) self.release();
        }
    };

    pub fn acquireLock(self: *Daemon) LockGuard {
        self.lock();
        return .{ .daemon = self };
    }

    pub fn lock(self: *Daemon) void {
        self.mutex.lock();
    }

    pub fn unlock(self: *Daemon) void {
        self.mutex.unlock();
    }

    pub fn reserveControlConnection(self: *Daemon) bool {
        while (true) {
            const active = self.active_control_connections.load(.monotonic);
            std.debug.assert(active <= limits.control_connections_max);
            if (active >= limits.control_connections_max) return false;
            if (self.active_control_connections.cmpxchgWeak(active, active + 1, .acquire, .monotonic) == null) {
                std.debug.assert(self.active_control_connections.load(.monotonic) <= limits.control_connections_max);
                return true;
            }
        }
    }

    pub fn releaseControlConnection(self: *Daemon) void {
        const previous = self.active_control_connections.fetchSub(1, .release);
        std.debug.assert(previous > 0);
        std.debug.assert(previous <= limits.control_connections_max);
    }

    pub fn writePidFile(self: *Daemon) !void {
        return server.writePidFile(self);
    }
};

test "daemon control connection reservations enforce configured cap" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    var reserved: usize = 0;
    while (reserved < limits.control_connections_max) : (reserved += 1) {
        try std.testing.expect(daemon.reserveControlConnection());
    }

    try std.testing.expect(!daemon.reserveControlConnection());
    try std.testing.expectEqual(limits.control_connections_max, daemon.active_control_connections.load(.monotonic));

    while (reserved > 0) {
        reserved -= 1;
        daemon.releaseControlConnection();
    }

    try std.testing.expectEqual(@as(usize, 0), daemon.active_control_connections.load(.monotonic));
    try std.testing.expect(daemon.reserveControlConnection());
    daemon.releaseControlConnection();
}

test "daemon control RPC creates and updates sessions" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"s1","terminal_id":"t1","workspace_id":"workspace-1","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    try std.testing.expect(daemon.sessions.find("s1") != null);
    try std.testing.expect(std.mem.indexOf(u8, created, "\"ok\":true") != null);

    const resized = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"2","method":"resize","session_id":"s1","cols":120,"rows":40}
    );
    defer std.testing.allocator.free(resized);

    try std.testing.expectEqual(@as(u16, 120), daemon.sessions.find("s1").?.cols);
    try std.testing.expect(std.mem.indexOf(u8, resized, "\"cols\":120") != null);

    const recreated = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"2b","method":"create","session_id":"s1","terminal_id":"t1b","workspace_id":"workspace-1","cols":90,"rows":25,"cwd":"/tmp"}
    );
    defer std.testing.allocator.free(recreated);

    try std.testing.expectEqualStrings("t1b", daemon.sessions.find("s1").?.terminal_id);
    try std.testing.expectEqualStrings("/tmp", daemon.sessions.find("s1").?.cwd.?);
    try std.testing.expectEqual(@as(u16, 90), daemon.sessions.find("s1").?.cols);

    const protocol_created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"3","type":"create","sessionId":"s2","terminalId":"t2","workspaceId":"workspace-1","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(protocol_created);

    try std.testing.expect(daemon.sessions.find("s2") != null);
}

test "daemon control RPC rejects session creation without workspace" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const response = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"s1","terminal_id":"t1","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(response);

    try std.testing.expect(daemon.sessions.find("s1") == null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "missing field: workspace_id") != null);
}

test "daemon control RPC reports missing sessions" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const response = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"attach","session_id":"missing"}
    );
    defer std.testing.allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"error_code\":\"session_not_found\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "session not found") != null);

    const exited = try daemon.sessions.create(.{
        .session_id = "exited",
        .terminal_id = "terminal-exited",
        .cols = 80,
        .rows = 24,
        .cwd = null,
        .argv = &.{},
    });
    exited.status = .exited;

    const non_live_response = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"2","method":"attach","session_id":"exited"}
    );
    defer std.testing.allocator.free(non_live_response);

    try std.testing.expect(std.mem.indexOf(u8, non_live_response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, non_live_response, "\"error_code\":\"session_not_found\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, non_live_response, "session is not live") != null);
}

test "daemon persistence privacy toggle avoids session log creation" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();
    try daemon.prepareStorage();

    const configured = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"privacy","type":"configure-persistence","persistenceEnabled":false,"persistInput":true}
    );
    defer std.testing.allocator.free(configured);
    try std.testing.expect(std.mem.indexOf(u8, configured, "\"persistence_enabled\":false") != null);

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"private-session","terminal_id":"private-terminal","workspace_id":"workspace-1","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    const item = daemon.sessions.find("private-session").?;
    try std.testing.expect(item.event_log_path == null);
    try std.testing.expect(item.excerpt_path == null);
    try std.testing.expect((try event_log.openExistingSession(std.testing.allocator, daemon.config.sessions_dir, "private-session")) == null);
}

test "daemon drops failed stream subscribers without blocking pending output" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"stream-session","terminal_id":"stream-terminal","workspace_id":"workspace-1","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    const item = daemon.sessions.find("stream-session").?;
    {
        daemon.lock();
        defer daemon.unlock();
        try item.subscribers.append(std.testing.allocator, -1);
        try daemon.broadcastStreamFrameLocked(item, .output, 1, "live output");
    }
    try std.testing.expectEqual(@as(usize, 0), item.subscribers.items.len);
    try std.testing.expectEqual(@as(usize, 1), item.pending_output.items.len);
    try std.testing.expectEqualStrings("live output", item.pending_output.items[0].payload);

    {
        daemon.lock();
        defer daemon.unlock();
        try daemon.broadcastStreamFrameLocked(item, .output, 2, "detached output");
    }
    try std.testing.expectEqual(@as(usize, 2), item.pending_output.items.len);
    try std.testing.expectEqualStrings("detached output", item.pending_output.items[1].payload);
}

test "daemon falls back to saved command when agent resume metadata is corrupt" {
    if (!fileExists("/bin/sh")) return;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();
    try daemon.prepareStorage();

    if (daemon.database) |*database| {
        try database.insertWorkspace(.{
            .id = "workspace-resume",
            .name = "resume",
            .root_path = home,
            .git_common_dir = null,
            .workspace_slug = "resume",
            .default_branch = null,
            .order_index = 0,
        });
        try database.insertWorktree(.{
            .id = "worktree-resume",
            .workspace_id = "workspace-resume",
            .title = "Resume worktree",
            .folder_name = "resume-worktree-a13f",
            .path = home,
            .branch = "resume-worktree-a13f",
            .base_branch = "main",
            .target_branch = "main",
            .state = "active",
            .order_index = 0,
        });
        try database.recordTerminalSession(.{
            .id = "resume-session",
            .terminal_id = "resume-terminal",
            .workspace_id = "workspace-resume",
            .worktree_id = "worktree-resume",
            .argv_json = "[\"/bin/sh\",\"-c\",\"sleep 2\"]",
            .status = "exited",
            .cols = 80,
            .rows = 24,
            .event_log_path = "/tmp/tao-resume-session/events.taoev",
            .last_seq = 0,
        });
        try database.recordAgentSession(.{
            .id = "agent-resume-session-pi",
            .terminal_session_id = "resume-session",
            .provider = "pi",
            .native_session_id = "native-123",
            .resume_argv_json = "[",
            .status = "resumable",
        });
    } else unreachable;

    const attached = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"attach","type":"attach","sessionId":"resume-session","terminalId":"resume-terminal","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(attached);

    try std.testing.expect(std.mem.indexOf(u8, attached, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, attached, "\"attach_kind\":\"command-resume\"") != null);
    const restored = daemon.sessions.find("resume-session").?;
    try std.testing.expectEqualStrings("workspace-resume", restored.workspace_id.?);
    try std.testing.expectEqualStrings("worktree-resume", restored.worktree_id.?);

    const killed = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"kill","type":"kill","sessionId":"resume-session"}
    );
    defer std.testing.allocator.free(killed);
    try std.testing.expect(std.mem.indexOf(u8, killed, "\"ok\":true") != null);
}

test "daemon requires workspace to restore legacy persisted sessions" {
    if (!fileExists("/bin/sh")) return;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();
    try daemon.prepareStorage();

    if (daemon.database) |*database| {
        try database.recordTerminalSession(.{
            .id = "legacy-session",
            .terminal_id = "legacy-terminal",
            .argv_json = "[\"/bin/sh\",\"-c\",\"sleep 2\"]",
            .status = "exited",
            .cols = 80,
            .rows = 24,
            .event_log_path = "/tmp/tao-legacy-session/events.taoev",
            .last_seq = 0,
        });
    } else unreachable;

    const missing_workspace = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"attach","type":"attach","sessionId":"legacy-session","terminalId":"legacy-terminal","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(missing_workspace);

    try std.testing.expect(std.mem.indexOf(u8, missing_workspace, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, missing_workspace, "\"session_not_found\"") != null);
    try std.testing.expect(daemon.sessions.find("legacy-session") == null);

    const attached = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"attach","type":"attach","sessionId":"legacy-session","terminalId":"legacy-terminal","workspaceId":"workspace-resume","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(attached);

    try std.testing.expect(std.mem.indexOf(u8, attached, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, attached, "\"attach_kind\":\"command-resume\"") != null);
    const restored = daemon.sessions.find("legacy-session").?;
    try std.testing.expectEqualStrings("workspace-resume", restored.workspace_id.?);

    const killed = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"kill","type":"kill","sessionId":"legacy-session"}
    );
    defer std.testing.allocator.free(killed);
    try std.testing.expect(std.mem.indexOf(u8, killed, "\"ok\":true") != null);
}

test "daemon detach checkpoints current-screen snapshot" {
    if (!vt.supports_current_screen_snapshots) return;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();
    try daemon.prepareStorage();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"snapshot-session","terminal_id":"snapshot-terminal","workspace_id":"workspace-1","cols":24,"rows":4}
    );
    defer std.testing.allocator.free(created);

    const item = daemon.sessions.find("snapshot-session").?;
    try item.writeVt("snapshot text");

    const detached = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"2","method":"detach","session_id":"snapshot-session"}
    );
    defer std.testing.allocator.free(detached);

    try std.testing.expect(item.snapshot_crc32 != null);
    try std.testing.expect(item.snapshot_size > 0);

    var decoded = (try snapshot.readCurrentScreenPath(std.testing.allocator, item.snapshot_path.?)).?;
    defer decoded.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings(vt.backend_name, decoded.backend_name);

    var restored = try vt.Terminal.init(std.testing.allocator, 1, 1);
    defer restored.deinit(std.testing.allocator);
    try restored.deserializeCurrentScreen(std.testing.allocator, decoded.payload);

    const text = try restored.plainTextAlloc(std.testing.allocator);
    defer std.testing.allocator.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "snapshot text") != null);
}
