const std = @import("std");
const session = @import("../session.zig");

pub const ParsedArgv = struct {
    parsed: ?std.json.Parsed([][]const u8) = null,

    pub fn deinit(self: *ParsedArgv) void {
        if (self.parsed) |*parsed| parsed.deinit();
        self.* = undefined;
    }

    pub fn items(self: *const ParsedArgv) []const []const u8 {
        if (self.parsed) |parsed| return parsed.value;
        return &.{};
    }
};

pub fn parseArgvJson(allocator: std.mem.Allocator, json: []const u8) !ParsedArgv {
    if (json.len == 0) return .{};
    const parsed = try std.json.parseFromSlice([][]const u8, allocator, json, .{});
    return .{ .parsed = parsed };
}

pub fn argvJsonAlloc(allocator: std.mem.Allocator, argv: []const []const u8) !?[]u8 {
    if (argv.len == 0) return null;

    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    try out.writer.writeByte('[');
    for (argv, 0..) |arg, index| {
        if (index > 0) try out.writer.writeByte(',');
        try out.writer.print("{f}", .{std.json.fmt(arg, .{})});
    }
    try out.writer.writeByte(']');

    return try out.toOwnedSlice();
}

pub fn readSmallFileAlloc(allocator: std.mem.Allocator, path: []const u8, limit: usize) !?[]u8 {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY, .CLOEXEC = true });
    if (fd < 0) {
        return switch (std.posix.errno(fd)) {
            .NOENT => null,
            else => error.FileOpenFailed,
        };
    }
    defer _ = std.c.close(fd);

    var stat: std.c.Stat = undefined;
    if (std.c.fstat(fd, &stat) != 0) return error.FileStatFailed;
    if (stat.size < 0) return error.FileTooBig;
    const size: usize = @intCast(stat.size);
    if (size > limit) return error.FileTooBig;

    const data = try allocator.alloc(u8, size);
    errdefer allocator.free(data);

    var offset: usize = 0;
    while (offset < data.len) {
        const amount = std.c.read(fd, data[offset..].ptr, data.len - offset);
        if (amount < 0) {
            switch (std.posix.errno(amount)) {
                .INTR => continue,
                else => return error.FileReadFailed,
            }
        }
        if (amount == 0) break;
        offset += @intCast(amount);
    }

    if (offset == data.len) return data;
    return try allocator.realloc(data, offset);
}

pub fn fileExists(path: []const u8) bool {
    const allocator = std.heap.smp_allocator;
    const path_z = allocator.dupeZ(u8, path) catch return false;
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY, .CLOEXEC = true });
    if (fd < 0) return false;
    _ = std.c.close(fd);
    return true;
}

var session_id_counter = std.atomic.Value(u64).init(0);

pub fn generateSessionId(allocator: std.mem.Allocator) ![]u8 {
    var tv: std.c.timeval = .{ .sec = 0, .usec = 0 };
    _ = std.c.gettimeofday(&tv, null);
    const counter = session_id_counter.fetchAdd(1, .monotonic) + 1;
    return std.fmt.allocPrint(allocator, "{x:0>8}-{x:0>4}-{x:0>4}-{x:0>4}-{x:0>12}", .{
        @as(u32, @truncate(@as(u64, @intCast(tv.sec)))),
        @as(u16, @truncate(@as(u64, @intCast(tv.usec)))),
        @as(u16, @truncate(@as(u32, @intCast(std.c.getpid())))),
        @as(u16, @truncate(counter)),
        @as(u48, @truncate(counter)),
    });
}

pub fn isLiveAttachable(item: *const session.TerminalSession) bool {
    return switch (item.status) {
        .live, .detached => blk: {
            const child = item.pty_child orelse break :blk false;
            break :blk child.master_fd >= 0;
        },
        .exited, .crashed, .archived, .killed => false,
    };
}

pub fn isResumableAgentStatus(status: []const u8) bool {
    return std.mem.eql(u8, status, "running") or
        std.mem.eql(u8, status, "detected") or
        std.mem.eql(u8, status, "ended");
}
