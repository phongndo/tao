const std = @import("std");
const event_log = @import("event_log.zig");
const limits = @import("limits.zig");
const pty = @import("pty.zig");
const rpc = @import("rpc.zig");
const snapshot = @import("snapshot.zig");
const vt = @import("vt.zig");

const assert = std.debug.assert;

pub const sessions_max = limits.sessions_max;
pub const subscribers_per_session_max = limits.subscribers_per_session_max;
pub const pending_output_frames_max = limits.pending_output_frames_max;
pub const max_pending_output_bytes = limits.pending_output_bytes_max;

comptime {
    assert(sessions_max > 0);
    assert(subscribers_per_session_max > 0);
    assert(pending_output_frames_max > 0);
    assert(max_pending_output_bytes > 0);
}

pub const PendingOutputFrame = struct {
    seq: u64,
    payload: []u8,

    pub fn deinit(self: *PendingOutputFrame, allocator: std.mem.Allocator) void {
        allocator.free(self.payload);
        self.* = undefined;
    }
};

pub const Status = enum {
    live,
    detached,
    exited,
    crashed,
    archived,
    killed,

    pub fn text(self: Status) []const u8 {
        return switch (self) {
            .live => "live",
            .detached => "detached",
            .exited => "exited",
            .crashed => "crashed",
            .archived => "archived",
            .killed => "killed",
        };
    }

    /// Terminal sessions are durable state machines: callers may retry create,
    /// attach, detach, restore, and kill requests after crashes or UI reconnects.
    /// The graph is therefore intentionally permissive for recovery edges while
    /// still making every transition explicit at the call site.
    pub fn canTransitionTo(self: Status, next: Status) bool {
        if (self == next) return true;
        return switch (self) {
            .live => next == .detached or next == .exited or next == .crashed or next == .killed,
            .detached => next == .live or next == .exited or next == .crashed or next == .archived or next == .killed,
            .exited => next == .live or next == .archived or next == .killed,
            .crashed => next == .live or next == .archived or next == .killed,
            .archived => next == .live or next == .killed,
            .killed => next == .live or next == .archived,
        };
    }
};

