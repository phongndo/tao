const std = @import("std");

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

test "config derives tao paths from home" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("/tmp/example-home/.tao", config.root_dir);
    try std.testing.expectEqualStrings("/tmp/example-home/.tao/adapters", config.adapters_dir);
    try std.testing.expectEqualStrings("/tmp/example-home/.tao/run/taod.sock", config.socket_path);
}

fn configFromHomeForAllocationFailure(allocator: std.mem.Allocator) !void {
    var config = try Config.fromHome(allocator, "/tmp/tao-oom-home");
    defer config.deinit(allocator);
}

test "config fromHome cleans up every partial allocation on OOM" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        configFromHomeForAllocationFailure,
        .{},
    );
}
