const std = @import("std");

pub const file_name = "current-screen.state";
pub const file_magic = [_]u8{ 0x54, 0x41, 0x4f, 0x53, 0x4e, 0x50, 0x01, 0x00 }; // TAOSNP\1\0
pub const file_version: u16 = 1;
pub const file_header_size: usize = 34;
pub const max_backend_name_bytes: usize = 128;
pub const max_payload_bytes: usize = 16 * 1024 * 1024;

pub const Metadata = struct {
    seq: u64,
    crc32: u32,
    size: usize,
};

pub const CurrentScreenSnapshot = struct {
    seq: u64,
    cols: u16,
    rows: u16,
    backend_name: []const u8,
    payload: []const u8,
};

pub const DecodedCurrentScreenSnapshot = struct {
    seq: u64,
    cols: u16,
    rows: u16,
    backend_name: []u8,
    payload: []u8,
    payload_crc32: u32,

    pub fn deinit(self: *DecodedCurrentScreenSnapshot, allocator: std.mem.Allocator) void {
        allocator.free(self.backend_name);
        allocator.free(self.payload);
        self.* = undefined;
    }
};

pub fn metadata(seq: u64, bytes: []const u8) Metadata {
    return .{ .seq = seq, .crc32 = std.hash.Crc32.hash(bytes), .size = bytes.len };
}

pub fn pathAlloc(allocator: std.mem.Allocator, session_dir: []const u8) ![]u8 {
    return std.fs.path.join(allocator, &.{ session_dir, file_name });
}

pub fn encodeAlloc(allocator: std.mem.Allocator, input: CurrentScreenSnapshot) ![]u8 {
    try validateInput(input);

    const total_len = file_header_size + input.backend_name.len + input.payload.len;
    const out = try allocator.alloc(u8, total_len);
    errdefer allocator.free(out);

    @memcpy(out[0..file_magic.len], &file_magic);
    std.mem.writeInt(u16, out[8..10], file_version, .big);
    std.mem.writeInt(u16, out[10..12], input.cols, .big);
    std.mem.writeInt(u16, out[12..14], input.rows, .big);
    std.mem.writeInt(u16, out[14..16], @intCast(input.backend_name.len), .big);
    std.mem.writeInt(u16, out[16..18], 0, .big);
    std.mem.writeInt(u64, out[18..26], input.seq, .big);
    std.mem.writeInt(u32, out[26..30], @intCast(input.payload.len), .big);
    std.mem.writeInt(u32, out[30..34], std.hash.Crc32.hash(input.payload), .big);

    const backend_start = file_header_size;
    const payload_start = backend_start + input.backend_name.len;
    @memcpy(out[backend_start..payload_start], input.backend_name);
    @memcpy(out[payload_start..total_len], input.payload);

    return out;
}

pub fn decodeAlloc(allocator: std.mem.Allocator, bytes: []const u8) !DecodedCurrentScreenSnapshot {
    if (bytes.len < file_header_size) return error.InvalidSnapshot;
    if (!std.mem.eql(u8, bytes[0..file_magic.len], &file_magic)) return error.InvalidSnapshot;

    const version = std.mem.readInt(u16, bytes[8..10], .big);
    if (version != file_version) return error.UnsupportedSnapshotVersion;

    const cols = std.mem.readInt(u16, bytes[10..12], .big);
    const rows = std.mem.readInt(u16, bytes[12..14], .big);
    const backend_len: usize = @intCast(std.mem.readInt(u16, bytes[14..16], .big));
    const seq = std.mem.readInt(u64, bytes[18..26], .big);
    const payload_len: usize = @intCast(std.mem.readInt(u32, bytes[26..30], .big));
    const payload_crc32 = std.mem.readInt(u32, bytes[30..34], .big);

    if (cols == 0 or rows == 0) return error.InvalidSnapshot;
    if (backend_len == 0 or backend_len > max_backend_name_bytes) return error.InvalidSnapshot;
    if (payload_len > max_payload_bytes) return error.SnapshotTooLarge;
    if (bytes.len != file_header_size + backend_len + payload_len) return error.InvalidSnapshot;

    const backend_start = file_header_size;
    const payload_start = backend_start + backend_len;
    const payload = bytes[payload_start .. payload_start + payload_len];
    if (std.hash.Crc32.hash(payload) != payload_crc32) return error.InvalidSnapshot;

    const backend_name = try allocator.dupe(u8, bytes[backend_start..payload_start]);
    errdefer allocator.free(backend_name);
    const owned_payload = try allocator.dupe(u8, payload);
    errdefer allocator.free(owned_payload);

    return .{
        .seq = seq,
        .cols = cols,
        .rows = rows,
        .backend_name = backend_name,
        .payload = owned_payload,
        .payload_crc32 = payload_crc32,
    };
}

