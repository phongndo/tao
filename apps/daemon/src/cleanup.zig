const std = @import("std");

pub const RetentionPolicy = struct {
    retain_days: u32 = 30,
    max_session_bytes: u64 = 2 * 1024 * 1024 * 1024,
};

pub fn shouldDeleteArchived(now_ms: i64, last_activity_ms: i64, policy: RetentionPolicy) bool {
    if (policy.retain_days == 0) return true;
    const retain_ms: i64 = @as(i64, policy.retain_days) * 24 * 60 * 60 * 1000;
    return now_ms - last_activity_ms > retain_ms;
}

test "retention policy removes sessions older than retain window" {
    const day_ms: i64 = 24 * 60 * 60 * 1000;
    try std.testing.expect(shouldDeleteArchived(10 * day_ms, 0, .{ .retain_days = 1 }));
    try std.testing.expect(!shouldDeleteArchived(day_ms, 0, .{ .retain_days = 2 }));
}