pub const TerminalSession = struct {
    id: []const u8,
    terminal_id: []const u8,
    workspace_id: ?[]const u8,
    worktree_id: ?[]const u8,
    cwd: ?[]const u8,
    session_dir: ?[]const u8,
    event_log_path: ?[]const u8,
    excerpt_path: ?[]const u8,
    snapshot_path: ?[]const u8,
    subscribers: std.ArrayList(std.c.fd_t),
    pending_output: std.ArrayList(PendingOutputFrame),
    pending_output_bytes: usize,
    pty_child: ?pty.Child,
    cols: u16,
    rows: u16,
    vt_terminal: ?vt.Terminal,
    status: Status,
    last_seq: u64,
    snapshot_seq: u64,
    snapshot_crc32: ?u32,
    snapshot_size: usize,
    reader_started: bool,

    /// These invariants are intentionally cheap enough to keep in production
    /// safety builds. The session lifecycle is Tao's central state machine;
    /// every mutating method calls this so impossible states fail near the
    /// bug instead of surfacing later as persistence or stream corruption.
    pub fn assertInvariants(self: *const TerminalSession) void {
        assert(self.id.len > 0);
        assert(self.terminal_id.len > 0);
        assert(self.cols > 0);
        assert(self.rows > 0);
        assert(self.subscribers.items.len <= subscribers_per_session_max);
        assert(self.pending_output.items.len <= pending_output_frames_max);
        if (self.status == .detached) assert(self.subscribers.items.len == 0);

        assert(self.pending_output_bytes <= max_pending_output_bytes);
        var pending_output_bytes: usize = 0;
        for (self.pending_output.items) |frame| {
            assert(frame.seq > 0);
            assert(frame.payload.len > 0);
            pending_output_bytes += frame.payload.len;
        }
        assert(self.pending_output_bytes == pending_output_bytes);

        const has_session_dir = self.session_dir != null;
        assert((self.event_log_path != null) == has_session_dir);
        assert((self.excerpt_path != null) == has_session_dir);
        assert((self.snapshot_path != null) == has_session_dir);

        if (self.pty_child) |*child| {
            child.assertInvariants();
            if (self.reader_started) {
                assert(child.master_fd >= 0);
                assert(self.status == .live or self.status == .detached);
            }
        } else {
            assert(!self.reader_started);
        }
    }

    pub fn deinit(self: *TerminalSession, allocator: std.mem.Allocator) void {
        self.assertInvariants();
        if (self.pty_child) |*child| child.close();
        if (self.vt_terminal) |*terminal| terminal.deinit(allocator);
        self.clearPendingOutput(allocator);
        self.subscribers.deinit(allocator);
        allocator.free(self.id);
        allocator.free(self.terminal_id);
        if (self.workspace_id) |value| allocator.free(value);
        if (self.worktree_id) |value| allocator.free(value);
        if (self.cwd) |cwd| allocator.free(cwd);
        if (self.session_dir) |path| allocator.free(path);
        if (self.event_log_path) |path| allocator.free(path);
        if (self.excerpt_path) |path| allocator.free(path);
        if (self.snapshot_path) |path| allocator.free(path);
        self.pending_output.deinit(allocator);
        self.* = undefined;
    }

    pub fn installPersistence(self: *TerminalSession, allocator: std.mem.Allocator, files: event_log.SessionFiles) !void {
        self.assertInvariants();
        const next_snapshot_path = try snapshot.pathAlloc(allocator, files.dir);
        errdefer allocator.free(next_snapshot_path);

        if (self.session_dir) |path| allocator.free(path);
        if (self.event_log_path) |path| allocator.free(path);
        if (self.excerpt_path) |path| allocator.free(path);
        if (self.snapshot_path) |path| allocator.free(path);

        self.session_dir = files.dir;
        self.event_log_path = files.event_log_path;
        self.excerpt_path = files.excerpt_path;
        self.snapshot_path = next_snapshot_path;
        self.last_seq = files.last_seq;
        self.assertInvariants();
    }

    pub fn disablePersistence(self: *TerminalSession, allocator: std.mem.Allocator) void {
        self.assertInvariants();
        if (self.session_dir) |path| allocator.free(path);
        if (self.event_log_path) |path| allocator.free(path);
        if (self.excerpt_path) |path| allocator.free(path);
        if (self.snapshot_path) |path| allocator.free(path);

        self.session_dir = null;
        self.event_log_path = null;
        self.excerpt_path = null;
        self.snapshot_path = null;
        self.clearSnapshotMetadata();
        self.assertInvariants();
    }

    pub fn clearSnapshotMetadata(self: *TerminalSession) void {
        self.snapshot_seq = 0;
        self.snapshot_crc32 = null;
        self.snapshot_size = 0;
    }

    pub fn transitionTo(self: *TerminalSession, status: Status) void {
        self.assertInvariants();
        assert(self.status.canTransitionTo(status));
        self.status = status;
        self.assertInvariants();
    }

    pub fn updateCreateMetadata(
        self: *TerminalSession,
        allocator: std.mem.Allocator,
        terminal_id: []const u8,
        workspace_id: ?[]const u8,
        worktree_id: ?[]const u8,
        cwd: ?[]const u8,
        cols: u16,
        rows: u16,
    ) !void {
        self.assertInvariants();
        if (terminal_id.len == 0) return error.InvalidSessionId;
        if (cols == 0 or rows == 0) return error.InvalidSize;

        if (!std.mem.eql(u8, self.terminal_id, terminal_id)) {
            const next_terminal_id = try allocator.dupe(u8, terminal_id);
            allocator.free(self.terminal_id);
            self.terminal_id = next_terminal_id;
        }

        if (!optionalTextEql(self.cwd, cwd)) {
            const next_cwd = if (cwd) |value| try allocator.dupe(u8, value) else null;
            if (self.cwd) |value| allocator.free(value);
            self.cwd = next_cwd;
        }

        if (!optionalTextEql(self.workspace_id, workspace_id)) {
            const next_workspace_id = if (workspace_id) |value| try allocator.dupe(u8, value) else null;
            if (self.workspace_id) |value| allocator.free(value);
            self.workspace_id = next_workspace_id;
        }

        if (!optionalTextEql(self.worktree_id, worktree_id)) {
            const next_worktree_id = if (worktree_id) |value| try allocator.dupe(u8, value) else null;
            if (self.worktree_id) |value| allocator.free(value);
            self.worktree_id = next_worktree_id;
        }

        try self.resizeVt(allocator, cols, rows);
        self.assertInvariants();
    }

    pub fn bufferPendingOutput(self: *TerminalSession, allocator: std.mem.Allocator, seq: u64, payload: []const u8) !void {
        self.assertInvariants();
        if (payload.len == 0) return;

        const bounded_payload = if (payload.len > max_pending_output_bytes)
            payload[payload.len - max_pending_output_bytes ..]
        else
            payload;
        const owned = try allocator.dupe(u8, bounded_payload);
        errdefer allocator.free(owned);
        try self.pending_output.append(allocator, .{ .seq = seq, .payload = owned });
        self.pending_output_bytes += owned.len;

        while ((self.pending_output_bytes > max_pending_output_bytes or
            self.pending_output.items.len > pending_output_frames_max) and
            self.pending_output.items.len > 1)
        {
            var frame = self.pending_output.orderedRemove(0);
            assert(self.pending_output_bytes >= frame.payload.len);
            self.pending_output_bytes -= frame.payload.len;
            frame.deinit(allocator);
        }
        self.assertInvariants();
    }

    pub fn clearPendingOutput(self: *TerminalSession, allocator: std.mem.Allocator) void {
        self.assertInvariants();
        for (self.pending_output.items) |*frame| frame.deinit(allocator);
        self.pending_output.clearRetainingCapacity();
        self.pending_output_bytes = 0;
        self.assertInvariants();
    }

    pub fn writeVt(self: *TerminalSession, payload: []const u8) !void {
        if (self.vt_terminal) |*terminal| try terminal.write(payload);
    }

    pub fn resizeVt(self: *TerminalSession, allocator: std.mem.Allocator, cols: u16, rows: u16) !void {
        self.assertInvariants();
        if (cols == 0 or rows == 0) return error.InvalidSize;
        if (self.vt_terminal) |*terminal| try terminal.resize(allocator, cols, rows);
        self.cols = cols;
        self.rows = rows;
        self.assertInvariants();
    }

    pub fn currentScreenTextAlloc(self: *const TerminalSession, allocator: std.mem.Allocator) !?[]u8 {
        const terminal = self.vt_terminal orelse return null;
        return try terminal.plainTextAlloc(allocator);
    }

    pub fn currentScreenSnapshotAlloc(self: *const TerminalSession, allocator: std.mem.Allocator) !?[]u8 {
        if (!vt.supports_current_screen_snapshots) return null;
        const terminal = self.vt_terminal orelse return null;
        return try terminal.serializeCurrentScreenAlloc(allocator);
    }

    pub fn restoreCurrentScreenSnapshot(self: *TerminalSession, allocator: std.mem.Allocator, payload: []const u8) !bool {
        self.assertInvariants();
        if (!vt.supports_current_screen_snapshots) return false;
        const terminal = if (self.vt_terminal) |*terminal| terminal else return false;
        try terminal.deserializeCurrentScreen(allocator, payload);
        self.cols = terminal.cols;
        self.rows = terminal.rows;
        self.assertInvariants();
        return true;
    }

    pub fn pidU32(self: *const TerminalSession) ?u32 {
        const child = self.pty_child orelse return null;
        if (child.pid <= 0) return null;
        return @intCast(child.pid);
    }
};

