const std = @import("std");
const event_log = @import("event_log.zig");
const pty = @import("pty.zig");
const rpc = @import("rpc.zig");

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
    pty_child: ?pty.Child,
    cols: u16,
    rows: u16,
    status: Status,
    last_seq: u64,

    pub fn deinit(self: *TerminalSession, allocator: std.mem.Allocator) void {
        if (self.pty_child) |*child| child.close();
        allocator.free(self.id);
        allocator.free(self.terminal_id);
        if (self.cwd) |cwd| allocator.free(cwd);
        if (self.session_dir) |path| allocator.free(path);
        if (self.event_log_path) |path| allocator.free(path);
        if (self.excerpt_path) |path| allocator.free(path);
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
            .pty_child = null,
            .cols = input.cols,
            .rows = input.rows,
            .status = .live,
            .last_seq = 0,
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
        if (item.status == .live) item.status = .detached;
        return true;
    }

    pub fn attach(self: *Manager, session_id: []const u8) ?*TerminalSession {
        const item = self.find(session_id) orelse return null;
        if (item.status == .detached) item.status = .live;
        return item;
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
