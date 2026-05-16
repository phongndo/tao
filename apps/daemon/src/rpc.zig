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
