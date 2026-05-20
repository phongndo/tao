const std = @import("std");

pub const control_payload_max = 64 * 1024;

const assert = std.debug.assert;

pub const ControlPayload = struct {
    payload: []u8,
    tail: []u8,

    pub fn deinit(self: *ControlPayload, allocator: std.mem.Allocator) void {
        allocator.free(self.payload);
        allocator.free(self.tail);
        self.* = undefined;
    }
};

fn ownedControlPayload(
    allocator: std.mem.Allocator,
    payload: *std.ArrayList(u8),
    tail: *std.ArrayList(u8),
) !ControlPayload {
    assert(payload.items.len <= control_payload_max);
    const owned_payload = try payload.toOwnedSlice(allocator);
    errdefer allocator.free(owned_payload);
    const owned_tail = try tail.toOwnedSlice(allocator);
    assert(owned_payload.len <= control_payload_max);
    return .{ .payload = owned_payload, .tail = owned_tail };
}

pub fn writeAllFd(fd: std.posix.fd_t, data: []const u8) !void {
    assert(fd >= 0);
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
    assert(fd >= 0);
    var flags = try std.posix.fcntl(fd, std.posix.F.GETFL, 0);
    flags |= 1 << @bitOffsetOf(std.posix.O, "NONBLOCK");
    _ = try std.posix.fcntl(fd, std.posix.F.SETFL, flags);
}

fn remainingTimeoutMs(start_ms: i64, timeout_ms: i32) ?i32 {
    assert(timeout_ms > 0);
    const elapsed = std.time.milliTimestamp() - start_ms;
    if (elapsed >= timeout_ms) return null;
    return @intCast(timeout_ms - elapsed);
}

pub fn readControlPayloadWithTimeout(allocator: std.mem.Allocator, fd: std.c.fd_t, timeout_ms: i32) !ControlPayload {
    assert(fd >= 0);
    assert(timeout_ms > 0);
    var payload: std.ArrayList(u8) = .empty;
    errdefer payload.deinit(allocator);

    var tail: std.ArrayList(u8) = .empty;
    errdefer tail.deinit(allocator);

    const start_ms = std.time.milliTimestamp();

    while (true) {
        const remaining_ms = remainingTimeoutMs(start_ms, timeout_ms) orelse return error.ControlPayloadTimedOut;
        var poll_fds = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
        const ready = try std.posix.poll(&poll_fds, remaining_ms);
        if (ready == 0) return error.ControlPayloadTimedOut;
        if ((poll_fds[0].revents & (std.posix.POLL.HUP | std.posix.POLL.ERR)) != 0) {
            if ((poll_fds[0].revents & std.posix.POLL.IN) == 0) break;
        }

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
            assert(payload.items.len <= control_payload_max);
            if (newline_index + 1 < bytes.len) try tail.appendSlice(allocator, bytes[newline_index + 1 ..]);
            return ownedControlPayload(allocator, &payload, &tail);
        }

        if (payload.items.len + bytes.len > control_payload_max) return error.ControlPayloadTooLarge;
        try payload.appendSlice(allocator, bytes);
        assert(payload.items.len <= control_payload_max);
    }

    if (payload.items.len == 0) return error.EmptyControlPayload;
    return ownedControlPayload(allocator, &payload, &tail);
}

pub fn readControlPayload(allocator: std.mem.Allocator, fd: std.c.fd_t) !ControlPayload {
    return readControlPayloadWithTimeout(allocator, fd, std.math.maxInt(i32));
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

test "control payload reader times out waiting for first line" {
    const pipe_fds = try std.posix.pipe();
    defer std.posix.close(pipe_fds[0]);
    defer std.posix.close(pipe_fds[1]);

    try std.testing.expectError(
        error.ControlPayloadTimedOut,
        readControlPayloadWithTimeout(std.testing.allocator, pipe_fds[0], 1),
    );
}

test "control payload reader enforces timeout across partial first line" {
    const pipe_fds = try std.posix.pipe();
    defer std.posix.close(pipe_fds[0]);
    defer std.posix.close(pipe_fds[1]);

    _ = try std.posix.write(pipe_fds[1], "partial");

    try std.testing.expectError(
        error.ControlPayloadTimedOut,
        readControlPayloadWithTimeout(std.testing.allocator, pipe_fds[0], 1),
    );
}
