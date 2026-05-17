const std = @import("std");
const rpc = @import("../rpc.zig");
const session = @import("../session.zig");

pub const AttachKind = enum {
    live,
    command_resume,
    agent_resume,

    pub fn text(self: AttachKind) []const u8 {
        return switch (self) {
            .live => "live",
            .command_resume => "command-resume",
            .agent_resume => "agent-resume",
        };
    }
};

pub const SessionResponseMetadata = struct {
    attach_kind: AttachKind = .live,
    agent_provider: ?[]const u8 = null,
    native_session_id: ?[]const u8 = null,
};

pub fn sessionResponse(
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    item: *const session.TerminalSession,
    metadata: SessionResponseMetadata,
) ![]u8 {
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = true,
        .session_id = item.id,
        .pid = item.pidU32(),
        .status = item.status.text(),
        .cwd = item.cwd,
        .cols = item.cols,
        .rows = item.rows,
        .last_seq = item.last_seq,
        .attach_kind = metadata.attach_kind.text(),
        .agent_provider = metadata.agent_provider,
        .native_session_id = metadata.native_session_id,
    });
}

pub fn missingField(
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    field: []const u8,
) ![]u8 {
    var buffer: [64]u8 = undefined;
    const message = try std.fmt.bufPrint(&buffer, "missing field: {s}", .{field});
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = false,
        .error_message = message,
    });
}

pub fn notFound(allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = false,
        .error_code = "session_not_found",
        .error_message = "session not found",
    });
}
