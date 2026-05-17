const std = @import("std");
const cleanup = @import("../cleanup.zig");
const db = @import("../db.zig");
const rpc = @import("../rpc.zig");

const fd_io = @import("fd_io.zig");

const readControlPayload = fd_io.readControlPayload;
const writeAllFd = fd_io.writeAllFd;

fn handleConnectionThread(context: anytype) void {
    defer context.daemon.allocator.destroy(context);
    context.daemon.handleStream(context.stream) catch |err| {
        std.log.warn("control RPC connection failed: {s}", .{@errorName(err)});
    };
}

pub fn prepareStorage(self: anytype) !void {
    try std.fs.cwd().makePath(self.config.run_dir);
    try std.fs.cwd().makePath(self.config.sessions_dir);
    try std.fs.cwd().makePath(self.config.adapters_dir);
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
    std.fs.cwd().deleteFile(self.config.socket_path) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };

    const address = try std.net.Address.initUnix(self.config.socket_path);
    var server = try address.listen(.{});
    defer server.deinit();

    std.log.info("taod listening on {s}", .{self.config.socket_path});
    std.log.info("control RPC, PTY driver, event log, and binary attach stream enabled", .{});

    const ConnectionContext = struct {
        daemon: @TypeOf(self),
        stream: std.net.Stream,
    };

    while (true) {
        const connection = try server.accept();
        const stream = connection.stream;
        const context = self.allocator.create(ConnectionContext) catch |err| {
            stream.close();
            return err;
        };
        context.* = .{ .daemon = self, .stream = stream };

        const thread = std.Thread.spawn(.{}, handleConnectionThread, .{context}) catch |err| {
            std.log.warn("failed to spawn control RPC thread: {s}; handling inline", .{@errorName(err)});
            self.handleStream(stream) catch |stream_err| {
                std.log.warn("control RPC connection failed: {s}", .{@errorName(stream_err)});
            };
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

    return self.handleControlRequest(allocator, parsed.value);
}

pub fn handleControlRequest(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
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

pub fn handleStream(self: anytype, stream: std.net.Stream) !void {
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

pub fn writePidFile(self: anytype) !void {
    var buffer: [64]u8 = undefined;
    const pid_text = try std.fmt.bufPrint(&buffer, "{d}\n", .{std.c.getpid()});
    try std.fs.cwd().writeFile(.{ .sub_path = self.config.pid_path, .data = pid_text });
}