pub const Manager = struct {
    allocator: std.mem.Allocator,
    sessions: std.ArrayList(TerminalSession),

    pub fn init(allocator: std.mem.Allocator) Manager {
        return .{ .allocator = allocator, .sessions = .empty };
    }

    pub fn deinit(self: *Manager) void {
        assert(self.sessions.items.len <= sessions_max);
        for (self.sessions.items) |*item| item.deinit(self.allocator);
        self.sessions.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn create(self: *Manager, input: rpc.CreateRequest) !*TerminalSession {
        assert(self.sessions.items.len <= sessions_max);
        if (self.sessions.items.len >= sessions_max) return error.TooManySessions;
        if (input.session_id.len == 0 or input.terminal_id.len == 0) return error.InvalidSessionId;
        if (input.cols == 0 or input.rows == 0) return error.InvalidSize;

        const id = try self.allocator.dupe(u8, input.session_id);
        errdefer self.allocator.free(id);
        const terminal_id = try self.allocator.dupe(u8, input.terminal_id);
        errdefer self.allocator.free(terminal_id);
        const workspace_id = if (input.workspace_id) |value| try self.allocator.dupe(u8, value) else null;
        errdefer if (workspace_id) |value| self.allocator.free(value);
        const worktree_id = if (input.worktree_id) |value| try self.allocator.dupe(u8, value) else null;
        errdefer if (worktree_id) |value| self.allocator.free(value);
        const cwd = if (input.cwd) |value| try self.allocator.dupe(u8, value) else null;
        errdefer if (cwd) |value| self.allocator.free(value);
        var vt_terminal = try vt.Terminal.init(self.allocator, input.cols, input.rows);
        errdefer vt_terminal.deinit(self.allocator);

        try self.sessions.append(self.allocator, .{
            .id = id,
            .terminal_id = terminal_id,
            .workspace_id = workspace_id,
            .worktree_id = worktree_id,
            .cwd = cwd,
            .session_dir = null,
            .event_log_path = null,
            .excerpt_path = null,
            .snapshot_path = null,
            .subscribers = .empty,
            .pending_output = .empty,
            .pending_output_bytes = 0,
            .pty_child = null,
            .cols = input.cols,
            .rows = input.rows,
            .vt_terminal = vt_terminal,
            .status = .live,
            .last_seq = 0,
            .snapshot_seq = 0,
            .snapshot_crc32 = null,
            .snapshot_size = 0,
            .reader_started = false,
        });
        const created = &self.sessions.items[self.sessions.items.len - 1];
        created.assertInvariants();
        return created;
    }

    pub fn find(self: *Manager, session_id: []const u8) ?*TerminalSession {
        for (self.sessions.items) |*item| {
            if (std.mem.eql(u8, item.id, session_id)) return item;
        }
        return null;
    }

    pub fn remove(self: *Manager, session_id: []const u8) bool {
        assert(self.sessions.items.len <= sessions_max);
        for (self.sessions.items, 0..) |*item, index| {
            if (!std.mem.eql(u8, item.id, session_id)) continue;
            var removed = self.sessions.orderedRemove(index);
            removed.deinit(self.allocator);
            return true;
        }
        return false;
    }

    pub fn detach(self: *Manager, session_id: []const u8) bool {
        const item = self.find(session_id) orelse return false;
        item.assertInvariants();
        if (item.status == .live and item.subscribers.items.len == 0) item.transitionTo(.detached);
        item.assertInvariants();
        return true;
    }

    pub fn attach(self: *Manager, session_id: []const u8) ?*TerminalSession {
        const item = self.find(session_id) orelse return null;
        item.assertInvariants();
        if (item.status == .detached) item.transitionTo(.live);
        item.assertInvariants();
        return item;
    }

    pub fn addSubscriber(self: *Manager, session_id: []const u8, fd: std.c.fd_t) !bool {
        const item = self.find(session_id) orelse return false;
        item.assertInvariants();
        for (item.subscribers.items) |existing| {
            if (existing == fd) return true;
        }
        if (item.subscribers.items.len >= subscribers_per_session_max) return error.TooManySubscribers;
        try item.subscribers.ensureUnusedCapacity(self.allocator, 1);
        if (item.status == .detached) item.transitionTo(.live);
        item.subscribers.appendAssumeCapacity(fd);
        item.assertInvariants();
        return true;
    }

    pub fn removeSubscriber(self: *Manager, session_id: []const u8, fd: std.c.fd_t) bool {
        const item = self.find(session_id) orelse return false;
        item.assertInvariants();
        var index: usize = 0;
        while (index < item.subscribers.items.len) : (index += 1) {
            if (item.subscribers.items[index] != fd) continue;
            _ = item.subscribers.orderedRemove(index);
            if (item.subscribers.items.len == 0 and item.status == .live) item.transitionTo(.detached);
            item.assertInvariants();
            return true;
        }
        if (item.subscribers.items.len == 0 and item.status == .live) item.transitionTo(.detached);
        item.assertInvariants();
        return true;
    }

    pub fn hasSubscriber(self: *Manager, session_id: []const u8, fd: std.c.fd_t) bool {
        const item = self.find(session_id) orelse return false;
        for (item.subscribers.items) |existing| {
            if (existing == fd) return true;
        }
        return false;
    }

    pub fn resize(self: *Manager, session_id: []const u8, cols: u16, rows: u16) bool {
        const item = self.find(session_id) orelse return false;
        item.resizeVt(self.allocator, cols, rows) catch return false;
        return true;
    }

    pub fn kill(self: *Manager, session_id: []const u8) bool {
        const item = self.find(session_id) orelse return false;
        item.assertInvariants();
        item.transitionTo(.killed);
        item.assertInvariants();
        return true;
    }
};

fn optionalTextEql(lhs: ?[]const u8, rhs: ?[]const u8) bool {
    if (lhs == null and rhs == null) return true;
    if (lhs == null or rhs == null) return false;
    return std.mem.eql(u8, lhs.?, rhs.?);
}

test "session manager creates and updates sessions" {
    var manager = Manager.init(std.testing.allocator);
    defer manager.deinit();

    const created = try manager.create(.{
        .session_id = "session-1",
        .terminal_id = "term-1",
        .cols = 80,
        .rows = 24,
        .cwd = null,
        .argv = &.{},
    });

    try std.testing.expectEqual(Status.live, created.status);
    try std.testing.expect(manager.resize("session-1", 120, 40));
    try std.testing.expectEqual(@as(u16, 120), manager.find("session-1").?.cols);
    try std.testing.expect(manager.detach("session-1"));
    try std.testing.expectEqual(Status.detached, manager.find("session-1").?.status);
    try std.testing.expect(manager.attach("session-1") != null);
    try std.testing.expectEqual(Status.live, manager.find("session-1").?.status);
    try std.testing.expect(try manager.addSubscriber("session-1", 42));
    try std.testing.expect(manager.hasSubscriber("session-1", 42));
    try std.testing.expect(manager.removeSubscriber("session-1", 42));
    try std.testing.expect(!manager.hasSubscriber("session-1", 42));
    try std.testing.expect(manager.kill("session-1"));
    try std.testing.expectEqualStrings("killed", manager.find("session-1").?.status.text());
    try std.testing.expect(manager.remove("session-1"));
    try std.testing.expect(manager.find("session-1") == null);
}

test "terminal session lifecycle transition table is explicit" {
    const allowed = [_]struct { from: Status, to: Status }{
        .{ .from = .live, .to = .detached },
        .{ .from = .live, .to = .exited },
        .{ .from = .live, .to = .crashed },
        .{ .from = .live, .to = .killed },
        .{ .from = .detached, .to = .live },
        .{ .from = .detached, .to = .exited },
        .{ .from = .detached, .to = .crashed },
        .{ .from = .detached, .to = .archived },
        .{ .from = .detached, .to = .killed },
        .{ .from = .exited, .to = .live },
        .{ .from = .exited, .to = .archived },
        .{ .from = .exited, .to = .killed },
        .{ .from = .crashed, .to = .live },
        .{ .from = .crashed, .to = .archived },
        .{ .from = .crashed, .to = .killed },
        .{ .from = .archived, .to = .live },
        .{ .from = .archived, .to = .killed },
        .{ .from = .killed, .to = .live },
        .{ .from = .killed, .to = .archived },
    };

    inline for (std.meta.fields(Status)) |from_field| {
        inline for (std.meta.fields(Status)) |to_field| {
            const from: Status = @enumFromInt(from_field.value);
            const to: Status = @enumFromInt(to_field.value);
            var expected = from == to;
            for (allowed) |edge| {
                if (edge.from == from and edge.to == to) expected = true;
            }
            try std.testing.expectEqual(expected, from.canTransitionTo(to));
        }
    }
}

test "terminal session create metadata can be refreshed for restart fallback" {
    var manager = Manager.init(std.testing.allocator);
    defer manager.deinit();

    const created = try manager.create(.{
        .session_id = "session-refresh",
        .terminal_id = "term-old",
        .cols = 80,
        .rows = 24,
        .cwd = "/old",
        .argv = &.{},
    });

    try created.updateCreateMetadata(std.testing.allocator, "term-new", null, null, "/new", 100, 40);
    try std.testing.expectEqualStrings("term-new", created.terminal_id);
    try std.testing.expectEqualStrings("/new", created.cwd.?);
    try std.testing.expectEqual(@as(u16, 100), created.cols);
    try std.testing.expectEqual(@as(u16, 40), created.rows);
}

test "terminal session keeps bounded pending output for first live attach" {
    var manager = Manager.init(std.testing.allocator);
    defer manager.deinit();

    const created = try manager.create(.{
        .session_id = "session-pending",
        .terminal_id = "term-pending",
        .cols = 80,
        .rows = 24,
        .cwd = null,
        .argv = &.{},
    });

    try created.bufferPendingOutput(std.testing.allocator, 1, "hello");
    try created.bufferPendingOutput(std.testing.allocator, 2, " world");

    try std.testing.expectEqual(@as(usize, 2), created.pending_output.items.len);
    try std.testing.expectEqual(@as(usize, 11), created.pending_output_bytes);
    try std.testing.expectEqual(@as(u64, 1), created.pending_output.items[0].seq);

    created.clearPendingOutput(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), created.pending_output.items.len);
    try std.testing.expectEqual(@as(usize, 0), created.pending_output_bytes);
}

