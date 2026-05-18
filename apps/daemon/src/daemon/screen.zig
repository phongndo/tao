const std = @import("std");
const event_log = @import("../event_log.zig");
const rpc = @import("../rpc.zig");
const session = @import("../session.zig");
const snapshot = @import("../snapshot.zig");
const vt = @import("../vt.zig");

const fd_io = @import("fd_io.zig");
const types = @import("types.zig");
const util = @import("util.zig");

const CurrentScreenCheckpoint = types.CurrentScreenCheckpoint;

const writeAllFd = fd_io.writeAllFd;

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
    if (meta.seq < current.snapshot_seq) return;

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

pub fn sendCurrentScreenSnapshotToSubscriber(self: anytype, session_id: []const u8, socket_fd: std.c.fd_t) !void {
    const SnapshotFrame = struct {
        fd: std.posix.fd_t,
        encoded: []u8,
    };

    const frame = frame: {
        self.lock();
        defer self.unlock();

        const item = self.sessions.find(session_id) orelse return error.SessionNotFound;
        if (!util.isLiveAttachable(item)) return error.SessionNotAttached;
        const snapshot_payload = (try item.currentScreenSnapshotAlloc(self.allocator)) orelse break :frame null;
        defer self.allocator.free(snapshot_payload);

        const duplicated_fd = try std.posix.dup(socket_fd);
        errdefer std.posix.close(duplicated_fd);

        const encoded_snapshot = try snapshot.encodeAlloc(self.allocator, .{
            .seq = item.last_seq,
            .cols = item.cols,
            .rows = item.rows,
            .backend_name = vt.backend_name,
            .payload = snapshot_payload,
        });
        defer self.allocator.free(encoded_snapshot);

        const buffer = try self.allocator.alloc(u8, rpc.encodedStreamFrameSize(encoded_snapshot.len));
        errdefer self.allocator.free(buffer);
        _ = try rpc.encodeStreamFrame(buffer, .snapshot, item.id, item.last_seq, encoded_snapshot);
        break :frame SnapshotFrame{ .fd = duplicated_fd, .encoded = buffer };
    };

    const encoded = frame orelse return;
    defer std.posix.close(encoded.fd);
    defer self.allocator.free(encoded.encoded);
    try writeAllFd(encoded.fd, encoded.encoded);
}
