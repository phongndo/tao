const std = @import("std");
const db = @import("db.zig");
const event_log = @import("event_log.zig");
const pty = @import("pty.zig");
const rpc = @import("rpc.zig");
const session = @import("session.zig");

const control_payload_max = 64 * 1024;

pub const Config = struct {
    root_dir: []const u8,
    database_path: []const u8,
    run_dir: []const u8,
    sessions_dir: []const u8,
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
        const socket_path = try std.fs.path.join(allocator, &.{ run_dir, "taod.sock" });
        errdefer allocator.free(socket_path);
        const pid_path = try std.fs.path.join(allocator, &.{ run_dir, "taod.pid" });

        return .{
            .root_dir = root_dir,
            .database_path = database_path,
            .run_dir = run_dir,
            .sessions_dir = sessions_dir,
            .socket_path = socket_path,
            .pid_path = pid_path,
        };
    }

    pub fn deinit(self: *Config, allocator: std.mem.Allocator) void {
        allocator.free(self.root_dir);
        allocator.free(self.database_path);
        allocator.free(self.run_dir);
        allocator.free(self.sessions_dir);
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
    mutex: std.atomic.Mutex = .unlocked,

    pub fn init(allocator: std.mem.Allocator, config: Config) Daemon {
        return .{
            .allocator = allocator,
            .config = config,
            .sessions = session.Manager.init(allocator),
            .pty_driver = pty.Driver.init(allocator),
            .database = null,
        };
    }

    pub fn deinit(self: *Daemon) void {
        if (self.database) |*database| database.deinit();
        self.sessions.deinit();
    }

    pub fn prepareStorage(self: *Daemon, io: std.Io) !void {
        try std.Io.Dir.cwd().createDirPath(io, self.config.run_dir);
        try std.Io.Dir.cwd().createDirPath(io, self.config.sessions_dir);
        if (self.database == null) self.database = try db.Database.open(self.allocator, self.config.database_path);
        try self.writePidFile(io);
    }

    pub fn printConfig(self: *Daemon) void {
        std.debug.print(
            "root={s}\ndatabase={s}\nrun={s}\nsessions={s}\nsocket={s}\npid={s}\n",
            .{
                self.config.root_dir,
                self.config.database_path,
                self.config.run_dir,
                self.config.sessions_dir,
                self.config.socket_path,
                self.config.pid_path,
            },
        );
    }

    pub fn runForever(self: *Daemon, io: std.Io) !void {
        std.Io.Dir.cwd().deleteFile(io, self.config.socket_path) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };

        var address = try std.Io.net.UnixAddress.init(self.config.socket_path);
        var server = try address.listen(io, .{});
        defer server.deinit(io);

        std.log.info("taod listening on {s}", .{self.config.socket_path});
        std.log.info("control RPC, PTY driver, event log, and binary attach stream enabled", .{});

        while (true) {
            var stream = try server.accept(io);
            const context = self.allocator.create(ConnectionContext) catch |err| {
                stream.close(io);
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

    fn handleStream(self: *Daemon, stream: std.Io.net.Stream) !void {
        defer _ = std.c.close(stream.socket.handle);

        var control = try readControlPayload(self.allocator, stream.socket.handle);
        defer control.deinit(self.allocator);

        var parsed = std.json.parseFromSlice(rpc.ControlRequestJson, self.allocator, control.payload, .{
            .ignore_unknown_fields = true,
        }) catch |err| {
            const response = try rpc.responseJsonAlloc(self.allocator, .{
                .ok = false,
                .error_message = @errorName(err),
            });
            defer self.allocator.free(response);
            try writeAllFd(stream.socket.handle, response);
            return;
        };
        defer parsed.deinit();

        const request = parsed.value;
        const response = try self.handleControlRequest(self.allocator, request);
        defer self.allocator.free(response);
        try writeAllFd(stream.socket.handle, response);

        if (request.requestType() == .attach) {
            if (request.requestSessionId()) |session_id| {
                try self.streamAttachedSession(stream.socket.handle, session_id, control.tail);
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
            existing.cols = cols;
            existing.rows = rows;
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
        try self.startSessionReaderLocked(created);

        return sessionResponse(allocator, request, created);
    }

    fn handleAttachLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
        const attached = self.sessions.attach(session_id) orelse return notFound(allocator, request);
        if (!isLiveAttachable(attached)) {
            return rpc.responseJsonAlloc(allocator, .{
                .id = request.requestId(),
                .ok = false,
                .error_message = "session is not live",
            });
        }
        self.recordTerminalSessionLocked(attached, null);
        return sessionResponse(allocator, request, attached);
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

        return sessionResponse(allocator, request, self.sessions.find(session_id).?);
    }

    fn handleDetachLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
        if (!self.sessions.detach(session_id)) return notFound(allocator, request);
        self.recordTerminalSessionLocked(self.sessions.find(session_id).?, null);

        return sessionResponse(allocator, request, self.sessions.find(session_id).?);
    }

    fn handleKillLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
        const item = self.sessions.find(session_id) orelse return notFound(allocator, request);
        if (item.pty_child) |*child| self.pty_driver.terminate(child) catch |err| {
            std.log.warn("failed to terminate PTY for {s}: {t}", .{ item.id, err });
        };
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

        return sessionResponse(allocator, request, self.sessions.find(session_id).?);
    }

    fn ensureSessionPersistence(self: *Daemon, item: *session.TerminalSession) !void {
        if (item.event_log_path != null and item.excerpt_path != null and item.session_dir != null) return;

        const files = try event_log.openPersistentSession(self.allocator, self.config.sessions_dir, item.id);
        item.installPersistence(self.allocator, files);
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
            if (!self.sessionCanContinueStreaming(session_id)) return;

            var poll_fds = [_]std.posix.pollfd{.{ .fd = socket_fd, .events = std.posix.POLL.IN, .revents = 0 }};

            _ = try std.posix.poll(&poll_fds, 250);

            if ((poll_fds[0].revents & (std.posix.POLL.IN | std.posix.POLL.HUP | std.posix.POLL.ERR)) != 0) {
                if ((poll_fds[0].revents & (std.posix.POLL.HUP | std.posix.POLL.ERR)) != 0) return;
                var buffer: [64 * 1024]u8 = undefined;
                const amount = std.c.read(socket_fd, &buffer, buffer.len);
                if (amount <= 0) return;
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
        if (!try self.sessions.addSubscriber(session_id, socket_fd)) return false;
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
            if (self.sessions.find(session_id)) |item| self.recordTerminalSessionLocked(item, null);
        }
        return removed;
    }

    fn sessionCanContinueStreaming(self: *Daemon, session_id: []const u8) bool {
        self.lock();
        defer self.unlock();

        const item = self.sessions.find(session_id) orelse return false;
        return isLiveAttachable(item);
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
            .input => try self.pty_driver.writeAll(child, frame.payload),
            .resize => {
                const resize = try rpc.decodeResizePayload(frame.payload);
                try self.pty_driver.resize(child, resize.cols, resize.rows);
                item.cols = resize.cols;
                item.rows = resize.rows;
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
        defer self.unlock();

        const item = self.sessions.find(session_id) orelse return true;
        const child = if (item.pty_child) |*child| child else return false;
        const status = try self.pty_driver.tryWait(child) orelse return false;
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
        return true;
    }

    fn markExitedAndBroadcast(self: *Daemon, session_id: []const u8, exit_code: i32, signal_value: i32) !bool {
        self.lock();
        defer self.unlock();

        const item = self.sessions.find(session_id) orelse return true;
        if (item.status == .killed) return true;
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
        return true;
    }

    fn recordTerminalSessionLocked(self: *Daemon, item: *const session.TerminalSession, argv_json: ?[]const u8) void {
        const database = if (self.database) |*database| database else return;
        const event_log_path = item.event_log_path orelse return;
        const pid: ?i64 = if (item.pidU32()) |value| @intCast(value) else null;

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
        }) catch |err| {
            std.log.warn("failed to record terminal session {s}: {t}", .{ item.id, err });
        };
    }

    fn recordTerminalEndedLocked(self: *Daemon, item: *const session.TerminalSession, exit_code: i32, signal_value: i32) void {
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

    fn broadcastExitFrameLocked(self: *Daemon, item: *session.TerminalSession, seq: u64, exit_code: i32, signal_value: i32) !void {
        var payload: [8]u8 = undefined;
        const encoded_payload = try rpc.encodeExitPayload(&payload, exit_code, signal_value);
        try self.broadcastStreamFrameLocked(item, .exit, seq, encoded_payload);
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
            writeAllFd(fd, encoded) catch |err| {
                std.log.warn("dropping taod subscriber for {s}: {t}", .{ item.id, err });
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
            try writeAllFd(socket_fd, encoded);
        }

        item.clearPendingOutput(self.allocator);
    }

    fn lock(self: *Daemon) void {
        while (!self.mutex.tryLock()) {
            std.Thread.yield() catch {};
        }
    }

    fn unlock(self: *Daemon) void {
        self.mutex.unlock();
    }

    fn writePidFile(self: *Daemon, io: std.Io) !void {
        var buffer: [64]u8 = undefined;
        const pid_text = try std.fmt.bufPrint(&buffer, "{d}\n", .{std.c.getpid()});
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = self.config.pid_path, .data = pid_text });
    }
};

