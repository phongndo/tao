const std = @import("std");
const adapter = @import("adapter.zig");
const cleanup = @import("cleanup.zig");
const db = @import("db.zig");
const event_log = @import("event_log.zig");
const pty = @import("pty.zig");
const rpc = @import("rpc.zig");
const session = @import("session.zig");
const snapshot = @import("snapshot.zig");
const vt = @import("vt.zig");

const control_payload_max = 64 * 1024;

const PersistencePolicy = struct {
    enabled: bool = true,
    persist_input: bool = false,
};

const PersistenceSettingsJson = struct {
    enabled: ?bool = null,
    persistInput: ?bool = null,
    persist_input: ?bool = null,
};

const SettingsJson = struct {
    persistence: ?PersistenceSettingsJson = null,
};

const AttachKind = enum {
    live,
    command_resume,
    agent_resume,

    fn text(self: AttachKind) []const u8 {
        return switch (self) {
            .live => "live",
            .command_resume => "command-resume",
            .agent_resume => "agent-resume",
        };
    }
};

const RestoreResult = struct {
    item: *session.TerminalSession,
    attach_kind: AttachKind,
    agent_provider: ?[]u8 = null,
    native_session_id: ?[]u8 = null,

    fn deinit(self: *RestoreResult, allocator: std.mem.Allocator) void {
        if (self.agent_provider) |value| allocator.free(value);
        if (self.native_session_id) |value| allocator.free(value);
        self.* = undefined;
    }
};

const SessionResponseMetadata = struct {
    attach_kind: AttachKind = .live,
    agent_provider: ?[]const u8 = null,
    native_session_id: ?[]const u8 = null,
};

const AgentDetectionSnapshot = struct {
    terminal_session_id: []u8,
    session_dir: ?[]u8,
    event_log_path: ?[]u8,
    excerpt_path: ?[]u8,
    cwd: ?[]u8,
    argv: []const []const u8,
    original_argv_json: ?[]u8,
    status: []const u8,

    fn deinit(self: *AgentDetectionSnapshot, allocator: std.mem.Allocator) void {
        allocator.free(self.terminal_session_id);
        if (self.session_dir) |value| allocator.free(value);
        if (self.event_log_path) |value| allocator.free(value);
        if (self.excerpt_path) |value| allocator.free(value);
        if (self.cwd) |value| allocator.free(value);
        for (self.argv) |arg| allocator.free(arg);
        allocator.free(self.argv);
        if (self.original_argv_json) |value| allocator.free(value);
        self.* = undefined;
    }
};

pub const Config = struct {
    root_dir: []const u8,
    database_path: []const u8,
    run_dir: []const u8,
    sessions_dir: []const u8,
    adapters_dir: []const u8,
    socket_path: []const u8,
    pid_path: []const u8,

    pub fn fromHome(allocator: std.mem.Allocator, home: []const u8) !Config {
        const root_dir = try std.fs.path.join(allocator, &.{ home, ".tao" });
        errdefer allocator.free(root_dir);
        const database_path = try std.fs.path.join(allocator, &.{ root_dir, "tao.db" });
        errdefer allocator.free(database_path);
        const run_dir = try std.fs.path.join(allocator, &.{ root_dir, "run" });
        errdefer allocator.free(run_dir);
        const sessions_dir = try std.fs.path.join(allocator, &.{ root_dir, "sessions" });
        errdefer allocator.free(sessions_dir);
        const adapters_dir = try adapterDirFromEnvOrDefault(allocator, root_dir);
        errdefer allocator.free(adapters_dir);
        const socket_path = try std.fs.path.join(allocator, &.{ run_dir, "taod.sock" });
        errdefer allocator.free(socket_path);
        const pid_path = try std.fs.path.join(allocator, &.{ run_dir, "taod.pid" });

        return .{
            .root_dir = root_dir,
            .database_path = database_path,
            .run_dir = run_dir,
            .sessions_dir = sessions_dir,
            .adapters_dir = adapters_dir,
            .socket_path = socket_path,
            .pid_path = pid_path,
        };
    }

    pub fn deinit(self: *Config, allocator: std.mem.Allocator) void {
        allocator.free(self.root_dir);
        allocator.free(self.database_path);
        allocator.free(self.run_dir);
        allocator.free(self.sessions_dir);
        allocator.free(self.adapters_dir);
        allocator.free(self.socket_path);
        allocator.free(self.pid_path);
        self.* = undefined;
    }
};

