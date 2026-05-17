const std = @import("std");

const assert = std.debug.assert;

/// Central resource budgets for the Zig daemon. These are deliberately high
/// enough to avoid changing normal Tao behavior, but explicit so accidental
/// unbounded growth is reviewed in one place.
pub const sessions_max = 16 * 1024;
pub const subscribers_per_session_max = 1024;
pub const pending_output_frames_max = 4096;
pub const pending_output_bytes_max = 1024 * 1024;
pub const pending_client_bytes_max = 1024 * 1024;
pub const session_dirs_scan_max = 64 * 1024;
pub const db_event_log_refs_max = 64 * 1024;
pub const db_search_results_max = 1024;

/// Wire/file format payload limits. These must remain compatible with already
/// persisted event logs, snapshots, and live stream clients.
pub const event_log_payload_bytes_max: u32 = 64 * 1024 * 1024;
pub const event_log_replay_bytes_max: usize = 1024 * 1024;
pub const event_log_excerpt_bytes_max: usize = 1024 * 1024;
pub const stream_payload_bytes_max: u32 = 64 * 1024 * 1024;
pub const snapshot_backend_name_bytes_max: usize = 128;
pub const snapshot_payload_bytes_max: usize = 16 * 1024 * 1024;

comptime {
    assert(sessions_max > 0);
    assert(subscribers_per_session_max > 0);
    assert(pending_output_frames_max > 0);
    assert(pending_output_bytes_max > 0);
    assert(pending_client_bytes_max > 0);
    assert(session_dirs_scan_max > 0);
    assert(db_event_log_refs_max > 0);
    assert(db_search_results_max > 0);
    assert(event_log_payload_bytes_max > 0);
    assert(event_log_replay_bytes_max > 0);
    assert(event_log_excerpt_bytes_max > 0);
    assert(stream_payload_bytes_max > 0);
    assert(snapshot_backend_name_bytes_max > 0);
    assert(snapshot_payload_bytes_max > 0);
}
