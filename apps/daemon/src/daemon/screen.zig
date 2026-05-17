const std = @import("std");
const adapter = @import("../adapter.zig");
const cleanup = @import("../cleanup.zig");
const db = @import("../db.zig");
const event_log = @import("../event_log.zig");
const pty = @import("../pty.zig");
const rpc = @import("../rpc.zig");
const session = @import("../session.zig");
const snapshot = @import("../snapshot.zig");
const vt = @import("../vt.zig");

const fd_io = @import("fd_io.zig");
const protocol = @import("protocol.zig");
const util = @import("util.zig");
const types = @import("types.zig");

const AttachKind = protocol.AttachKind;
const SessionResponseMetadata = protocol.SessionResponseMetadata;
const RestoreResult = types.RestoreResult;
const AgentDetectionSnapshot = types.AgentDetectionSnapshot;
const SearchExcerptSnapshot = types.SearchExcerptSnapshot;
const CurrentScreenCheckpoint = types.CurrentScreenCheckpoint;
const SettingsJson = types.SettingsJson;

const readControlPayload = fd_io.readControlPayload;
const setNonBlockingFd = fd_io.setNonBlockingFd;
const writeAllFd = fd_io.writeAllFd;
const writeAllFdNonBlocking = fd_io.writeAllFdNonBlocking;
const fileExists = util.fileExists;
const readSmallFileAlloc = util.readSmallFileAlloc;
const generateSessionId = util.generateSessionId;
const argvJsonAlloc = util.argvJsonAlloc;
const parseArgvJson = util.parseArgvJson;
const isLiveAttachable = util.isLiveAttachable;
const isResumableAgentStatus = util.isResumableAgentStatus;
const missingField = protocol.missingField;
const notFound = protocol.notFound;
const sessionResponse = protocol.sessionResponse;

pub fn checkpointCurrentScreenLocked(self: anytype, item: *session.TerminalSession) void {
    var checkpoint = (self.currentScreenCheckpointLocked(item) catch |err| {
        std.log.warn("failed to prepare current-screen snapshot for {s}: {t}", .{ item.id, err });
        return;
    }) orelse return;
    defer checkpoint.deinit(self.allocator);

    self.unlock();
    const meta = snapshot.writeCurrentScreenPath(self.allocator, checkpoint.snapshot_path, .{
        .seq = checkpoint.seq,
        .cols = checkpoint.cols,
        .rows = checkpoint.rows,
        .backend_name = vt.backend_name,
        .payload = checkpoint.payload,
    }) catch |err| {
        self.lock();
        std.log.warn("failed to write current-screen snapshot for {s}: {t}", .{ checkpoint.session_id, err });
        return;
    };
    self.lock();

    if (!self.persistence.enabled) return;
    const current = self.sessions.find(checkpoint.session_id) orelse return;
    const current_snapshot_path = current.snapshot_path orelse return;
    if (!std.mem.eql(u8, current_snapshot_path, checkpoint.snapshot_path)) return;

    current.snapshot_seq = meta.seq;
    current.snapshot_crc32 = meta.crc32;
    current.snapshot_size = meta.size;

    if (current.event_log_path) |event_log_path| {
        _ = event_log.appendSnapshotMark(self.allocator, event_log_path, &current.last_seq, meta.seq, current_snapshot_path) catch |err| {
            std.log.warn("failed to append snapshot mark for {s}: {t}", .{ current.id, err });
        };
    }
}

pub fn currentScreenCheckpointLocked(self: anytype, item: *const session.TerminalSession) !?CurrentScreenCheckpoint {
    if (!self.persistence.enabled) return null;
    const snapshot_path = item.snapshot_path orelse return null;
    const payload = try item.currentScreenSnapshotAlloc(self.allocator);
    const snapshot_payload = payload orelse return null;
    errdefer self.allocator.free(snapshot_payload);

    const session_id = try self.allocator.dupe(u8, item.id);
    errdefer self.allocator.free(session_id);
    const owned_snapshot_path = try self.allocator.dupe(u8, snapshot_path);

    return .{
        .session_id = session_id,
        .snapshot_path = owned_snapshot_path,
        .payload = snapshot_payload,
        .seq = item.last_seq,
        .cols = item.cols,
        .rows = item.rows,
    };
}

pub fn clearSnapshotFileLocked(self: anytype, item: *session.TerminalSession) void {
    _ = self;
    if (item.snapshot_path) |path| {
        snapshot.deleteCurrentScreenPath(path) catch |err| {
            std.log.warn("failed to delete current-screen snapshot for {s}: {t}", .{ item.id, err });
        };
    }
    item.clearSnapshotMetadata();
}

pub fn sendCurrentScreenSnapshotToSubscriberLocked(self: anytype, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
    const payload = try item.currentScreenSnapshotAlloc(self.allocator);
    const snapshot_payload = payload orelse return;
    defer self.allocator.free(snapshot_payload);

    const encoded_snapshot = try snapshot.encodeAlloc(self.allocator, .{
        .seq = item.last_seq,
        .cols = item.cols,
        .rows = item.rows,
        .backend_name = vt.backend_name,
        .payload = snapshot_payload,
    });
    defer self.allocator.free(encoded_snapshot);

    const encoded_len = rpc.encodedStreamFrameSize(encoded_snapshot.len);
    const buffer = try self.allocator.alloc(u8, encoded_len);
    defer self.allocator.free(buffer);

    const encoded = try rpc.encodeStreamFrame(buffer, .snapshot, item.id, item.last_seq, encoded_snapshot);
    try writeAllFd(socket_fd, encoded);
}