pub const Daemon = struct {
    allocator: std.mem.Allocator,
    config: Config,
    sessions: session.Manager,
    pty_driver: pty.Driver,
    database: ?db.Database,
    persistence: PersistencePolicy,
    mutex: std.Thread.Mutex = .{},

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
        if (self.database) |*database| database.deinit();
        self.sessions.deinit();
    }

    pub fn prepareStorage(self: *Daemon) !void {
        try std.fs.cwd().makePath(self.config.run_dir);
        try std.fs.cwd().makePath(self.config.sessions_dir);
        try std.fs.cwd().makePath(self.config.adapters_dir);
        self.reloadPersistencePolicyFromSettingsLocked();
        if (self.database == null) self.database = try db.Database.open(self.allocator, self.config.database_path);
        try self.writePidFile();
    }

    pub fn printConfig(self: *Daemon) void {
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

    pub fn runForever(self: *Daemon) !void {
        std.fs.cwd().deleteFile(self.config.socket_path) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };

        const address = try std.net.Address.initUnix(self.config.socket_path);
        var server = try address.listen(.{});
        defer server.deinit();

        std.log.info("taod listening on {s}", .{self.config.socket_path});
        std.log.info("control RPC, PTY driver, event log, and binary attach stream enabled", .{});

        while (true) {
            const connection = try server.accept();
            const stream = connection.stream;
            const context = self.allocator.create(ConnectionContext) catch |err| {
                stream.close();
                return err;
            };
            context.* = .{ .daemon = self, .stream = stream };

            const thread = std.Thread.spawn(.{}, handleConnectionThread, .{context}) catch |err| {
                std.log.warn("failed to spawn control RPC thread: {t}; handling inline", .{err});
                self.handleStream(stream) catch |stream_err| {
                    std.log.warn("control RPC connection failed: {t}", .{stream_err});
                };
                self.allocator.destroy(context);
                continue;
            };
            thread.detach();
        }
    }

    pub fn handleControlPayload(self: *Daemon, allocator: std.mem.Allocator, payload: []const u8) ![]u8 {
        var parsed = std.json.parseFromSlice(rpc.ControlRequestJson, allocator, payload, .{
            .ignore_unknown_fields = true,
        }) catch |err| {
            return rpc.responseJsonAlloc(allocator, .{
                .ok = false,
                .error_message = @errorName(err),
            });
        };
        defer parsed.deinit();

        return self.handleControlRequest(allocator, parsed.value);
    }

    fn handleControlRequest(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        self.lock();
        defer self.unlock();

        return switch (request.requestType()) {
            .create => self.handleCreateLocked(allocator, request),
            .attach => self.handleAttachLocked(allocator, request),
            .resize => self.handleResizeLocked(allocator, request),
            .detach => self.handleDetachLocked(allocator, request),
            .kill => self.handleKillLocked(allocator, request),
            .clear_history => self.handleClearHistoryLocked(allocator, request),
            .cleanup => self.handleCleanupLocked(allocator, request),
            .configure_persistence => self.handleConfigurePersistenceLocked(allocator, request),
            .ping => rpc.responseJsonAlloc(allocator, .{
                .id = request.requestId(),
                .ok = true,
                .status = "ok",
            }),
            .unknown => rpc.responseJsonAlloc(allocator, .{
                .id = request.requestId(),
                .ok = false,
                .error_message = "unknown method",
            }),
        };
    }

    fn handleStream(self: *Daemon, stream: std.net.Stream) !void {
        defer stream.close();

        var control = try readControlPayload(self.allocator, stream.handle);
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
        try writeAllFd(stream.handle, response);

        if (request.requestType() == .attach) {
            if (request.requestSessionId()) |session_id| {
                try self.streamAttachedSession(stream.handle, session_id, control.tail);
            }
        }
    }

    fn handleCreateLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        var generated_session_id: ?[]u8 = null;
        const session_id = request.requestSessionId() orelse generated: {
            generated_session_id = try generateSessionId(allocator);
            break :generated generated_session_id.?;
        };
        defer if (generated_session_id) |value| allocator.free(value);

        const terminal_id = request.requestTerminalId() orelse return missingField(allocator, request, "terminal_id");
        const cols = request.cols orelse return missingField(allocator, request, "cols");
        const rows = request.rows orelse return missingField(allocator, request, "rows");

        const created = if (self.sessions.find(session_id)) |existing| blk: {
            existing.status = .live;
            try existing.updateCreateMetadata(self.allocator, terminal_id, request.cwd, cols, rows);
            break :blk existing;
        } else try self.sessions.create(.{
            .session_id = session_id,
            .terminal_id = terminal_id,
            .cols = cols,
            .rows = rows,
            .cwd = request.cwd,
            .argv = request.argv orelse &.{},
        });

        try self.ensureSessionPersistence(created);
        try self.ensureSessionProcess(created, request.argv orelse &.{});
        if (created.event_log_path) |path| {
            _ = event_log.appendResize(self.allocator, path, &created.last_seq, cols, rows) catch |err| {
                std.log.warn("failed to append create resize frame for {s}: {t}", .{ created.id, err });
            };
        }
        const argv_json = try argvJsonAlloc(self.allocator, request.argv orelse &.{});
        defer if (argv_json) |json| self.allocator.free(json);
        self.recordTerminalSessionLocked(created, argv_json);
        var agent_snapshot = self.agentDetectionSnapshotFromArgvLocked(created, request.argv orelse &.{}, argv_json, "running") catch |err| blk: {
            std.log.warn("failed to prepare agent metadata for {s}: {t}", .{ created.id, err });
            break :blk null;
        };
        try self.startSessionReaderLocked(created);
        const response = try sessionResponse(allocator, request, created, .{});

        self.unlock();
        defer if (agent_snapshot) |*value| value.deinit(self.allocator);
        if (agent_snapshot) |*value| self.recordAgentSessionFromSnapshot(value);
        self.lock();

        return response;
    }

    fn handleAttachLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
        var restored_result: ?RestoreResult = null;
        defer if (restored_result) |*result| result.deinit(self.allocator);

        const attached = self.sessions.attach(session_id) orelse blk: {
            restored_result = (try self.restoreSessionFromDatabaseLocked(session_id, request)) orelse return notFound(allocator, request);
            break :blk restored_result.?.item;
        };
        if (!isLiveAttachable(attached)) {
            return rpc.responseJsonAlloc(allocator, .{
                .id = request.requestId(),
                .ok = false,
                .error_message = "session is not live",
            });
        }
        self.recordTerminalSessionLocked(attached, null);
        const metadata: SessionResponseMetadata = if (restored_result) |result| .{
            .attach_kind = result.attach_kind,
            .agent_provider = result.agent_provider,
            .native_session_id = result.native_session_id,
        } else .{ .attach_kind = .live };
        return sessionResponse(allocator, request, attached, metadata);
    }

    fn handleResizeLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
        const cols = request.cols orelse return missingField(allocator, request, "cols");
        const rows = request.rows orelse return missingField(allocator, request, "rows");
        const item = self.sessions.find(session_id) orelse return notFound(allocator, request);
        if (item.pty_child) |*child| try self.pty_driver.resize(child, cols, rows);
        if (!self.sessions.resize(session_id, cols, rows)) return notFound(allocator, request);
        if (item.event_log_path) |path| {
            _ = event_log.appendResize(self.allocator, path, &item.last_seq, cols, rows) catch |err| {
                std.log.warn("failed to append resize frame for {s}: {t}", .{ item.id, err });
            };
        }
        self.recordTerminalSessionLocked(item, null);

        return sessionResponse(allocator, request, self.sessions.find(session_id).?, .{});
    }

    fn handleDetachLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
        if (!self.sessions.detach(session_id)) return notFound(allocator, request);
        const item = self.sessions.find(session_id).?;
        if (item.subscribers.items.len == 0) self.checkpointCurrentScreenLocked(item);
        self.recordTerminalSessionLocked(item, null);

        return sessionResponse(allocator, request, item, .{});
    }

    fn handleKillLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
        const item = self.sessions.find(session_id) orelse return notFound(allocator, request);
        if (item.pty_child) |*child| {
            self.pty_driver.terminate(child) catch |err| {
                std.log.warn("failed to terminate PTY for {s}: {t}", .{ item.id, err });
            };
            child.close();
        }
        if (item.event_log_path) |path| {
            _ = event_log.appendExit(self.allocator, path, &item.last_seq, 0, 15) catch |err| {
                std.log.warn("failed to append kill exit frame for {s}: {t}", .{ item.id, err });
            };
        }
        item.pty_child = null;
        item.reader_started = false;
        try self.broadcastExitFrameLocked(item, item.last_seq, 0, 15);
        if (!self.sessions.kill(session_id)) return notFound(allocator, request);
        self.recordTerminalEndedLocked(item, 0, 15);

        return sessionResponse(allocator, request, self.sessions.find(session_id).?, .{});
    }

    fn handleClearHistoryLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        var result: cleanup.MaintenanceResult = .{};

        if (request.requestSessionIds()) |session_ids| {
            for (session_ids) |session_id| {
                if (self.sessions.find(session_id)) |item| {
                    try self.resetSessionHistoryLocked(item);
                    result.removed_sessions += 1;
                    continue;
                }

                self.unlock();
                const removed = cleanup.deleteSessionDir(self.allocator, self.config.sessions_dir, session_id) catch |err| {
                    self.lock();
                    std.log.warn("failed to clear persisted session {s}: {t}", .{ session_id, err });
                    continue;
                };
                self.lock();
                result.add(removed);
                if (removed.removed_sessions > 0) {
                    if (self.database) |*database| database.deleteTerminalSessionMetadata(session_id) catch |err| {
                        std.log.warn("failed to delete cleared session metadata {s}: {t}", .{ session_id, err });
                    };
                }
            }
        } else {
            var active_ids: std.ArrayList([]const u8) = .empty;
            defer {
                for (active_ids.items) |active_id| self.allocator.free(active_id);
                active_ids.deinit(self.allocator);
            }

            for (self.sessions.sessions.items) |*item| {
                const active_id = try self.allocator.dupe(u8, item.id);
                active_ids.append(self.allocator, active_id) catch |err| {
                    self.allocator.free(active_id);
                    return err;
                };
            }

            for (active_ids.items) |active_id| {
                if (self.sessions.find(active_id)) |item| {
                    try self.resetSessionHistoryLocked(item);
                }
                result.removed_sessions += 1;
            }

            self.unlock();
            var locked_after_delete = false;
            const removed = cleanup.deleteInactiveSessionDirs(
                self.allocator,
                self.config.sessions_dir,
                active_ids.items,
            ) catch |err| blk: {
                self.lock();
                locked_after_delete = true;
                std.log.warn("failed to clear inactive session history: {t}", .{err});
                break :blk cleanup.MaintenanceResult{};
            };
            if (!locked_after_delete) self.lock();
            result.add(removed);
            self.pruneMissingEventLogMetadataLocked();
        }

        return rpc.responseJsonAlloc(allocator, .{
            .id = request.requestId(),
            .ok = true,
            .removed_sessions = result.removed_sessions,
            .removed_bytes = result.removed_bytes,
        });
    }

    fn handleCleanupLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        var active_ids: std.ArrayList([]const u8) = .empty;
        defer {
            for (active_ids.items) |active_id| self.allocator.free(active_id);
            active_ids.deinit(self.allocator);
        }

        for (self.sessions.sessions.items) |*item| {
            const active_id = try self.allocator.dupe(u8, item.id);
            active_ids.append(self.allocator, active_id) catch |err| {
                self.allocator.free(active_id);
                return err;
            };
        }
        if (request.requestActiveSessionIds()) |request_active_ids| {
            for (request_active_ids) |active_id| {
                if (cleanup.isActiveSession(active_id, active_ids.items)) continue;
                const owned_active_id = try self.allocator.dupe(u8, active_id);
                active_ids.append(self.allocator, owned_active_id) catch |err| {
                    self.allocator.free(owned_active_id);
                    return err;
                };
            }
        }

        const retain_days = request.requestRetainDays() orelse 30;
        const max_session_bytes = request.requestMaxSessionBytes() orelse 2 * 1024 * 1024 * 1024;

        self.unlock();
        const result = cleanup.runSessionRetention(self.allocator, self.config.sessions_dir, .{
            .retain_days = retain_days,
            .max_session_bytes = max_session_bytes,
            .active_session_ids = active_ids.items,
        }) catch |err| {
            self.lock();
            std.log.warn("session cleanup failed: {t}", .{err});
            return rpc.responseJsonAlloc(allocator, .{
                .id = request.requestId(),
                .ok = false,
                .error_message = @errorName(err),
            });
        };
        self.lock();
        self.pruneMissingEventLogMetadataLocked();

        return rpc.responseJsonAlloc(allocator, .{
            .id = request.requestId(),
            .ok = true,
            .removed_sessions = result.removed_sessions,
            .removed_bytes = result.removed_bytes,
        });
    }

    fn handleConfigurePersistenceLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        if (request.requestPersistenceEnabled()) |enabled| self.persistence.enabled = enabled;
        if (request.requestPersistInput()) |persist_input| self.persistence.persist_input = persist_input;
        self.applyPersistencePolicyToSessionsLocked();

        return rpc.responseJsonAlloc(allocator, .{
            .id = request.requestId(),
            .ok = true,
            .persistence_enabled = self.persistence.enabled,
            .persist_input = self.persistence.persist_input,
        });
    }

    fn restoreSessionFromDatabaseLocked(
        self: *Daemon,
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

    fn restoreSessionWithArgvJsonLocked(
        self: *Daemon,
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

        self.unlock();
        defer if (agent_snapshot) |*value| value.deinit(self.allocator);
        if (agent_snapshot) |*value| self.recordAgentSessionFromSnapshot(value);
        self.lock();

        restore_committed = true;
        return restored;
    }

    fn ensureSessionPersistence(self: *Daemon, item: *session.TerminalSession) !void {
        if (!self.persistence.enabled) {
            item.disablePersistence(self.allocator);
            return;
        }
        if (item.event_log_path != null and item.excerpt_path != null and item.session_dir != null and item.snapshot_path != null) return;

        var files = try event_log.openPersistentSession(self.allocator, self.config.sessions_dir, item.id);
        errdefer files.deinit(self.allocator);
        try item.installPersistence(self.allocator, files);
    }

    fn applyPersistencePolicyToSessionsLocked(self: *Daemon) void {
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

    fn reloadPersistencePolicyFromSettingsLocked(self: *Daemon) void {
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

    fn resetSessionHistoryLocked(self: *Daemon, item: *session.TerminalSession) !void {
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

    fn ensureSessionProcess(self: *Daemon, item: *session.TerminalSession, argv: []const []const u8) !void {
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

    fn startSessionReaderLocked(self: *Daemon, item: *session.TerminalSession) !void {
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

    fn streamAttachedSession(self: *Daemon, socket_fd: std.c.fd_t, session_id: []const u8, initial_tail: []const u8) !void {
        if (!try self.addSubscriber(session_id, socket_fd)) return;
        defer _ = self.removeSubscriber(session_id, socket_fd);

        var pending: std.ArrayList(u8) = .empty;
        defer pending.deinit(self.allocator);
        try pending.appendSlice(self.allocator, initial_tail);
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
                try pending.appendSlice(self.allocator, buffer[0..@intCast(amount)]);
                try self.applyPendingClientFrames(session_id, &pending);
            }
        }
    }

    fn applyPendingClientFrames(self: *Daemon, session_id: []const u8, pending: *std.ArrayList(u8)) !void {
        if (pending.items.len == 0) return;

        var visitor = ClientFrameVisitor{ .daemon = self, .session_id = session_id };
        const result = try rpc.parseStreamFrames(pending.items, &visitor);
        if (result.valid_bytes > 0) try pending.replaceRange(self.allocator, 0, result.valid_bytes, &.{});
    }

    fn addSubscriber(self: *Daemon, session_id: []const u8, socket_fd: std.c.fd_t) !bool {
        self.lock();
        defer self.unlock();

        const item = self.sessions.find(session_id) orelse return false;
        if (!isLiveAttachable(item)) return false;
        try setNonBlockingFd(socket_fd);
        if (!try self.sessions.addSubscriber(session_id, socket_fd)) return false;
        self.sendCurrentScreenSnapshotToSubscriberLocked(item, socket_fd) catch |err| {
            std.log.warn("failed to send current-screen snapshot for {s}: {t}", .{ item.id, err });
            _ = self.sessions.removeSubscriber(session_id, socket_fd);
            return false;
        };
        self.flushPendingOutputToSubscriberLocked(item, socket_fd) catch |err| {
            std.log.warn("failed to flush pending output for {s}: {t}", .{ item.id, err });
            _ = self.sessions.removeSubscriber(session_id, socket_fd);
            return false;
        };
        return true;
    }

    fn removeSubscriber(self: *Daemon, session_id: []const u8, socket_fd: std.c.fd_t) bool {
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

    fn sessionCanContinueStreaming(self: *Daemon, session_id: []const u8, socket_fd: std.c.fd_t) bool {
        self.lock();
        defer self.unlock();

        const item = self.sessions.find(session_id) orelse return false;
        if (!isLiveAttachable(item)) return false;
        return self.sessions.hasSubscriber(session_id, socket_fd);
    }

    fn runSessionReader(self: *Daemon, session_id: []const u8) !void {
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

    fn liveChildFd(self: *Daemon, session_id: []const u8) ?std.c.fd_t {
        self.lock();
        defer self.unlock();

        const item = self.sessions.find(session_id) orelse return null;
        if (item.status == .killed or item.status == .exited or item.status == .crashed) return null;
        const child = item.pty_child orelse return null;
        if (child.master_fd < 0) return null;
        return child.master_fd;
    }

    fn readPtyAndBroadcast(self: *Daemon, session_id: []const u8) !void {
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

    fn applyClientFrame(self: *Daemon, frame: rpc.StreamFrame) !void {
        self.lock();
        defer self.unlock();

        const item = self.sessions.find(frame.session_id) orelse return;
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

    fn reapExitedChild(self: *Daemon, session_id: []const u8) !bool {
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
        var agent_snapshot = self.agentDetectionSnapshotFromStoredArgvLocked(item, "ended") catch |err| blk: {
            std.log.warn("failed to prepare agent metadata refresh for {s}: {t}", .{ item.id, err });
            break :blk null;
        };
        self.unlock();
        defer if (agent_snapshot) |*value| value.deinit(self.allocator);
        if (agent_snapshot) |*value| self.recordAgentSessionFromSnapshot(value);
        return true;
    }

    fn markExitedAndBroadcast(self: *Daemon, session_id: []const u8, exit_code: i32, signal_value: i32) !bool {
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
        var agent_snapshot = self.agentDetectionSnapshotFromStoredArgvLocked(item, "ended") catch |err| blk: {
            std.log.warn("failed to prepare agent metadata refresh for {s}: {t}", .{ item.id, err });
            break :blk null;
        };
        self.unlock();
        defer if (agent_snapshot) |*value| value.deinit(self.allocator);
        if (agent_snapshot) |*value| self.recordAgentSessionFromSnapshot(value);
        return true;
    }

    fn recordTerminalSessionLocked(self: *Daemon, item: *const session.TerminalSession, argv_json: ?[]const u8) void {
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

    fn recordTerminalEndedLocked(self: *Daemon, item: *const session.TerminalSession, exit_code: i32, signal_value: i32) void {
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

        self.indexSearchExcerptLocked(item);
    }

    fn agentDetectionSnapshotFromStoredArgvLocked(self: *Daemon, item: *const session.TerminalSession, status: []const u8) !?AgentDetectionSnapshot {
        if (!self.persistence.enabled) return null;
        const database = if (self.database) |*database| database else return null;
        var record = (database.findTerminalSessionById(self.allocator, item.id) catch |err| {
            std.log.warn("failed to load terminal argv for agent refresh {s}: {t}", .{ item.id, err });
            return null;
        }) orelse return null;
        defer record.deinit(self.allocator);

        const argv_json = record.argv_json orelse return null;
        var parsed_argv = parseArgvJson(self.allocator, argv_json) catch |err| {
            std.log.warn("failed to parse terminal argv for agent refresh {s}: {t}", .{ item.id, err });
            return null;
        };
        defer parsed_argv.deinit();

        const parsed_items = parsed_argv.items();
        if (parsed_items.len == 0) return null;

        return self.agentDetectionSnapshotFromArgvLocked(item, parsed_items, argv_json, status);
    }

    fn agentDetectionSnapshotFromArgvLocked(
        self: *Daemon,
        item: *const session.TerminalSession,
        argv_items: []const []const u8,
        original_argv_json: ?[]const u8,
        status: []const u8,
    ) !?AgentDetectionSnapshot {
        if (!self.persistence.enabled) return null;
        if (self.database == null) return null;
        if (argv_items.len == 0) return null;

        const argv = try self.allocator.alloc([]const u8, argv_items.len);
        var argv_count: usize = 0;
        var argv_owned_by_result = false;
        errdefer {
            if (!argv_owned_by_result) {
                for (argv[0..argv_count]) |arg| self.allocator.free(arg);
                self.allocator.free(argv);
            }
        }
        for (argv_items, 0..) |arg, index| {
            argv[index] = try self.allocator.dupe(u8, arg);
            argv_count += 1;
        }

        var result: AgentDetectionSnapshot = .{
            .terminal_session_id = try self.allocator.dupe(u8, item.id),
            .session_dir = null,
            .event_log_path = null,
            .excerpt_path = null,
            .cwd = null,
            .argv = argv,
            .original_argv_json = null,
            .status = status,
        };
        argv_owned_by_result = true;
        errdefer result.deinit(self.allocator);

        result.session_dir = if (item.session_dir) |value| try self.allocator.dupe(u8, value) else null;
        result.event_log_path = if (item.event_log_path) |value| try self.allocator.dupe(u8, value) else null;
        result.excerpt_path = if (item.excerpt_path) |value| try self.allocator.dupe(u8, value) else null;
        result.cwd = if (item.cwd) |value| try self.allocator.dupe(u8, value) else null;
        result.original_argv_json = if (original_argv_json) |value| try self.allocator.dupe(u8, value) else null;

        return result;
    }

    fn recordAgentSessionFromSnapshot(self: *Daemon, snapshot_input: *const AgentDetectionSnapshot) void {
        var detected = (adapter.detectSessionAlloc(self.allocator, self.config.adapters_dir, .{
            .terminal_session_id = snapshot_input.terminal_session_id,
            .session_dir = snapshot_input.session_dir,
            .event_log_path = snapshot_input.event_log_path,
            .excerpt_path = snapshot_input.excerpt_path,
            .cwd = snapshot_input.cwd,
            .argv = snapshot_input.argv,
        }) catch |err| blk: {
            std.log.warn("failed to inspect agent adapter metadata for {s}: {t}", .{ snapshot_input.terminal_session_id, err });
            break :blk null;
        }) orelse return;
        defer detected.deinit(self.allocator);

        const provider = detected.provider;
        if (provider == .unknown) return;

        const agent_id = std.fmt.allocPrint(self.allocator, "agent-{s}-{s}", .{ snapshot_input.terminal_session_id, provider.text() }) catch |err| {
            std.log.warn("failed to allocate agent id for {s}: {t}", .{ snapshot_input.terminal_session_id, err });
            return;
        };
        defer self.allocator.free(agent_id);

        self.lock();
        defer self.unlock();
        if (!self.persistence.enabled) return;
        const database = if (self.database) |*database| database else return;
        database.recordAgentSession(.{
            .id = agent_id,
            .terminal_session_id = snapshot_input.terminal_session_id,
            .provider = provider.text(),
            .native_session_id = detected.native_session_id,
            .original_argv_json = snapshot_input.original_argv_json,
            .resume_argv_json = detected.resume_argv_json,
            .cwd = snapshot_input.cwd,
            .transcript_path = snapshot_input.excerpt_path,
            .status = if (detected.native_session_id != null and detected.resume_argv_json != null and isResumableAgentStatus(snapshot_input.status)) "resumable" else snapshot_input.status,
        }) catch |err| {
            std.log.warn("failed to record agent session {s}: {t}", .{ snapshot_input.terminal_session_id, err });
        };
    }

    fn refreshAgentSessionMetadataFromStoredArgvLocked(self: *Daemon, item: *const session.TerminalSession, status: []const u8) void {
        if (!self.persistence.enabled) return;
        const database = if (self.database) |*database| database else return;
        var record = (database.findTerminalSessionById(self.allocator, item.id) catch |err| {
            std.log.warn("failed to load terminal argv for agent refresh {s}: {t}", .{ item.id, err });
            return;
        }) orelse return;
        defer record.deinit(self.allocator);

        const argv_json = record.argv_json orelse return;
        var parsed_argv = parseArgvJson(self.allocator, argv_json) catch |err| {
            std.log.warn("failed to parse terminal argv for agent refresh {s}: {t}", .{ item.id, err });
            return;
        };
        defer parsed_argv.deinit();

        const argv = parsed_argv.items();
        if (argv.len == 0) return;
        self.recordAgentSessionLocked(item, argv, argv_json, status);
    }

    fn recordAgentSessionLocked(
        self: *Daemon,
        item: *const session.TerminalSession,
        argv: []const []const u8,
        original_argv_json: ?[]const u8,
        status: []const u8,
    ) void {
        if (!self.persistence.enabled) return;
        const database = if (self.database) |*database| database else return;
        var detected = (adapter.detectSessionAlloc(self.allocator, self.config.adapters_dir, .{
            .terminal_session_id = item.id,
            .session_dir = item.session_dir,
            .event_log_path = item.event_log_path,
            .excerpt_path = item.excerpt_path,
            .cwd = item.cwd,
            .argv = argv,
        }) catch |err| blk: {
            std.log.warn("failed to inspect agent adapter metadata for {s}: {t}", .{ item.id, err });
            break :blk null;
        }) orelse return;
        defer detected.deinit(self.allocator);

        const provider = detected.provider;
        if (provider == .unknown) return;

        const agent_id = std.fmt.allocPrint(self.allocator, "agent-{s}-{s}", .{ item.id, provider.text() }) catch |err| {
            std.log.warn("failed to allocate agent id for {s}: {t}", .{ item.id, err });
            return;
        };
        defer self.allocator.free(agent_id);

        database.recordAgentSession(.{
            .id = agent_id,
            .terminal_session_id = item.id,
            .provider = provider.text(),
            .native_session_id = detected.native_session_id,
            .original_argv_json = original_argv_json,
            .resume_argv_json = detected.resume_argv_json,
            .cwd = item.cwd,
            .transcript_path = item.excerpt_path,
            .status = if (detected.native_session_id != null and detected.resume_argv_json != null and isResumableAgentStatus(status)) "resumable" else status,
        }) catch |err| {
            std.log.warn("failed to record agent session {s}: {t}", .{ item.id, err });
        };
    }

    fn indexSearchExcerptLocked(self: *Daemon, item: *const session.TerminalSession) void {
        if (!self.persistence.enabled) return;
        const database = if (self.database) |*database| database else return;
        const excerpt_path = item.excerpt_path orelse return;

        const excerpt = readSmallFileAlloc(self.allocator, excerpt_path, event_log.max_excerpt_bytes) catch |err| {
            std.log.warn("failed to read search excerpt for {s}: {t}", .{ item.id, err });
            return;
        };
        defer if (excerpt) |bytes| self.allocator.free(bytes);
        const bytes = excerpt orelse return;
        if (bytes.len == 0) return;

        database.recordTerminalSearch(.{
            .terminal_session_id = item.id,
            .title = item.terminal_id,
            .excerpt = bytes,
        }) catch |err| {
            std.log.warn("failed to index search excerpt for {s}: {t}", .{ item.id, err });
        };
    }

    fn pruneMissingEventLogMetadataLocked(self: *Daemon) void {
        const database = if (self.database) |*database| database else return;
        const refs = database.listTerminalEventLogs(self.allocator) catch |err| {
            std.log.warn("failed to list terminal metadata for pruning: {t}", .{err});
            return;
        };
        defer {
            for (refs) |*item| item.deinit(self.allocator);
            self.allocator.free(refs);
        }

        var missing_ids: std.ArrayList([]const u8) = .empty;
        defer missing_ids.deinit(self.allocator);

        self.unlock();
        for (refs) |ref| {
            if (fileExists(ref.event_log_path)) continue;
            missing_ids.append(self.allocator, ref.id) catch |err| {
                std.log.warn("failed to track missing session metadata {s}: {t}", .{ ref.id, err });
            };
        }
        self.lock();

        const pruning_database = if (self.database) |*value| value else return;
        for (missing_ids.items) |id| {
            pruning_database.deleteTerminalSessionMetadata(id) catch |err| {
                std.log.warn("failed to prune missing session metadata {s}: {t}", .{ id, err });
            };
        }
    }

    fn broadcastExitFrameLocked(self: *Daemon, item: *session.TerminalSession, seq: u64, exit_code: i32, signal_value: i32) !void {
        var payload: [8]u8 = undefined;
        const encoded_payload = try rpc.encodeExitPayload(&payload, exit_code, signal_value);
        try self.broadcastStreamFrameLocked(item, .exit, seq, encoded_payload);
    }

    fn checkpointCurrentScreenLocked(self: *Daemon, item: *session.TerminalSession) void {
        if (!self.persistence.enabled) return;
        const snapshot_path = item.snapshot_path orelse return;
        const payload = item.currentScreenSnapshotAlloc(self.allocator) catch |err| {
            std.log.warn("failed to serialize current-screen snapshot for {s}: {t}", .{ item.id, err });
            return;
        };
        const snapshot_payload = payload orelse return;
        defer self.allocator.free(snapshot_payload);

        const snapshot_seq = item.last_seq;
        const meta = snapshot.writeCurrentScreenPath(self.allocator, snapshot_path, .{
            .seq = snapshot_seq,
            .cols = item.cols,
            .rows = item.rows,
            .backend_name = vt.backend_name,
            .payload = snapshot_payload,
        }) catch |err| {
            std.log.warn("failed to write current-screen snapshot for {s}: {t}", .{ item.id, err });
            return;
        };

        item.snapshot_seq = meta.seq;
        item.snapshot_crc32 = meta.crc32;
        item.snapshot_size = meta.size;

        if (item.event_log_path) |event_log_path| {
            _ = event_log.appendSnapshotMark(self.allocator, event_log_path, &item.last_seq, meta.seq, snapshot_path) catch |err| {
                std.log.warn("failed to append snapshot mark for {s}: {t}", .{ item.id, err });
            };
        }
    }

    fn clearSnapshotFileLocked(self: *Daemon, item: *session.TerminalSession) void {
        _ = self;
        if (item.snapshot_path) |path| {
            snapshot.deleteCurrentScreenPath(path) catch |err| {
                std.log.warn("failed to delete current-screen snapshot for {s}: {t}", .{ item.id, err });
            };
        }
        item.clearSnapshotMetadata();
    }

    fn sendCurrentScreenSnapshotToSubscriberLocked(self: *Daemon, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
        const payload = try item.currentScreenSnapshotAlloc(self.allocator);
        const snapshot_payload = payload orelse return;
        defer self.allocator.free(snapshot_payload);

        const encoded_snapshot = try snapshot.encodeAlloc(self.allocator, .{
            .seq = item.last_seq,
            .cols = item.cols,
            .rows = item.rows,
            .backend_name = vt.backend_name,
            .payload = snapshot_payload,
        });
        defer self.allocator.free(encoded_snapshot);

        const encoded_len = rpc.encodedStreamFrameSize(encoded_snapshot.len);
        const buffer = try self.allocator.alloc(u8, encoded_len);
        defer self.allocator.free(buffer);

        const encoded = try rpc.encodeStreamFrame(buffer, .snapshot, item.id, item.last_seq, encoded_snapshot);
        try writeAllFdNonBlocking(socket_fd, encoded);
    }

    fn broadcastStreamFrameLocked(
        self: *Daemon,
        item: *session.TerminalSession,
        kind: rpc.StreamKind,
        seq: u64,
        payload: []const u8,
    ) !void {
        if (item.subscribers.items.len == 0) {
            if (kind == .output) item.bufferPendingOutput(self.allocator, seq, payload) catch |err| {
                std.log.warn("failed to buffer pending output for {s}: {t}", .{ item.id, err });
            };
            return;
        }

        const encoded_len = rpc.encodedStreamFrameSize(payload.len);
        const buffer = try self.allocator.alloc(u8, encoded_len);
        defer self.allocator.free(buffer);
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
    }

    fn flushPendingOutputToSubscriberLocked(self: *Daemon, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
        if (item.pending_output.items.len == 0) return;

        for (item.pending_output.items) |frame| {
            const encoded_len = rpc.encodedStreamFrameSize(frame.payload.len);
            const buffer = try self.allocator.alloc(u8, encoded_len);
            defer self.allocator.free(buffer);
            const encoded = try rpc.encodeStreamFrame(buffer, .output, item.id, frame.seq, frame.payload);
            try writeAllFdNonBlocking(socket_fd, encoded);
        }

        item.clearPendingOutput(self.allocator);
    }

    fn lock(self: *Daemon) void {
        self.mutex.lock();
    }

    fn unlock(self: *Daemon) void {
        self.mutex.unlock();
    }

    fn writePidFile(self: *Daemon) !void {
        var buffer: [64]u8 = undefined;
        const pid_text = try std.fmt.bufPrint(&buffer, "{d}\n", .{std.c.getpid()});
        try std.fs.cwd().writeFile(.{ .sub_path = self.config.pid_path, .data = pid_text });
    }
};

const ConnectionContext = struct {
    daemon: *Daemon,
    stream: std.net.Stream,
};

const ControlPayload = struct {
    payload: []u8,
    tail: []u8,

    fn deinit(self: *ControlPayload, allocator: std.mem.Allocator) void {
        allocator.free(self.payload);
        allocator.free(self.tail);
        self.* = undefined;
    }
};

const ClientFrameVisitor = struct {
    daemon: *Daemon,
    session_id: []const u8,

    pub fn visit(self: *ClientFrameVisitor, frame: rpc.StreamFrame) !void {
        if (!std.mem.eql(u8, frame.session_id, self.session_id)) return;
        try self.daemon.applyClientFrame(frame);
    }
};

fn handleConnectionThread(context: *ConnectionContext) void {
    defer context.daemon.allocator.destroy(context);
    context.daemon.handleStream(context.stream) catch |err| {
        std.log.warn("control RPC connection failed: {t}", .{err});
    };
}

fn sessionReaderThread(daemon: *Daemon, session_id: []const u8) void {
    daemon.runSessionReader(session_id) catch |err| {
        std.log.warn("session reader failed for {s}: {t}", .{ session_id, err });
        _ = daemon.markExitedAndBroadcast(session_id, -1, 0) catch {};
    };
}

fn isLiveAttachable(item: *const session.TerminalSession) bool {
    return switch (item.status) {
        .live, .detached => blk: {
            const child = item.pty_child orelse break :blk false;
            break :blk child.master_fd >= 0;
        },
        .exited, .crashed, .archived, .killed => false,
    };
}

fn isResumableAgentStatus(status: []const u8) bool {
    return std.mem.eql(u8, status, "running") or
        std.mem.eql(u8, status, "detected") or
        std.mem.eql(u8, status, "ended");
}

fn adapterDirFromEnvOrDefault(allocator: std.mem.Allocator, root_dir: []const u8) ![]u8 {
    const env_value = std.process.getEnvVarOwned(allocator, "TAOD_ADAPTER_DIR") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
    if (env_value) |value| {
        if (value.len > 0) return value;
        allocator.free(value);
    }
    return try std.fs.path.join(allocator, &.{ root_dir, "adapters" });
}

fn sessionResponse(
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    item: *const session.TerminalSession,
    metadata: SessionResponseMetadata,
) ![]u8 {
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = true,
        .session_id = item.id,
        .pid = item.pidU32(),
        .status = item.status.text(),
        .cwd = item.cwd,
        .cols = item.cols,
        .rows = item.rows,
        .last_seq = item.last_seq,
        .attach_kind = metadata.attach_kind.text(),
        .agent_provider = metadata.agent_provider,
        .native_session_id = metadata.native_session_id,
    });
}

fn missingField(
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    field: []const u8,
) ![]u8 {
    var buffer: [64]u8 = undefined;
    const message = try std.fmt.bufPrint(&buffer, "missing field: {s}", .{field});
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = false,
        .error_message = message,
    });
}

fn notFound(allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = false,
        .error_code = "session_not_found",
        .error_message = "session not found",
    });
}

const ParsedArgv = struct {
    parsed: ?std.json.Parsed([][]const u8) = null,

    fn deinit(self: *ParsedArgv) void {
        if (self.parsed) |*parsed| parsed.deinit();
        self.* = undefined;
    }

    fn items(self: *const ParsedArgv) []const []const u8 {
        if (self.parsed) |parsed| return parsed.value;
        return &.{};
    }
};

fn parseArgvJson(allocator: std.mem.Allocator, json: []const u8) !ParsedArgv {
    if (json.len == 0) return .{};
    const parsed = try std.json.parseFromSlice([][]const u8, allocator, json, .{});
    return .{ .parsed = parsed };
}

fn argvJsonAlloc(allocator: std.mem.Allocator, argv: []const []const u8) !?[]u8 {
    if (argv.len == 0) return null;

    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    try out.writer.writeByte('[');
    for (argv, 0..) |arg, index| {
        if (index > 0) try out.writer.writeByte(',');
        try out.writer.print("{f}", .{std.json.fmt(arg, .{})});
    }
    try out.writer.writeByte(']');

    return try out.toOwnedSlice();
}

fn readSmallFileAlloc(allocator: std.mem.Allocator, path: []const u8, limit: usize) !?[]u8 {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY, .CLOEXEC = true });
    if (fd < 0) {
        return switch (std.posix.errno(fd)) {
            .NOENT => null,
            else => error.FileOpenFailed,
        };
    }
    defer _ = std.c.close(fd);

    var stat: std.c.Stat = undefined;
    if (std.c.fstat(fd, &stat) != 0) return error.FileStatFailed;
    if (stat.size < 0) return error.FileTooBig;
    const size: usize = @intCast(stat.size);
    if (size > limit) return error.FileTooBig;

    const data = try allocator.alloc(u8, size);
    errdefer allocator.free(data);

    var offset: usize = 0;
    while (offset < data.len) {
        const amount = std.c.read(fd, data[offset..].ptr, data.len - offset);
        if (amount < 0) {
            switch (std.posix.errno(amount)) {
                .INTR => continue,
                else => return error.FileReadFailed,
            }
        }
        if (amount == 0) break;
        offset += @intCast(amount);
    }

    return data[0..offset];
}

