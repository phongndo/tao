const std = @import("std");

pub const PtyError = error{
    InvalidSize,
    NotImplemented,
};

pub const Child = struct {
    pid: u32,
    master_fd: i32,
    cols: u16,
    rows: u16,
};

pub const SpawnOptions = struct {
    argv: []const []const u8,
    cwd: ?[]const u8 = null,
    cols: u16,
    rows: u16,
};

/// Phase-0 placeholder for the real POSIX PTY implementation. The daemon owns the
/// public driver boundary now, while `posix_openpt`/fork/exec work can land behind
/// this file without changing the RPC/session layers.
pub const Driver = struct {
    pub fn spawn(_: *Driver, options: SpawnOptions) PtyError!Child {
        try validateSize(options.cols, options.rows);
        if (options.argv.len == 0) return error.NotImplemented;
        return error.NotImplemented;
    }

    pub fn resize(_: *Driver, child: *Child, cols: u16, rows: u16) PtyError!void {
        try validateSize(cols, rows);
        child.cols = cols;
        child.rows = rows;
    }
};

pub fn validateSize(cols: u16, rows: u16) PtyError!void {
    if (cols == 0 or rows == 0) return error.InvalidSize;
}

test "pty driver validates terminal sizes" {
    try validateSize(80, 24);
    try std.testing.expectError(error.InvalidSize, validateSize(0, 24));
}
