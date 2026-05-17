const std = @import("std");

pub const control_payload_max = 64 * 1024;

pub const ControlPayload = struct {
    payload: []u8,
    tail: []u8,

    pub fn deinit(self: *ControlPayload, allocator: std.mem.Allocator) void {
        allocator.free(self.payload);
        allocator.free(self.tail);
        self.* = undefined;
    }
};

pub fn writeAllFd(fd: std.posix.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const written = std.c.write(fd, data[offset..].ptr, data.len - offset);
        if (written < 0) {
            switch (std.posix.errno(written)) {
                .INTR => continue,
                else => return error.SocketWriteFailed,
            }
        }
        if (written == 0) return error.SocketWriteFailed;
        offset += @intCast(written);
    }
}

pub fn writeAllFdNonBlocking(fd: std.posix.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const written = std.c.write(fd, data[offset..].ptr, data.len - offset);
        if (written < 0) {
            switch (std.posix.errno(written)) {
                .INTR => continue,
                .AGAIN => return error.SlowClientBackpressure,
                else => return error.SocketWriteFailed,
            }
        }
        if (written == 0) return error.SocketWriteFailed;
        offset += @intCast(written);
    }
}

pub fn setNonBlockingFd(fd: std.posix.fd_t) !void {
    var flags = try std.posix.fcntl(fd, std.posix.F.GETFL, 0);
    flags |= 1 << @bitOffsetOf(std.posix.O, "NONBLOCK");
    _ = try std.posix.fcntl(fd, std.posix.F.SETFL, flags);
}

pub fn readControlPayload(allocator: std.mem.Allocator, fd: std.c.fd_t) !ControlPayload {
    var payload: std.ArrayList(u8) = .empty;
    errdefer payload.deinit(allocator);

    var tail: std.ArrayList(u8) = .empty;
    errdefer tail.deinit(allocator);

    while (true) {
        var buffer: [4096]u8 = undefined;
        const amount = std.c.read(fd, &buffer, buffer.len);
        if (amount < 0) {
            switch (std.posix.errno(amount)) {
                .INTR => continue,
                else => return error.SocketReadFailed,
            }
        }
        if (amount == 0) break;

        const bytes = buffer[0..@intCast(amount)];
        if (std.mem.indexOfScalar(u8, bytes, '\n')) |newline_index| {
            if (payload.items.len + newline_index > control_payload_max) return error.ControlPayloadTooLarge;
            try payload.appendSlice(allocator, bytes[0..newline_index]);
            if (newline_index + 1 < bytes.len) try tail.appendSlice(allocator, bytes[newline_index + 1 ..]);
            return .{
                .payload = try payload.toOwnedSlice(allocator),
                .tail = try tail.toOwnedSlice(allocator),
            };
        }

        if (payload.items.len + bytes.len > control_payload_max) return error.ControlPayloadTooLarge;
        try payload.appendSlice(allocator, bytes);
    }

    if (payload.items.len == 0) return error.EmptyControlPayload;
    return .{
        .payload = try payload.toOwnedSlice(allocator),
        .tail = try tail.toOwnedSlice(allocator),
    };
}

test "control payload reader preserves attach tails and rejects oversize lines" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(.{ .sub_path = "with-tail", .data = "{\"type\":\"attach\"}\nstream-tail" });
    var with_tail = try tmp.dir.openFile("with-tail", .{});
    defer with_tail.close();

    var control = try readControlPayload(std.testing.allocator, with_tail.handle);
    defer control.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("{\"type\":\"attach\"}", control.payload);
    try std.testing.expectEqualStrings("stream-tail", control.tail);

    const oversized = try std.testing.allocator.alloc(u8, control_payload_max + 1);
    defer std.testing.allocator.free(oversized);
    @memset(oversized, 'x');
    try tmp.dir.writeFile(.{ .sub_path = "oversized", .data = oversized });
    var oversized_file = try tmp.dir.openFile("oversized", .{});
    defer oversized_file.close();

    try std.testing.expectError(error.ControlPayloadTooLarge, readControlPayload(std.testing.allocator, oversized_file.handle));
}