fn fileExists(path: []const u8) bool {
    const allocator = std.heap.smp_allocator;
    const path_z = allocator.dupeZ(u8, path) catch return false;
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY, .CLOEXEC = true });
    if (fd < 0) return false;
    _ = std.c.close(fd);
    return true;
}

fn writeAllFd(fd: std.posix.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const written = std.c.write(fd, data[offset..].ptr, data.len - offset);
        if (written < 0) {
            switch (std.posix.errno(written)) {
                .INTR => continue,
                else => return error.SocketWriteFailed,
            }
        }
        if (written == 0) return error.SocketWriteFailed;
        offset += @intCast(written);
    }
}

fn writeAllFdNonBlocking(fd: std.posix.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const written = std.c.write(fd, data[offset..].ptr, data.len - offset);
        if (written < 0) {
            switch (std.posix.errno(written)) {
                .INTR => continue,
                .AGAIN => return error.SlowClientBackpressure,
                else => return error.SocketWriteFailed,
            }
        }
        if (written == 0) return error.SocketWriteFailed;
        offset += @intCast(written);
    }
}

fn setNonBlockingFd(fd: std.posix.fd_t) !void {
    var flags = try std.posix.fcntl(fd, std.posix.F.GETFL, 0);
    flags |= 1 << @bitOffsetOf(std.posix.O, "NONBLOCK");
    _ = try std.posix.fcntl(fd, std.posix.F.SETFL, flags);
}

