const std = @import("std");
const ghostty_vt = @import("ghostty-vt");

pub const backend_name = "ghostty_native";
pub const supports_current_screen_snapshots = true;

const current_screen_magic = [_]u8{ 0x54, 0x41, 0x4f, 0x47, 0x56, 0x54, 0x01, 0x00 }; // TAUGVT\1\0
const current_screen_version: u16 = 1;
const current_screen_header_size: usize = 26;
const max_current_screen_bytes: usize = 16 * 1024 * 1024;

pub const Options = struct {
    max_scrollback: u32 = 0,
};

/// Zig-native libghostty-vt backend. Tau keeps this as a small adapter so the
/// daemon owns only one VT abstraction while upstream libghostty-vt's API is
/// still explicitly marked unstable.
pub const Terminal = struct {
    cols: u16,
    rows: u16,
    max_scrollback: u32,
    handle: *ghostty_vt.Terminal,
    stream: ghostty_vt.ReadonlyStream,

    pub fn init(allocator: std.mem.Allocator, cols: u16, rows: u16) !Terminal {
        return initWithOptions(allocator, cols, rows, .{});
    }

    pub fn initWithOptions(
        allocator: std.mem.Allocator,
        cols: u16,
        rows: u16,
        options: Options,
    ) !Terminal {
        if (cols == 0 or rows == 0) return error.InvalidSize;

        const handle = try allocator.create(ghostty_vt.Terminal);
        errdefer allocator.destroy(handle);

        handle.* = try ghostty_vt.Terminal.init(allocator, .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = options.max_scrollback,
        });
        errdefer handle.deinit(allocator);

        return .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = options.max_scrollback,
            .handle = handle,
            .stream = handle.vtStream(),
        };
    }

    pub fn deinit(self: *Terminal, allocator: std.mem.Allocator) void {
        self.stream.deinit();
        self.handle.deinit(allocator);
        allocator.destroy(self.handle);
        self.* = undefined;
    }

    pub fn write(self: *Terminal, bytes: []const u8) !void {
        if (bytes.len == 0) return;
        try self.stream.nextSlice(bytes);
    }

    pub fn resize(self: *Terminal, allocator: std.mem.Allocator, cols: u16, rows: u16) !void {
        if (cols == 0 or rows == 0) return error.InvalidSize;
        try self.handle.resize(allocator, cols, rows);
        self.cols = cols;
        self.rows = rows;
    }

    pub fn plainTextAlloc(self: *const Terminal, allocator: std.mem.Allocator) ![]u8 {
        const text = try @constCast(self.handle).plainString(allocator);
        return @constCast(text);
    }

    /// Serialize only the active, visible current screen as VT restore bytes,
    /// wrapped in a small Tau header that carries dimensions and integrity.
    /// Historical scrollback is intentionally not included.
    pub fn serializeCurrentScreenAlloc(self: *const Terminal, allocator: std.mem.Allocator) ![]u8 {
        var body: std.Io.Writer.Allocating = .init(allocator);
        defer body.deinit();

        try body.writer.writeAll("\x1b[2J\x1b[H");
        var formatter: ghostty_vt.formatter.TerminalFormatter = .init(self.handle, .{
            .emit = .vt,
            .trim = false,
        });
        formatter.extra = .styles;
        formatter.extra.screen.cursor = true;
        try formatter.format(&body.writer);

        const vt_bytes = body.writer.buffered();
        if (vt_bytes.len > max_current_screen_bytes) return error.SnapshotTooLarge;

        const total_len = current_screen_header_size + vt_bytes.len;
        const out = try allocator.alloc(u8, total_len);
        errdefer allocator.free(out);

        @memcpy(out[0..current_screen_magic.len], &current_screen_magic);
        std.mem.writeInt(u16, out[8..10], current_screen_version, .big);
        std.mem.writeInt(u16, out[10..12], self.cols, .big);
        std.mem.writeInt(u16, out[12..14], self.rows, .big);
        std.mem.writeInt(u32, out[14..18], self.max_scrollback, .big);
        std.mem.writeInt(u32, out[18..22], @intCast(vt_bytes.len), .big);
        std.mem.writeInt(u32, out[22..26], std.hash.Crc32.hash(vt_bytes), .big);
        @memcpy(out[current_screen_header_size..total_len], vt_bytes);

        return out;
    }

    pub fn deserializeCurrentScreen(self: *Terminal, allocator: std.mem.Allocator, data: []const u8) !void {
        if (data.len < current_screen_header_size) return error.InvalidSnapshot;
        if (!std.mem.eql(u8, data[0..current_screen_magic.len], &current_screen_magic)) return error.InvalidSnapshot;

        const version = std.mem.readInt(u16, data[8..10], .big);
        if (version != current_screen_version) return error.UnsupportedSnapshotVersion;

        const cols = std.mem.readInt(u16, data[10..12], .big);
        const rows = std.mem.readInt(u16, data[12..14], .big);
        const max_scrollback = std.mem.readInt(u32, data[14..18], .big);
        const vt_len: usize = @intCast(std.mem.readInt(u32, data[18..22], .big));
        const expected_crc = std.mem.readInt(u32, data[22..26], .big);

        if (cols == 0 or rows == 0) return error.InvalidSnapshot;
        if (vt_len > max_current_screen_bytes) return error.SnapshotTooLarge;
        if (data.len != current_screen_header_size + vt_len) return error.InvalidSnapshot;

        const vt_bytes = data[current_screen_header_size..];
        if (std.hash.Crc32.hash(vt_bytes) != expected_crc) return error.InvalidSnapshot;

        const next_handle = try allocator.create(ghostty_vt.Terminal);
        errdefer allocator.destroy(next_handle);
        next_handle.* = try ghostty_vt.Terminal.init(allocator, .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = max_scrollback,
        });
        errdefer next_handle.deinit(allocator);

        var next_stream = next_handle.vtStream();
        errdefer next_stream.deinit();
        try next_stream.nextSlice(vt_bytes);

        self.stream.deinit();
        self.handle.deinit(allocator);
        allocator.destroy(self.handle);

        self.cols = cols;
        self.rows = rows;
        self.max_scrollback = max_scrollback;
        self.handle = next_handle;
        self.stream = next_stream;
    }
};

test "ghostty native VT preserves parser state across writes" {
    var terminal = try Terminal.init(std.testing.allocator, 8, 2);
    defer terminal.deinit(std.testing.allocator);

    try terminal.write("\x1b[2");
    try terminal.write(";3HZ");

    const text = try terminal.plainTextAlloc(std.testing.allocator);
    defer std.testing.allocator.free(text);
    try std.testing.expectEqualStrings("\n  Z", text);
}
