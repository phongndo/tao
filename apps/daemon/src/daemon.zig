const std = @import("std");
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
        std.log.info("taod skeleton prepared; socket path: {s}", .{self.config.socket_path});
        std.log.info("socket accept loop and PTY driver are scaffolded but not enabled yet", .{});

        while (true) {
            try std.Io.sleep(io, .fromSeconds(60), .awake);
        }
    }

    fn writePidFile(self: *Daemon, io: std.Io) !void {
        var buffer: [64]u8 = undefined;
        const pid_text = try std.fmt.bufPrint(&buffer, "{d}\n", .{std.c.getpid()});
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = self.config.pid_path, .data = pid_text });
    }
};

test "config derives tao paths from home" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("/tmp/example-home/.tao", config.root_dir);
    try std.testing.expectEqualStrings("/tmp/example-home/.tao/run/taod.sock", config.socket_path);
}