fn readControlPayload(allocator: std.mem.Allocator, fd: std.c.fd_t) !ControlPayload {
    var payload: std.ArrayList(u8) = .empty;
    errdefer payload.deinit(allocator);

    var tail: std.ArrayList(u8) = .empty;
    errdefer tail.deinit(allocator);

    while (true) {
        var buffer: [4096]u8 = undefined;
        const amount = std.c.read(fd, &buffer, buffer.len);
        if (amount < 0) {
            switch (std.posix.errno(amount)) {
                .INTR => continue,
                else => return error.SocketReadFailed,
            }
        }
        if (amount == 0) break;

        const bytes = buffer[0..@intCast(amount)];
        if (std.mem.indexOfScalar(u8, bytes, '\n')) |newline_index| {
            if (payload.items.len + newline_index > control_payload_max) return error.ControlPayloadTooLarge;
            try payload.appendSlice(allocator, bytes[0..newline_index]);
            if (newline_index + 1 < bytes.len) try tail.appendSlice(allocator, bytes[newline_index + 1 ..]);
            return .{
                .payload = try payload.toOwnedSlice(allocator),
                .tail = try tail.toOwnedSlice(allocator),
            };
        }

        if (payload.items.len + bytes.len > control_payload_max) return error.ControlPayloadTooLarge;
        try payload.appendSlice(allocator, bytes);
    }

    if (payload.items.len == 0) return error.EmptyControlPayload;
    return .{
        .payload = try payload.toOwnedSlice(allocator),
        .tail = try tail.toOwnedSlice(allocator),
    };
}

