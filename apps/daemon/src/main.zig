const std = @import("std");
const taod = @import("taod");

pub fn main() !void {
    if (debugAllocatorEnabled()) {
        var debug_allocator: std.heap.DebugAllocator(.{}) = .{
            .backing_allocator = std.heap.smp_allocator,
        };
        const allocator = debug_allocator.allocator();

        realMain(allocator) catch |err| {
            if (debug_allocator.deinit() == .leak) std.process.exit(1);
            return err;
        };
        if (debug_allocator.deinit() == .leak) std.process.exit(1);
        return;
    }

    try realMain(std.heap.smp_allocator);
}

fn realMain(allocator: std.mem.Allocator) !void {
    const home = try std.process.getEnvVarOwned(allocator, "HOME");
    defer allocator.free(home);

    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();
    _ = args.skip();

    var print_config = false;
    var check = false;
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--print-config")) print_config = true;
        if (std.mem.eql(u8, arg, "--check")) check = true;
    }

    var config = try taod.daemon.Config.fromHome(allocator, home);
    defer config.deinit(allocator);

    var daemon = taod.daemon.Daemon.init(allocator, config);
    defer daemon.deinit();

    if (print_config) {
        daemon.printConfig();
        return;
    }

    try daemon.prepareStorage();

    if (check) return;

    try daemon.runForever();
}

fn debugAllocatorEnabled() bool {
    const allocator = std.heap.smp_allocator;
    const value = std.process.getEnvVarOwned(allocator, "TAOD_DEBUG_ALLOC") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return false,
        else => return false,
    };
    defer allocator.free(value);
    return std.mem.eql(u8, value, "1");
}
