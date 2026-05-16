const std = @import("std");

pub const RequestType = enum {
    create,
    attach,
    resize,
    detach,
    kill,
    unknown,

    pub fn fromText(text: []const u8) RequestType {
        if (std.mem.eql(u8, text, "create")) return .create;
        if (std.mem.eql(u8, text, "attach")) return .attach;
        if (std.mem.eql(u8, text, "resize")) return .resize;
        if (std.mem.eql(u8, text, "detach")) return .detach;
        if (std.mem.eql(u8, text, "kill")) return .kill;
        return .unknown;
    }
};

pub const ControlRequestJson = struct {
    id: []const u8 = "",
    method: []const u8,
    session_id: ?[]const u8 = null,
    terminal_id: ?[]const u8 = null,
    cols: ?u16 = null,
    rows: ?u16 = null,
    cwd: ?[]const u8 = null,
    argv: ?[][]const u8 = null,

    pub fn requestType(self: ControlRequestJson) RequestType {
        return RequestType.fromText(self.method);
    }

    pub fn requestId(self: ControlRequestJson) ?[]const u8 {
        return if (self.id.len == 0) null else self.id;
    }
};

pub const CreateRequest = struct {
    session_id: []const u8,
    terminal_id: []const u8,
    cols: u16,
    rows: u16,
    cwd: ?[]const u8 = null,
    argv: []const []const u8 = &.{},
};

pub const AttachRequest = struct {
    session_id: []const u8,
};

pub const ResizeRequest = struct {
    session_id: []const u8,
    cols: u16,
    rows: u16,
};

pub const ResponseTag = enum {
    ok,
    error_response,
};

pub const Response = union(ResponseTag) {
    ok: struct {
        request_id: []const u8,
        session_id: ?[]const u8 = null,
    },
    error_response: struct {
        request_id: ?[]const u8 = null,
        message: []const u8,
    },
};

pub const ControlResponse = struct {
    id: ?[]const u8 = null,
    ok: bool,
    session_id: ?[]const u8 = null,
    status: ?[]const u8 = null,
    cols: ?u16 = null,
    rows: ?u16 = null,
    last_seq: ?u64 = null,
    error_message: ?[]const u8 = null,
};

pub fn responseJsonAlloc(allocator: std.mem.Allocator, response: ControlResponse) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    try out.writer.print("{f}\n", .{std.json.fmt(response, .{})});
    return out.toOwnedSlice();
}

pub const StreamKind = enum(u16) {
    output = 1,
    input = 2,
    resize = 3,
    snapshot = 4,
    exit = 5,
    agent = 6,
};

test "request type decoding is stable" {
    try std.testing.expectEqual(RequestType.create, RequestType.fromText("create"));
    try std.testing.expectEqual(RequestType.unknown, RequestType.fromText("other"));
}

test "control request JSON decodes create messages" {
    var parsed = try std.json.parseFromSlice(ControlRequestJson, std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"s1","terminal_id":"t1","cols":80,"rows":24,"argv":["bash"]}
    , .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    try std.testing.expectEqual(RequestType.create, parsed.value.requestType());
    try std.testing.expectEqualStrings("1", parsed.value.requestId().?);
    try std.testing.expectEqualStrings("bash", parsed.value.argv.?[0]);
}

test "control response formats as newline-delimited JSON" {
    const json = try responseJsonAlloc(std.testing.allocator, .{
        .id = "1",
        .ok = true,
        .session_id = "s1",
        .status = "live",
        .cols = 80,
        .rows = 24,
        .last_seq = 0,
    });
    defer std.testing.allocator.free(json);

    try std.testing.expect(std.mem.endsWith(u8, json, "\n"));
    try std.testing.expect(std.mem.indexOf(u8, json, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"session_id\":\"s1\"") != null);
}