var session_id_counter = std.atomic.Value(u64).init(0);

fn generateSessionId(allocator: std.mem.Allocator) ![]u8 {
    var tv: std.c.timeval = .{ .sec = 0, .usec = 0 };
    _ = std.c.gettimeofday(&tv, null);
    const counter = session_id_counter.fetchAdd(1, .monotonic) + 1;
    return std.fmt.allocPrint(allocator, "{x:0>8}-{x:0>4}-{x:0>4}-{x:0>4}-{x:0>12}", .{
        @as(u32, @truncate(@as(u64, @intCast(tv.sec)))),
        @as(u16, @truncate(@as(u64, @intCast(tv.usec)))),
        @as(u16, @truncate(@as(u32, @intCast(std.c.getpid())))),
        @as(u16, @truncate(counter)),
        @as(u48, @truncate(counter)),
    });
}

test "config derives tao paths from home" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("/tmp/example-home/.tao", config.root_dir);
    try std.testing.expectEqualStrings("/tmp/example-home/.tao/adapters", config.adapters_dir);
    try std.testing.expectEqualStrings("/tmp/example-home/.tao/run/taod.sock", config.socket_path);
}

test "daemon control RPC creates and updates sessions" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"s1","terminal_id":"t1","cols":80,"rows":24}
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
        \\{"id":"2b","method":"create","session_id":"s1","terminal_id":"t1b","cols":90,"rows":25,"cwd":"/tmp"}
    );
    defer std.testing.allocator.free(recreated);

    try std.testing.expectEqualStrings("t1b", daemon.sessions.find("s1").?.terminal_id);
    try std.testing.expectEqualStrings("/tmp", daemon.sessions.find("s1").?.cwd.?);
    try std.testing.expectEqual(@as(u16, 90), daemon.sessions.find("s1").?.cols);

    const protocol_created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"3","type":"create","sessionId":"s2","terminalId":"t2","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(protocol_created);

    try std.testing.expect(daemon.sessions.find("s2") != null);
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
    try std.testing.expect(std.mem.indexOf(u8, response, "session not found") != null);
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
        \\{"id":"1","method":"create","session_id":"private-session","terminal_id":"private-terminal","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    const item = daemon.sessions.find("private-session").?;
    try std.testing.expect(item.event_log_path == null);
    try std.testing.expect(item.excerpt_path == null);
    try std.testing.expect((try event_log.openExistingSession(std.testing.allocator, daemon.config.sessions_dir, "private-session")) == null);
}

