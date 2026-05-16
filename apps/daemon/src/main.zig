const std = @import("std");
const taod = @import("taod");

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;
    const home = init.environ_map.get("HOME") orelse return error.HomeNotSet;

    var args = try std.process.Args.Iterator.initAllocator(init.minimal.args, allocator);
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

    try daemon.prepareStorage(init.io);

    if (check) return;

    try daemon.runForever(init.io);
}
