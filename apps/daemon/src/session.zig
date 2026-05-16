const std = @import("std");
const rpc = @import("rpc.zig");

pub const Status = enum {
    live,
    detached,
    exited,
    crashed,
    archived,
    killed,
};

pub const TerminalSession = struct {
    id: []const u8,
    terminal_id: []const u8,
    cwd: ?[]const u8,
    cols: u16,
    rows: u16,
    status: Status,
    last_seq: u64,

    pub fn deinit(self: *TerminalSession, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.terminal_id);
        if (self.cwd) |cwd| allocator.free(cwd);
        self.* = undefined;
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

    pub fn resize(self: *Manager, session_id: []const u8, cols: u16, rows: u16) bool {
        const item = self.find(session_id) orelse return false;
        item.cols = cols;
        item.rows = rows;
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
}