test "terminal session bounds a single oversized pending-output frame" {
    var manager = Manager.init(std.testing.allocator);
    defer manager.deinit();

    const created = try manager.create(.{
        .session_id = "session-big-pending",
        .terminal_id = "term-big-pending",
        .cols = 80,
        .rows = 24,
        .cwd = null,
        .argv = &.{},
    });

    const oversized_len = max_pending_output_bytes + 257;
    const oversized = try std.testing.allocator.alloc(u8, oversized_len);
    defer std.testing.allocator.free(oversized);
    @memset(oversized[0 .. oversized.len - 1], 'a');
    oversized[oversized.len - 1] = 'z';

    try created.bufferPendingOutput(std.testing.allocator, 42, oversized);

    try std.testing.expectEqual(@as(usize, 1), created.pending_output.items.len);
    try std.testing.expectEqual(@as(usize, max_pending_output_bytes), created.pending_output_bytes);
    try std.testing.expectEqual(@as(u64, 42), created.pending_output.items[0].seq);
    try std.testing.expectEqual(@as(u8, 'z'), created.pending_output.items[0].payload[created.pending_output.items[0].payload.len - 1]);
}

test "terminal session bounds pending output frame count" {
    var manager = Manager.init(std.testing.allocator);
    defer manager.deinit();

    const created = try manager.create(.{
        .session_id = "session-many-pending",
        .terminal_id = "term-many-pending",
        .cols = 80,
        .rows = 24,
        .cwd = null,
        .argv = &.{},
    });

    var seq: u64 = 1;
    while (seq <= pending_output_frames_max + 10) : (seq += 1) {
        try created.bufferPendingOutput(std.testing.allocator, seq, "x");
    }

    try std.testing.expectEqual(@as(usize, pending_output_frames_max), created.pending_output.items.len);
    try std.testing.expectEqual(@as(usize, pending_output_frames_max), created.pending_output_bytes);
    try std.testing.expectEqual(@as(u64, 11), created.pending_output.items[0].seq);
}