test "daemon control payload reader preserves attach tails and rejects oversize lines" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(.{ .sub_path = "with-tail", .data = "{\"type\":\"attach\"}\nstream-tail" });
    var with_tail = try tmp.dir.openFile("with-tail", .{});
    defer with_tail.close();

    var control = try readControlPayload(std.testing.allocator, with_tail.handle);
    defer control.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("{\"type\":\"attach\"}", control.payload);
    try std.testing.expectEqualStrings("stream-tail", control.tail);

    const oversized = try std.testing.allocator.alloc(u8, control_payload_max + 1);
    defer std.testing.allocator.free(oversized);
    @memset(oversized, 'x');
    try tmp.dir.writeFile(.{ .sub_path = "oversized", .data = oversized });
    var oversized_file = try tmp.dir.openFile("oversized", .{});
    defer oversized_file.close();

    try std.testing.expectError(error.ControlPayloadTooLarge, readControlPayload(std.testing.allocator, oversized_file.handle));
}

test "daemon drops failed stream subscribers without blocking pending output" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"stream-session","terminal_id":"stream-terminal","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    const item = daemon.sessions.find("stream-session").?;
    try item.subscribers.append(std.testing.allocator, -1);

    try daemon.broadcastStreamFrameLocked(item, .output, 1, "live output");
    try std.testing.expectEqual(@as(usize, 0), item.subscribers.items.len);
    try std.testing.expectEqual(@as(usize, 0), item.pending_output.items.len);

    try daemon.broadcastStreamFrameLocked(item, .output, 2, "detached output");
    try std.testing.expectEqual(@as(usize, 1), item.pending_output.items.len);
    try std.testing.expectEqualStrings("detached output", item.pending_output.items[0].payload);
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
        try database.recordTerminalSession(.{
            .id = "resume-session",
            .terminal_id = "resume-terminal",
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
    try std.testing.expect(daemon.sessions.find("resume-session") != null);

    const killed = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"kill","type":"kill","sessionId":"resume-session"}
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
        \\{"id":"1","method":"create","session_id":"snapshot-session","terminal_id":"snapshot-terminal","cols":24,"rows":4}
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