const ConnectionContext = struct {
    daemon: *Daemon,
    stream: std.Io.net.Stream,
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

fn sessionResponse(
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    item: *const session.TerminalSession,
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
        .error_message = "session not found",
    });
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

fn writeAllFd(fd: std.posix.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const written = std.c.write(fd, data[offset..].ptr, data.len - offset);
        if (written <= 0) return error.SocketWriteFailed;
        offset += @intCast(written);
    }
}

fn readControlPayload(allocator: std.mem.Allocator, fd: std.c.fd_t) !ControlPayload {
    var payload: std.ArrayList(u8) = .empty;
    errdefer payload.deinit(allocator);

    var tail: std.ArrayList(u8) = .empty;
    errdefer tail.deinit(allocator);

    while (payload.items.len < control_payload_max) {
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
            try payload.appendSlice(allocator, bytes[0..newline_index]);
            if (newline_index + 1 < bytes.len) try tail.appendSlice(allocator, bytes[newline_index + 1 ..]);
            return .{
                .payload = try payload.toOwnedSlice(allocator),
                .tail = try tail.toOwnedSlice(allocator),
            };
        }

        try payload.appendSlice(allocator, bytes);
    }

    if (payload.items.len == 0) return error.EmptyControlPayload;
    return .{
        .payload = try payload.toOwnedSlice(allocator),
        .tail = try tail.toOwnedSlice(allocator),
    };
}

fn generateSessionId(allocator: std.mem.Allocator) ![]u8 {
    var tv: std.c.timeval = .{ .sec = 0, .usec = 0 };
    _ = std.c.gettimeofday(&tv, null);
    return std.fmt.allocPrint(allocator, "{x:0>8}-{x:0>4}-{x:0>4}-{x:0>4}-{x:0>12}", .{
        @as(u32, @truncate(@as(u64, @intCast(tv.sec)))),
        @as(u16, @truncate(@as(u64, @intCast(tv.usec)))),
        @as(u16, @truncate(@as(u32, @intCast(std.c.getpid())))),
        @as(u16, @truncate(@as(usize, @intFromPtr(&tv)))),
        @as(u48, @truncate(@as(u64, @intCast(tv.sec)) * 1000000 + @as(u64, @intCast(tv.usec)))),
    });
}

test "config derives tao paths from home" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("/tmp/example-home/.tao", config.root_dir);
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