pub fn writeCurrentScreenPath(
    allocator: std.mem.Allocator,
    path: []const u8,
    input: CurrentScreenSnapshot,
) !Metadata {
    const encoded = try encodeAlloc(allocator, input);
    defer allocator.free(encoded);

    try writeFile(path, encoded, 0o600);
    return metadata(input.seq, encoded);
}

pub fn readCurrentScreenPath(allocator: std.mem.Allocator, path: []const u8) !?DecodedCurrentScreenSnapshot {
    const data = try readFileAlloc(allocator, path, file_header_size + max_backend_name_bytes + max_payload_bytes);
    defer if (data) |bytes| allocator.free(bytes);

    const bytes = data orelse return null;
    return try decodeAlloc(allocator, bytes);
}

pub fn deleteCurrentScreenPath(path: []const u8) !void {
    const allocator = std.heap.smp_allocator;
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    if (std.c.unlink(path_z.ptr) == 0) return;
    switch (std.posix.errno(-1)) {
        .NOENT => {},
        else => return error.FileDeleteFailed,
    }
}

fn validateInput(input: CurrentScreenSnapshot) !void {
    if (input.cols == 0 or input.rows == 0) return error.InvalidSnapshot;
    if (input.backend_name.len == 0 or input.backend_name.len > max_backend_name_bytes) return error.InvalidSnapshot;
    if (input.payload.len > max_payload_bytes) return error.SnapshotTooLarge;
}

fn readFileAlloc(allocator: std.mem.Allocator, path: []const u8, limit: usize) !?[]u8 {
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

    return data[0..offset];
}

fn writeFile(path: []const u8, data: []const u8, mode: std.c.mode_t) !void {
    const allocator = std.heap.smp_allocator;
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{
        .ACCMODE = .WRONLY,
        .CREAT = true,
        .TRUNC = true,
        .CLOEXEC = true,
    }, mode);
    if (fd < 0) return error.FileOpenFailed;
    defer _ = std.c.close(fd);
    _ = std.c.fchmod(fd, mode);

    try writeAllFd(fd, data);
}

fn writeAllFd(fd: std.c.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const written = std.c.write(fd, data[offset..].ptr, data.len - offset);
        if (written < 0) {
            switch (std.posix.errno(written)) {
                .INTR => continue,
                else => return error.FileWriteFailed,
            }
        }
        if (written == 0) return error.FileWriteFailed;
        offset += @intCast(written);
    }
}

test "snapshot metadata records crc and size" {
    const meta = metadata(7, "state");
    try std.testing.expectEqual(@as(u64, 7), meta.seq);
    try std.testing.expectEqual(@as(usize, 5), meta.size);
    try std.testing.expectEqual(std.hash.Crc32.hash("state"), meta.crc32);
}

test "current-screen snapshot envelope round-trips" {
    const encoded = try encodeAlloc(std.testing.allocator, .{
        .seq = 9,
        .cols = 80,
        .rows = 24,
        .backend_name = "fallback",
        .payload = "screen-state",
    });
    defer std.testing.allocator.free(encoded);

    var decoded = try decodeAlloc(std.testing.allocator, encoded);
    defer decoded.deinit(std.testing.allocator);

    try std.testing.expectEqual(@as(u64, 9), decoded.seq);
    try std.testing.expectEqual(@as(u16, 80), decoded.cols);
    try std.testing.expectEqual(@as(u16, 24), decoded.rows);
    try std.testing.expectEqualStrings("fallback", decoded.backend_name);
    try std.testing.expectEqualStrings("screen-state", decoded.payload);
}

test "current-screen snapshot rejects corrupt payload CRC" {
    const encoded = try encodeAlloc(std.testing.allocator, .{
        .seq = 1,
        .cols = 10,
        .rows = 4,
        .backend_name = "fallback",
        .payload = "state",
    });
    defer std.testing.allocator.free(encoded);

    encoded[encoded.len - 1] ^= 0xff;
    try std.testing.expectError(error.InvalidSnapshot, decodeAlloc(std.testing.allocator, encoded));
}

test "current-screen snapshot file store reads and deletes state" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const path = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/{s}", .{ tmp.sub_path, file_name });
    defer std.testing.allocator.free(path);

    const meta = try writeCurrentScreenPath(std.testing.allocator, path, .{
        .seq = 3,
        .cols = 12,
        .rows = 5,
        .backend_name = "fallback",
        .payload = "visible",
    });
    try std.testing.expectEqual(@as(u64, 3), meta.seq);
    try std.testing.expect(meta.size > 0);

    var decoded = (try readCurrentScreenPath(std.testing.allocator, path)).?;
    defer decoded.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("visible", decoded.payload);

    try deleteCurrentScreenPath(path);
    try std.testing.expect((try readCurrentScreenPath(std.testing.allocator, path)) == null);
}
