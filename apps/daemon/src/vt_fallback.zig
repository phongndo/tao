const std = @import("std");

pub const backend_name = "fallback";

pub const Options = struct {
    max_scrollback: u32 = 0,
};

const ParserState = enum {
    normal,
    escape,
    csi,
};

/// Small VT-compatible current-screen fallback used when libghostty-vt is not
/// linked. It intentionally implements only enough terminal behavior for taod's
/// metadata/current-screen boundary tests; production parsing should use the
/// libghostty-vt backend.
pub const Terminal = struct {
    cols: u16,
    rows: u16,
    max_scrollback: u32,
    cursor_x: u16,
    cursor_y: u16,
    screen: []u8,
    parser_state: ParserState = .normal,
    csi_buffer: [32]u8 = undefined,
    csi_len: usize = 0,

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

        const screen = try allocator.alloc(u8, @as(usize, cols) * rows);
        @memset(screen, ' ');

        return .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = options.max_scrollback,
            .cursor_x = 0,
            .cursor_y = 0,
            .screen = screen,
        };
    }

    pub fn deinit(self: *Terminal, allocator: std.mem.Allocator) void {
        allocator.free(self.screen);
        self.* = undefined;
    }

    pub fn write(self: *Terminal, bytes: []const u8) !void {
        for (bytes) |byte| self.writeByte(byte);
    }

    pub fn resize(self: *Terminal, allocator: std.mem.Allocator, cols: u16, rows: u16) !void {
        if (cols == 0 or rows == 0) return error.InvalidSize;
        if (self.cols == cols and self.rows == rows) return;

        const next = try allocator.alloc(u8, @as(usize, cols) * rows);
        @memset(next, ' ');

        const copy_rows = @min(self.rows, rows);
        const copy_cols = @min(self.cols, cols);
        var row: usize = 0;
        while (row < copy_rows) : (row += 1) {
            const old_start = row * self.cols;
            const new_start = row * cols;
            @memcpy(next[new_start .. new_start + copy_cols], self.screen[old_start .. old_start + copy_cols]);
        }

        allocator.free(self.screen);
        self.screen = next;
        self.cols = cols;
        self.rows = rows;
        self.cursor_x = @min(self.cursor_x, cols - 1);
        self.cursor_y = @min(self.cursor_y, rows - 1);
    }

    pub fn plainTextAlloc(self: *const Terminal, allocator: std.mem.Allocator) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(allocator);
        errdefer out.deinit();

        const last = self.lastNonBlankRow();
        var row: usize = 0;
        while (row <= last) : (row += 1) {
            if (row > 0) try out.writer.writeByte('\n');
            const end = self.lastNonBlankCol(row);
            if (end == 0) continue;
            const start = row * self.cols;
            try out.writer.writeAll(self.screen[start .. start + end]);
        }

        return try out.toOwnedSlice();
    }

    fn writeByte(self: *Terminal, byte: u8) void {
        switch (self.parser_state) {
            .normal => self.writeNormal(byte),
            .escape => self.writeEscape(byte),
            .csi => self.writeCsi(byte),
        }
    }

    fn writeNormal(self: *Terminal, byte: u8) void {
        switch (byte) {
            0x1b => {
                self.parser_state = .escape;
                self.csi_len = 0;
            },
            '\r' => self.cursor_x = 0,
            '\n' => self.lineFeed(),
            0x08 => {
                if (self.cursor_x > 0) self.cursor_x -= 1;
            },
            '\t' => self.cursor_x = @min(self.cols - 1, self.cursor_x + (8 - (self.cursor_x % 8))),
            0x20...0x7e => self.putPrintable(byte),
            else => {},
        }
    }

    fn writeEscape(self: *Terminal, byte: u8) void {
        if (byte == '[') {
            self.parser_state = .csi;
            self.csi_len = 0;
            return;
        }

        self.parser_state = .normal;
    }

    fn writeCsi(self: *Terminal, byte: u8) void {
        if ((byte >= '0' and byte <= '9') or byte == ';' or byte == '?') {
            if (self.csi_len < self.csi_buffer.len) {
                self.csi_buffer[self.csi_len] = byte;
                self.csi_len += 1;
            }
            return;
        }

        self.applyCsi(byte);
        self.parser_state = .normal;
        self.csi_len = 0;
    }

    fn applyCsi(self: *Terminal, final: u8) void {
        var params: [4]u16 = .{ 0, 0, 0, 0 };
        const count = self.parseCsiParams(&params);

        switch (final) {
            'A' => self.moveCursor(0, -@as(i32, paramOrDefault(&params, count, 0, 1))),
            'B' => self.moveCursor(0, @as(i32, paramOrDefault(&params, count, 0, 1))),
            'C' => self.moveCursor(@as(i32, paramOrDefault(&params, count, 0, 1)), 0),
            'D' => self.moveCursor(-@as(i32, paramOrDefault(&params, count, 0, 1)), 0),
            'H', 'f' => {
                const row = paramOrDefault(&params, count, 0, 1);
                const col = paramOrDefault(&params, count, 1, 1);
                self.cursor_y = @min(self.rows - 1, if (row > 0) row - 1 else 0);
                self.cursor_x = @min(self.cols - 1, if (col > 0) col - 1 else 0);
            },
            'J' => {
                const mode = paramOrDefault(&params, count, 0, 0);
                if (mode == 2 or mode == 3) self.clearScreen();
            },
            'K' => {
                const mode = paramOrDefault(&params, count, 0, 0);
                if (mode == 0 or mode == 2) self.clearLine(self.cursor_y);
            },
            'm' => {},
            else => {},
        }
    }

    fn parseCsiParams(self: *const Terminal, out: *[4]u16) usize {
        if (self.csi_len == 0) return 0;

        var count: usize = 0;
        var current: u16 = 0;
        var has_digit = false;

        for (self.csi_buffer[0..self.csi_len]) |byte| {
            switch (byte) {
                '0'...'9' => {
                    has_digit = true;
                    current = std.math.mul(u16, current, 10) catch std.math.maxInt(u16);
                    current = std.math.add(u16, current, byte - '0') catch std.math.maxInt(u16);
                },
                ';' => {
                    if (count < out.len) out[count] = if (has_digit) current else 0;
                    count += 1;
                    current = 0;
                    has_digit = false;
                },
                else => {},
            }
        }

        if (count < out.len) out[count] = if (has_digit) current else 0;
        return @min(count + 1, out.len);
    }

    fn putPrintable(self: *Terminal, byte: u8) void {
        if (self.cursor_x >= self.cols) {
            self.cursor_x = 0;
            self.lineFeed();
        }

        self.screen[self.index(self.cursor_x, self.cursor_y)] = byte;
        if (self.cursor_x + 1 >= self.cols) {
            self.cursor_x = self.cols;
        } else {
            self.cursor_x += 1;
        }
    }

    fn lineFeed(self: *Terminal) void {
        if (self.cursor_y + 1 < self.rows) {
            self.cursor_y += 1;
            return;
        }

        const row_len: usize = self.cols;
        if (self.rows > 1) {
            std.mem.copyForwards(
                u8,
                self.screen[0 .. @as(usize, self.rows - 1) * row_len],
                self.screen[row_len .. @as(usize, self.rows) * row_len],
            );
        }
        @memset(self.screen[@as(usize, self.rows - 1) * row_len .. @as(usize, self.rows) * row_len], ' ');
    }

    fn moveCursor(self: *Terminal, dx: i32, dy: i32) void {
        const next_x = std.math.clamp(@as(i32, self.cursor_x) + dx, 0, @as(i32, self.cols - 1));
        const next_y = std.math.clamp(@as(i32, self.cursor_y) + dy, 0, @as(i32, self.rows - 1));
        self.cursor_x = @intCast(next_x);
        self.cursor_y = @intCast(next_y);
    }

    fn clearScreen(self: *Terminal) void {
        @memset(self.screen, ' ');
        self.cursor_x = 0;
        self.cursor_y = 0;
    }

    fn clearLine(self: *Terminal, row: u16) void {
        const start = @as(usize, row) * self.cols;
        @memset(self.screen[start .. start + self.cols], ' ');
        self.cursor_x = 0;
    }

    fn index(self: *const Terminal, x: u16, y: u16) usize {
        return @as(usize, y) * self.cols + x;
    }

    fn lastNonBlankRow(self: *const Terminal) usize {
        var row: usize = self.rows;
        while (row > 0) {
            row -= 1;
            if (self.lastNonBlankCol(row) > 0) return row;
        }
        return 0;
    }

    fn lastNonBlankCol(self: *const Terminal, row: usize) usize {
        const start = row * self.cols;
        var col: usize = self.cols;
        while (col > 0) {
            if (self.screen[start + col - 1] != ' ') return col;
            col -= 1;
        }
        return 0;
    }
};

fn paramOrDefault(params: *const [4]u16, count: usize, index: usize, default: u16) u16 {
    if (index >= count) return default;
    const value = params[index];
    return if (value == 0) default else value;
}

test "fallback VT handles basic cursor movement and clear" {
    var terminal = try Terminal.init(std.testing.allocator, 8, 3);
    defer terminal.deinit(std.testing.allocator);

    try terminal.write("abc\r\n\x1b[2;5HZ\x1b[1;1H!");
    const text = try terminal.plainTextAlloc(std.testing.allocator);
    defer std.testing.allocator.free(text);

    try std.testing.expectEqualStrings("!bc\n    Z", text);

    try terminal.write("\x1b[2J");
    const cleared = try terminal.plainTextAlloc(std.testing.allocator);
    defer std.testing.allocator.free(cleared);
    try std.testing.expectEqualStrings("", cleared);
}
