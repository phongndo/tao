const std = @import("std");

pub const file_magic = [_]u8{ 0x54, 0x41, 0x4f, 0x45, 0x56, 0x00, 0x01, 0x00 }; // TAOEV\0\1\0
pub const frame_magic: u32 = 0x54414546; // TAEF
pub const frame_header_size: usize = 32;
pub const max_payload_bytes: u32 = 64 * 1024 * 1024;

pub const FrameKind = enum(u16) {
    output = 1,
    input = 2,
    resize = 3,
    title = 4,
    cwd = 5,
    agent_event = 6,
    snapshot_mark = 7,
    exit = 8,
    _,
};

pub const Frame = struct {
    kind: FrameKind,
    seq: u64,
    monotonic_ms: u64,
    payload: []const u8,
};

pub const ParseResult = struct {
    valid_bytes: usize,
    frames_seen: usize,
};

pub fn encodedFrameSize(payload_len: usize) usize {
    return frame_header_size + payload_len;
}

pub fn encodeFrame(
    out: []u8,
    kind: FrameKind,
    seq: u64,
    monotonic_ms: u64,
    payload: []const u8,
) ![]u8 {
    if (payload.len > max_payload_bytes) return error.PayloadTooLarge;
    const total_len = encodedFrameSize(payload.len);
    if (out.len < total_len) return error.NoSpaceLeft;

    std.mem.writeInt(u32, out[0..4], frame_magic, .big);
    std.mem.writeInt(u16, out[4..6], 1, .big);
    std.mem.writeInt(u16, out[6..8], @intFromEnum(kind), .big);
    std.mem.writeInt(u64, out[8..16], seq, .big);
    std.mem.writeInt(u64, out[16..24], monotonic_ms, .big);
    std.mem.writeInt(u32, out[24..28], @intCast(payload.len), .big);
    std.mem.writeInt(u32, out[28..32], std.hash.Crc32.hash(payload), .big);
    @memcpy(out[frame_header_size..total_len], payload);

    return out[0..total_len];
}

pub fn parseFrames(data: []const u8, visitor: anytype) !ParseResult {
    var offset: usize = 0;
    var valid_bytes: usize = 0;
    var frames_seen: usize = 0;
    var last_seq: u64 = 0;

    while (offset + frame_header_size <= data.len) {
        if (std.mem.readInt(u32, data[offset..][0..4], .big) != frame_magic) break;

        const version = std.mem.readInt(u16, data[offset + 4 ..][0..2], .big);
        const kind_raw = std.mem.readInt(u16, data[offset + 6 ..][0..2], .big);
        const seq = std.mem.readInt(u64, data[offset + 8 ..][0..8], .big);
        const monotonic_ms = std.mem.readInt(u64, data[offset + 16 ..][0..8], .big);
        const length = std.mem.readInt(u32, data[offset + 24 ..][0..4], .big);
        const expected_crc = std.mem.readInt(u32, data[offset + 28 ..][0..4], .big);
        const payload_start = offset + frame_header_size;
        const payload_end = payload_start + length;

        if (version != 1 or length > max_payload_bytes or payload_end > data.len) break;

        const payload = data[payload_start..payload_end];
        if (seq > last_seq and std.hash.Crc32.hash(payload) == expected_crc) {
            try visitor.visit(.{
                .kind = @enumFromInt(kind_raw),
                .seq = seq,
                .monotonic_ms = monotonic_ms,
                .payload = payload,
            });
            frames_seen += 1;
            last_seq = seq;
        }

        offset = payload_end;
        valid_bytes = offset;
    }

    return .{ .valid_bytes = valid_bytes, .frames_seen = frames_seen };
}

test "event log encodes and parses framed payloads" {
    var buffer: [128]u8 = undefined;
    const encoded = try encodeFrame(&buffer, .output, 1, 42, "ok");

    var recorder = struct {
        count: usize = 0,
        last_seq: u64 = 0,
        pub fn visit(self: *@This(), frame: Frame) !void {
            self.count += 1;
            self.last_seq = frame.seq;
            try std.testing.expectEqual(FrameKind.output, frame.kind);
            try std.testing.expectEqualStrings("ok", frame.payload);
        }
    }{};

    const result = try parseFrames(encoded, &recorder);
    try std.testing.expectEqual(encoded.len, result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
    try std.testing.expectEqual(@as(u64, 1), recorder.last_seq);
}

test "event log rejects corrupt CRC payloads without treating tails as valid" {
    var buffer: [128]u8 = undefined;
    const encoded = try encodeFrame(&buffer, .output, 1, 42, "bad");
    buffer[frame_header_size] ^= 0xff;

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), _: Frame) !void {
            self.count += 1;
        }
    }{};

    const result = try parseFrames(encoded, &recorder);
    try std.testing.expectEqual(@as(usize, 0), recorder.count);
    try std.testing.expectEqual(encoded.len, result.valid_bytes);
}
