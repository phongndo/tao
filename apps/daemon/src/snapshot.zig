const std = @import("std");

pub const Metadata = struct {
    seq: u64,
    crc32: u32,
    size: usize,
};

pub fn metadata(seq: u64, bytes: []const u8) Metadata {
    return .{ .seq = seq, .crc32 = std.hash.Crc32.hash(bytes), .size = bytes.len };
}

test "snapshot metadata records crc and size" {
    const meta = metadata(7, "state");
    try std.testing.expectEqual(@as(u64, 7), meta.seq);
    try std.testing.expectEqual(@as(usize, 5), meta.size);
    try std.testing.expectEqual(std.hash.Crc32.hash("state"), meta.crc32);
}
