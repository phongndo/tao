const std = @import("std");
const build_options = @import("build_options");

const backend = if (build_options.libghostty_vt_c)
    @import("vt_libghostty_c.zig")
else
    @import("vt_fallback.zig");

pub const Options = backend.Options;
pub const Terminal = backend.Terminal;
pub const backend_name = backend.backend_name;

pub fn isLibghosttyBacked() bool {
    return build_options.libghostty_vt_c;
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
