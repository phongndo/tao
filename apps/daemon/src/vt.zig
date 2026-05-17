const std = @import("std");
const build_options = @import("build_options");

const backend = @import("vt_ghostty_native.zig");

pub const Options = backend.Options;
pub const Terminal = backend.Terminal;
pub const backend_name = backend.backend_name;
pub const supports_current_screen_snapshots = backend.supports_current_screen_snapshots;

pub fn isLibghosttyBacked() bool {
    return true;
}

test "vt wrapper validates dimensions and exposes backend" {
    try std.testing.expect(std.mem.eql(u8, backend_name, build_options.vt_backend));
    try std.testing.expectError(error.InvalidSize, Terminal.init(std.testing.allocator, 0, 24));

    var terminal = try Terminal.init(std.testing.allocator, 80, 24);
    defer terminal.deinit(std.testing.allocator);

    try terminal.resize(std.testing.allocator, 120, 40);
    try std.testing.expectEqual(@as(u16, 120), terminal.cols);
    try std.testing.expectEqual(@as(u16, 40), terminal.rows);
}

test "vt wrapper tracks a smoke-test current screen" {
    var terminal = try Terminal.init(std.testing.allocator, 12, 4);
    defer terminal.deinit(std.testing.allocator);

    try terminal.write("hello\r\n\x1b[2;3HVT");

    const text = try terminal.plainTextAlloc(std.testing.allocator);
    defer std.testing.allocator.free(text);

    try std.testing.expect(std.mem.indexOf(u8, text, "hello") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "  VT") != null);
}

test "vt wrapper round-trips current-screen snapshots when supported" {
    if (!supports_current_screen_snapshots) return;

    var terminal = try Terminal.init(std.testing.allocator, 12, 4);
    defer terminal.deinit(std.testing.allocator);
    try terminal.write("hello\r\n\x1b[2;3HVT");

    const snapshot = try terminal.serializeCurrentScreenAlloc(std.testing.allocator);
    defer std.testing.allocator.free(snapshot);

    var restored = try Terminal.init(std.testing.allocator, 4, 2);
    defer restored.deinit(std.testing.allocator);
    try restored.deserializeCurrentScreen(std.testing.allocator, snapshot);

    const text = try restored.plainTextAlloc(std.testing.allocator);
    defer std.testing.allocator.free(text);

    try std.testing.expectEqual(@as(u16, 12), restored.cols);
    try std.testing.expectEqual(@as(u16, 4), restored.rows);
    try std.testing.expect(std.mem.indexOf(u8, text, "hello") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "  VT") != null);
}
