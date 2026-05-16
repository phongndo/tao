const std = @import("std");

pub const backend_name = "libghostty_c";
pub const supports_current_screen_snapshots = false;

pub const Options = struct {
    max_scrollback: u32 = 0,
};

const GhosttyResult = enum(c_int) {
    success = 0,
    out_of_memory = -1,
    invalid_value = -2,
    out_of_space = -3,
    no_value = -4,
};

const GhosttyTerminal = ?*anyopaque;
const GhosttyFormatter = ?*anyopaque;

const GhosttyTerminalOptions = extern struct {
    cols: u16,
    rows: u16,
    max_scrollback: usize,
};

const GhosttyFormatterFormat = enum(c_int) {
    plain = 0,
    vt = 1,
    html = 2,
};

const GhosttyFormatterScreenExtra = extern struct {
    size: usize = @sizeOf(GhosttyFormatterScreenExtra),
    cursor: bool = false,
    style: bool = false,
    hyperlink: bool = false,
    protection: bool = false,
    kitty_keyboard: bool = false,
    charsets: bool = false,
};

const GhosttyFormatterTerminalExtra = extern struct {
    size: usize = @sizeOf(GhosttyFormatterTerminalExtra),
    palette: bool = false,
    modes: bool = false,
    scrolling_region: bool = false,
    tabstops: bool = false,
    pwd: bool = false,
    keyboard: bool = false,
    screen: GhosttyFormatterScreenExtra = .{},
};

const GhosttyFormatterTerminalOptions = extern struct {
    size: usize = @sizeOf(GhosttyFormatterTerminalOptions),
    emit: GhosttyFormatterFormat = .plain,
    unwrap: bool = false,
    trim: bool = true,
    extra: GhosttyFormatterTerminalExtra = .{},
    selection: ?*const anyopaque = null,
};

extern fn ghostty_terminal_new(
    allocator: ?*const anyopaque,
    result: *GhosttyTerminal,
    options: GhosttyTerminalOptions,
) GhosttyResult;
extern fn ghostty_terminal_free(terminal: GhosttyTerminal) void;
extern fn ghostty_terminal_vt_write(terminal: GhosttyTerminal, ptr: [*]const u8, len: usize) void;
extern fn ghostty_terminal_resize(
    terminal: GhosttyTerminal,
    cols: u16,
    rows: u16,
    cell_width_px: u32,
    cell_height_px: u32,
) GhosttyResult;
extern fn ghostty_formatter_terminal_new(
    allocator: ?*const anyopaque,
    result: *GhosttyFormatter,
    terminal: GhosttyTerminal,
    options: GhosttyFormatterTerminalOptions,
) GhosttyResult;
extern fn ghostty_formatter_format_alloc(
    formatter: GhosttyFormatter,
    allocator: ?*const anyopaque,
    out_ptr: *?[*]u8,
    out_len: *usize,
) GhosttyResult;
extern fn ghostty_formatter_free(formatter: GhosttyFormatter) void;
extern fn ghostty_free(allocator: ?*const anyopaque, ptr: ?[*]u8, len: usize) void;

/// Thin C-ABI wrapper for a system-installed native libghostty-vt. The default
/// build does not use this path because Tao's CI currently uses Zig 0.16 while
/// upstream's Zig package is still tied to a different Zig build API. This path
/// keeps the daemon boundary ready for native libghostty-vt without introducing
/// a WASM runtime.
pub const Terminal = struct {
    cols: u16,
    rows: u16,
    max_scrollback: u32,
    handle: GhosttyTerminal,

    pub fn init(allocator: std.mem.Allocator, cols: u16, rows: u16) !Terminal {
        return initWithOptions(allocator, cols, rows, .{});
    }

    pub fn initWithOptions(
        allocator: std.mem.Allocator,
        cols: u16,
        rows: u16,
        options: Options,
    ) !Terminal {
        _ = allocator;
        if (cols == 0 or rows == 0) return error.InvalidSize;

        var handle: GhosttyTerminal = null;
        try resultToError(ghostty_terminal_new(null, &handle, .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = options.max_scrollback,
        }));
        errdefer ghostty_terminal_free(handle);

        return .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = options.max_scrollback,
            .handle = handle,
        };
    }

    pub fn deinit(self: *Terminal, allocator: std.mem.Allocator) void {
        _ = allocator;
        ghostty_terminal_free(self.handle);
        self.* = undefined;
    }

    pub fn write(self: *Terminal, bytes: []const u8) !void {
        if (bytes.len == 0) return;
        ghostty_terminal_vt_write(self.handle, bytes.ptr, bytes.len);
    }

    pub fn resize(self: *Terminal, allocator: std.mem.Allocator, cols: u16, rows: u16) !void {
        _ = allocator;
        if (cols == 0 or rows == 0) return error.InvalidSize;
        try resultToError(ghostty_terminal_resize(self.handle, cols, rows, 0, 0));
        self.cols = cols;
        self.rows = rows;
    }

    pub fn plainTextAlloc(self: *const Terminal, allocator: std.mem.Allocator) ![]u8 {
        var formatter: GhosttyFormatter = null;
        try resultToError(ghostty_formatter_terminal_new(null, &formatter, self.handle, .{}));
        defer ghostty_formatter_free(formatter);

        var out_ptr: ?[*]u8 = null;
        var out_len: usize = 0;
        try resultToError(ghostty_formatter_format_alloc(formatter, null, &out_ptr, &out_len));
        defer ghostty_free(null, out_ptr, out_len);

        const source = if (out_ptr) |ptr| ptr[0..out_len] else &[_]u8{};
        return try allocator.dupe(u8, source);
    }

    pub fn serializeCurrentScreenAlloc(self: *const Terminal, allocator: std.mem.Allocator) ![]u8 {
        _ = self;
        _ = allocator;
        return error.SnapshotUnsupported;
    }

    pub fn deserializeCurrentScreen(self: *Terminal, allocator: std.mem.Allocator, data: []const u8) !void {
        _ = self;
        _ = allocator;
        _ = data;
        return error.SnapshotUnsupported;
    }
};

fn resultToError(result: GhosttyResult) !void {
    return switch (result) {
        .success => {},
        .out_of_memory => error.OutOfMemory,
        .invalid_value => error.InvalidSize,
        .out_of_space => error.NoSpaceLeft,
        .no_value => error.NoValue,
    };
}