test "terminal session owns VT state for output and resize" {
    var manager = Manager.init(std.testing.allocator);
    defer manager.deinit();

    const created = try manager.create(.{
        .session_id = "session-vt",
        .terminal_id = "term-vt",
        .cols = 10,
        .rows = 3,
        .cwd = null,
        .argv = &.{},
    });

    try created.writeVt("abc\r\n\x1b[2;4Hvt");
    try std.testing.expect(manager.resize("session-vt", 12, 4));

    const text = (try created.currentScreenTextAlloc(std.testing.allocator)).?;
    defer std.testing.allocator.free(text);

    try std.testing.expect(std.mem.indexOf(u8, text, "abc") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "   vt") != null);
    try std.testing.expectEqual(@as(u16, 12), created.cols);
    try std.testing.expectEqual(@as(u16, 4), created.rows);
}

fn sessionCreateForAllocationFailure(allocator: std.mem.Allocator) !void {
    var manager = Manager.init(allocator);
    defer manager.deinit();

    const created = try manager.create(.{
        .session_id = "session-oom",
        .terminal_id = "term-oom",
        .cols = 20,
        .rows = 5,
        .cwd = "/tmp/tao-session-oom",
        .argv = &.{},
    });
    try created.bufferPendingOutput(allocator, 1, "owned pending output");
    try created.updateCreateMetadata(allocator, "term-oom-2", null, null, "/tmp/next", 24, 6);
    try std.testing.expect(manager.remove("session-oom"));
}

test "session creation and owned buffers clean up on OOM" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        sessionCreateForAllocationFailure,
        .{},
    );
}
