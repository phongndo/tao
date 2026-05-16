const std = @import("std");
const event_log = @import("event_log.zig");
const pty = @import("pty.zig");
const rpc = @import("rpc.zig");

pub const max_pending_output_bytes = 1024 * 1024;

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
};

pub const TerminalSession = struct {
    id: []const u8,
    terminal_id: []const u8,
    cwd: ?[]const u8,
    session_dir: ?[]const u8,
    event_log_path: ?[]const u8,
    excerpt_path: ?[]const u8,
    subscribers: std.ArrayList(std.c.fd_t),
    pending_output: std.ArrayList(PendingOutputFrame),
    pending_output_bytes: usize,
    pty_child: ?pty.Child,
    cols: u16,
    rows: u16,
    status: Status,
    last_seq: u64,
    reader_started: bool,

    pub fn deinit(self: *TerminalSession, allocator: std.mem.Allocator) void {
        if (self.pty_child) |*child| child.close();
        allocator.free(self.id);
        allocator.free(self.terminal_id);
        if (self.cwd) |cwd| allocator.free(cwd);
        if (self.session_dir) |path| allocator.free(path);
        if (self.event_log_path) |path| allocator.free(path);
        if (self.excerpt_path) |path| allocator.free(path);
        self.subscribers.deinit(allocator);
        self.clearPendingOutput(allocator);
        self.pending_output.deinit(allocator);
        self.* = undefined;
    }

    pub fn installPersistence(self: *TerminalSession, allocator: std.mem.Allocator, files: event_log.SessionFiles) void {
        if (self.session_dir) |path| allocator.free(path);
        if (self.event_log_path) |path| allocator.free(path);
        if (self.excerpt_path) |path| allocator.free(path);

        self.session_dir = files.dir;
        self.event_log_path = files.event_log_path;
        self.excerpt_path = files.excerpt_path;
        self.last_seq = files.last_seq;
    }

    pub fn bufferPendingOutput(self: *TerminalSession, allocator: std.mem.Allocator, seq: u64, payload: []const u8) !void {
        if (payload.len == 0) return;

        const owned = try allocator.dupe(u8, payload);
        errdefer allocator.free(owned);
        try self.pending_output.append(allocator, .{ .seq = seq, .payload = owned });
        self.pending_output_bytes += owned.len;

        while (self.pending_output_bytes > max_pending_output_bytes and self.pending_output.items.len > 1) {
            var frame = self.pending_output.orderedRemove(0);
            self.pending_output_bytes -= frame.payload.len;
            frame.deinit(allocator);
        }
    }

    pub fn clearPendingOutput(self: *TerminalSession, allocator: std.mem.Allocator) void {
        for (self.pending_output.items) |*frame| frame.deinit(allocator);
        self.pending_output.clearRetainingCapacity();
        self.pending_output_bytes = 0;
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
        for (self.sessions.items) |*item| item.deinit(self.allocator);
        self.sessions.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn create(self: *Manager, input: rpc.CreateRequest) !*TerminalSession {
        const id = try self.allocator.dupe(u8, input.session_id);
        errdefer self.allocator.free(id);
        const terminal_id = try self.allocator.dupe(u8, input.terminal_id);
        errdefer self.allocator.free(terminal_id);
        const cwd = if (input.cwd) |value| try self.allocator.dupe(u8, value) else null;
        errdefer if (cwd) |value| self.allocator.free(value);

        try self.sessions.append(self.allocator, .{
            .id = id,
            .terminal_id = terminal_id,
            .cwd = cwd,
            .session_dir = null,
            .event_log_path = null,
            .excerpt_path = null,
            .subscribers = .empty,
            .pending_output = .empty,
            .pending_output_bytes = 0,
            .pty_child = null,
            .cols = input.cols,
            .rows = input.rows,
            .status = .live,
            .last_seq = 0,
            .reader_started = false,
        });
        return &self.sessions.items[self.sessions.items.len - 1];
    }

    pub fn find(self: *Manager, session_id: []const u8) ?*TerminalSession {
        for (self.sessions.items) |*item| {
            if (std.mem.eql(u8, item.id, session_id)) return item;
        }
        return null;
    }

    pub fn detach(self: *Manager, session_id: []const u8) bool {
        const item = self.find(session_id) orelse return false;
        if (item.status == .live and item.subscribers.items.len == 0) item.status = .detached;
        return true;
    }

    pub fn attach(self: *Manager, session_id: []const u8) ?*TerminalSession {
        const item = self.find(session_id) orelse return null;
        if (item.status == .detached) item.status = .live;
        return item;
    }

    pub fn addSubscriber(self: *Manager, session_id: []const u8, fd: std.c.fd_t) !bool {
        const item = self.find(session_id) orelse return false;
        for (item.subscribers.items) |existing| {
            if (existing == fd) return true;
        }
        try item.subscribers.append(self.allocator, fd);
        if (item.status == .detached) item.status = .live;
        return true;
    }

    pub fn removeSubscriber(self: *Manager, session_id: []const u8, fd: std.c.fd_t) bool {
        const item = self.find(session_id) orelse return false;
        var index: usize = 0;
        while (index < item.subscribers.items.len) : (index += 1) {
            if (item.subscribers.items[index] != fd) continue;
            _ = item.subscribers.orderedRemove(index);
            if (item.subscribers.items.len == 0 and item.status == .live) item.status = .detached;
            return true;
        }
        if (item.subscribers.items.len == 0 and item.status == .live) item.status = .detached;
        return true;
    }

    pub fn resize(self: *Manager, session_id: []const u8, cols: u16, rows: u16) bool {
        const item = self.find(session_id) orelse return false;
        item.cols = cols;
        item.rows = rows;
        return true;
    }

    pub fn kill(self: *Manager, session_id: []const u8) bool {
        const item = self.find(session_id) orelse return false;
        item.status = .killed;
        return true;
    }
};

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
    try std.testing.expect(manager.kill("session-1"));
    try std.testing.expectEqualStrings("killed", manager.find("session-1").?.status.text());
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
