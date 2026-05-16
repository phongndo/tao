const std = @import("std");

pub const Terminal = struct {
    cols: u16,
    rows: u16,
    max_scrollback: u32,

    pub fn init(cols: u16, rows: u16) !Terminal {
        if (cols == 0 or rows == 0) return error.InvalidSize;
        return .{ .cols = cols, .rows = rows, .max_scrollback = 10_000 };
    }

    pub fn write(_: *Terminal, _: []const u8) void {
        // libghostty-vt will be linked behind this boundary in the next phase.
    }

    pub fn resize(self: *Terminal, cols: u16, rows: u16) !void {
        if (cols == 0 or rows == 0) return error.InvalidSize;
        self.cols = cols;
        self.rows = rows;
    }
};

test "vt wrapper validates dimensions" {
    var terminal = try Terminal.init(80, 24);
    try terminal.resize(120, 40);
    try std.testing.expectEqual(@as(u16, 120), terminal.cols);
}
