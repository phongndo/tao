const std = @import("std");
const session = @import("../session.zig");
const protocol = @import("protocol.zig");
const util = @import("util.zig");

/// Daemon invariants shared by the split subsystem modules:
///
/// * `*Locked` functions are entered with `Daemon.mutex` held and must return
///   with it held. They may temporarily release it only around blocking IO,
///   SQLite, adapter, or filesystem work, and must snapshot any heap-owned data
///   needed after release.
/// * `TerminalSession` is the authoritative in-memory state machine. Persistent
///   database/event-log rows are recovery indexes, not a replacement for live
///   session invariants.
/// * Stream subscribers are best-effort after initial hydration: slow live
///   subscribers may be dropped, but pending output and current-screen snapshots
///   remain bounded and explicit.
/// * Persistence privacy is fail-closed for input: input frames are written only
///   when both persistence and `persist_input` are enabled.
///
/// Keep this file dependency-light; it is imported by most daemon subsystems.
pub const PersistencePolicy = struct {
    enabled: bool = true,
    persist_input: bool = false,
};

pub const PersistenceSettingsJson = struct {
    enabled: ?bool = null,
    persistInput: ?bool = null,
    persist_input: ?bool = null,
};

pub const SettingsJson = struct {
    persistence: ?PersistenceSettingsJson = null,
};

pub const RestoreResult = struct {
    item: *session.TerminalSession,
    attach_kind: protocol.AttachKind,
    agent_provider: ?[]u8 = null,
    native_session_id: ?[]u8 = null,

    pub fn deinit(self: *RestoreResult, allocator: std.mem.Allocator) void {
        if (self.agent_provider) |value| allocator.free(value);
        if (self.native_session_id) |value| allocator.free(value);
        self.* = undefined;
    }
};

pub const AgentDetectionSnapshot = struct {
    terminal_session_id: []u8,
    session_dir: ?[]u8,
    event_log_path: ?[]u8,
    excerpt_path: ?[]u8,
    cwd: ?[]u8,
    argv: []const []const u8,
    original_argv_json: ?[]u8,
    status: []const u8,

    pub fn deinit(self: *AgentDetectionSnapshot, allocator: std.mem.Allocator) void {
        allocator.free(self.terminal_session_id);
        if (self.session_dir) |value| allocator.free(value);
        if (self.event_log_path) |value| allocator.free(value);
        if (self.excerpt_path) |value| allocator.free(value);
        if (self.cwd) |value| allocator.free(value);
        for (self.argv) |arg| allocator.free(arg);
        allocator.free(self.argv);
        if (self.original_argv_json) |value| allocator.free(value);
        self.* = undefined;
    }
};

pub const SearchExcerptSnapshot = struct {
    terminal_session_id: []u8,
    title: []u8,
    excerpt_path: []u8,

    pub fn deinit(self: *SearchExcerptSnapshot, allocator: std.mem.Allocator) void {
        allocator.free(self.terminal_session_id);
        allocator.free(self.title);
        allocator.free(self.excerpt_path);
        self.* = undefined;
    }
};

pub const CurrentScreenCheckpoint = struct {
    session_id: []u8,
    snapshot_path: []u8,
    payload: []u8,
    seq: u64,
    cols: u16,
    rows: u16,

    pub fn deinit(self: *CurrentScreenCheckpoint, allocator: std.mem.Allocator) void {
        allocator.free(self.session_id);
        allocator.free(self.snapshot_path);
        allocator.free(self.payload);
        self.* = undefined;
    }
};
