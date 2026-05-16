const std = @import("std");
const rpc = @import("rpc.zig");
const session = @import("session.zig");

pub const Config = struct {
    root_dir: []const u8,
    run_dir: []const u8,
    sessions_dir: []const u8,
    socket_path: []const u8,
    pid_path: []const u8,

    pub fn fromHome(allocator: std.mem.Allocator, home: []const u8) !Config {
        const root_dir = try std.fs.path.join(allocator, &.{ home, ".tao" });
        errdefer allocator.free(root_dir);
        const run_dir = try std.fs.path.join(allocator, &.{ root_dir, "run" });
        errdefer allocator.free(run_dir);
        const sessions_dir = try std.fs.path.join(allocator, &.{ root_dir, "sessions" });
        errdefer allocator.free(sessions_dir);
        const socket_path = try std.fs.path.join(allocator, &.{ run_dir, "taod.sock" });
        errdefer allocator.free(socket_path);
        const pid_path = try std.fs.path.join(allocator, &.{ run_dir, "taod.pid" });

        return .{
            .root_dir = root_dir,
            .run_dir = run_dir,
            .sessions_dir = sessions_dir,
            .socket_path = socket_path,
            .pid_path = pid_path,
        };
    }

    pub fn deinit(self: *Config, allocator: std.mem.Allocator) void {
        allocator.free(self.root_dir);
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

    pub fn init(allocator: std.mem.Allocator, config: Config) Daemon {
        return .{
            .allocator = allocator,
            .config = config,
            .sessions = session.Manager.init(allocator),
        };
    }

    pub fn deinit(self: *Daemon) void {
        self.sessions.deinit();
    }

    pub fn prepareStorage(self: *Daemon, io: std.Io) !void {
        try std.Io.Dir.cwd().createDirPath(io, self.config.run_dir);
        try std.Io.Dir.cwd().createDirPath(io, self.config.sessions_dir);
        try self.writePidFile(io);
    }

    pub fn printConfig(self: *Daemon) void {
        std.debug.print(
            "root={s}\nrun={s}\nsessions={s}\nsocket={s}\npid={s}\n",
            .{
                self.config.root_dir,
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
        std.log.info("control RPC/session registry enabled; PTY streaming remains scaffolded", .{});

        while (true) {
            {
                var stream = try server.accept(io);
                defer stream.close(io);
                self.handleStream(stream) catch |err| {
                    std.log.warn("control RPC connection failed: {t}", .{err});
                };
            }
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

        const request = parsed.value;
        return switch (request.requestType()) {
            .create => self.handleCreate(allocator, request),
            .attach => self.handleAttach(allocator, request),
            .resize => self.handleResize(allocator, request),
            .detach => self.handleDetach(allocator, request),
            .kill => self.handleKill(allocator, request),
            .unknown => rpc.responseJsonAlloc(allocator, .{
                .id = request.requestId(),
                .ok = false,
                .error_message = "unknown method",
            }),
        };
    }

    fn handleStream(self: *Daemon, stream: std.Io.net.Stream) !void {
        var read_buffer: [64 * 1024]u8 = undefined;
        const read_len = try std.posix.read(stream.socket.handle, &read_buffer);
        const payload = read_buffer[0..read_len];

        const response = try self.handleControlPayload(self.allocator, payload);
        defer self.allocator.free(response);
        try writeAllFd(stream.socket.handle, response);
    }

    fn handleCreate(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.session_id orelse return missingField(allocator, request, "session_id");
        const terminal_id = request.terminal_id orelse return missingField(allocator, request, "terminal_id");
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

        return sessionResponse(allocator, request, created);
    }

    fn handleAttach(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.session_id orelse return missingField(allocator, request, "session_id");
        const attached = self.sessions.attach(session_id) orelse return notFound(allocator, request);
        return sessionResponse(allocator, request, attached);
    }

    fn handleResize(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.session_id orelse return missingField(allocator, request, "session_id");
        const cols = request.cols orelse return missingField(allocator, request, "cols");
        const rows = request.rows orelse return missingField(allocator, request, "rows");
        if (!self.sessions.resize(session_id, cols, rows)) return notFound(allocator, request);

        return sessionResponse(allocator, request, self.sessions.find(session_id).?);
    }

    fn handleDetach(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.session_id orelse return missingField(allocator, request, "session_id");
        if (!self.sessions.detach(session_id)) return notFound(allocator, request);

        return sessionResponse(allocator, request, self.sessions.find(session_id).?);
    }

    fn handleKill(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        const session_id = request.session_id orelse return missingField(allocator, request, "session_id");
        if (!self.sessions.kill(session_id)) return notFound(allocator, request);

        return sessionResponse(allocator, request, self.sessions.find(session_id).?);
    }

    fn writePidFile(self: *Daemon, io: std.Io) !void {
        var buffer: [64]u8 = undefined;
        const pid_text = try std.fmt.bufPrint(&buffer, "{d}\n", .{std.c.getpid()});
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = self.config.pid_path, .data = pid_text });
    }
};

fn sessionResponse(
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    item: *const session.TerminalSession,
) ![]u8 {
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = true,
        .session_id = item.id,
        .status = item.status.text(),
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

fn writeAllFd(fd: std.posix.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const written = std.c.write(fd, data[offset..].ptr, data.len - offset);
        if (written <= 0) return error.SocketWriteFailed;
        offset += @intCast(written);
    }
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
