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
    method: ?[]const u8 = null,
    type: ?[]const u8 = null,
    session_id: ?[]const u8 = null,
    sessionId: ?[]const u8 = null,
    terminal_id: ?[]const u8 = null,
    terminalId: ?[]const u8 = null,
    cols: ?u16 = null,
    rows: ?u16 = null,
    cwd: ?[]const u8 = null,
    argv: ?[][]const u8 = null,

    pub fn requestType(self: ControlRequestJson) RequestType {
        return RequestType.fromText(self.method orelse self.type orelse "");
    }

    pub fn requestId(self: ControlRequestJson) ?[]const u8 {
        return if (self.id.len == 0) null else self.id;
    }

    pub fn requestSessionId(self: ControlRequestJson) ?[]const u8 {
        return self.session_id orelse self.sessionId;
    }

    pub fn requestTerminalId(self: ControlRequestJson) ?[]const u8 {
        return self.terminal_id orelse self.terminalId;
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
    stream_id: ?[]const u8 = null,
    pid: ?u32 = null,
    status: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
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

    pub fn fromRaw(raw: u16) ?StreamKind {
        return switch (raw) {
            1 => .output,
            2 => .input,
            3 => .resize,
            4 => .snapshot,
            5 => .exit,
            6 => .agent,
            else => null,
        };
    }
};

pub const stream_magic: u32 = 0x54415346; // TASF
pub const stream_version: u16 = 1;
pub const stream_session_id_size: usize = 64;
const stream_session_id_offset: usize = 8;
const stream_seq_offset: usize = stream_session_id_offset + stream_session_id_size;
const stream_length_offset: usize = stream_seq_offset + 8;
const stream_crc_offset: usize = stream_length_offset + 4;
pub const stream_header_size: usize = stream_crc_offset + 4;
pub const max_stream_payload_bytes: u32 = 64 * 1024 * 1024;

pub const StreamFrame = struct {
    kind: StreamKind,
    session_id: []const u8,
    seq: u64,
    payload: []const u8,
};

pub const StreamParseResult = struct {
    valid_bytes: usize,
    frames_seen: usize,
};

pub const ResizePayload = struct {
    cols: u16,
    rows: u16,
};

pub const ExitPayload = struct {
    exit_code: i32,
    signal: i32,
};

pub fn encodedStreamFrameSize(payload_len: usize) usize {
    return stream_header_size + payload_len;
}

pub fn encodeStreamFrame(
    out: []u8,
    kind: StreamKind,
    session_id: []const u8,
    seq: u64,
    payload: []const u8,
) ![]u8 {
    if (session_id.len == 0 or session_id.len > stream_session_id_size) return error.InvalidSessionId;
    if (payload.len > max_stream_payload_bytes) return error.PayloadTooLarge;

    const total_len = encodedStreamFrameSize(payload.len);
    if (out.len < total_len) return error.NoSpaceLeft;

    std.mem.writeInt(u32, out[0..4], stream_magic, .big);
    std.mem.writeInt(u16, out[4..6], stream_version, .big);
    std.mem.writeInt(u16, out[6..8], @intFromEnum(kind), .big);
    @memset(out[stream_session_id_offset .. stream_session_id_offset + stream_session_id_size], 0);
    @memcpy(out[stream_session_id_offset .. stream_session_id_offset + session_id.len], session_id);
    std.mem.writeInt(u64, out[stream_seq_offset..][0..8], seq, .big);
    std.mem.writeInt(u32, out[stream_length_offset..][0..4], @intCast(payload.len), .big);
    std.mem.writeInt(u32, out[stream_crc_offset..][0..4], std.hash.Crc32.hash(payload), .big);
    @memcpy(out[stream_header_size..total_len], payload);

    return out[0..total_len];
}

pub fn parseStreamFrames(data: []const u8, visitor: anytype) !StreamParseResult {
    var offset: usize = 0;
    var valid_bytes: usize = 0;
    var frames_seen: usize = 0;

    while (offset + stream_header_size <= data.len) {
        if (std.mem.readInt(u32, data[offset..][0..4], .big) != stream_magic) break;

        const version = std.mem.readInt(u16, data[offset + 4 ..][0..2], .big);
        const kind_raw = std.mem.readInt(u16, data[offset + 6 ..][0..2], .big);
        const session_field = data[offset + stream_session_id_offset .. offset + stream_session_id_offset + stream_session_id_size];
        const seq = std.mem.readInt(u64, data[offset + stream_seq_offset ..][0..8], .big);
        const length = std.mem.readInt(u32, data[offset + stream_length_offset ..][0..4], .big);
        const expected_crc = std.mem.readInt(u32, data[offset + stream_crc_offset ..][0..4], .big);
        const payload_start = offset + stream_header_size;

        const kind = StreamKind.fromRaw(kind_raw) orelse break;
        const session_id = trimStreamSessionId(session_field);
        if (version != stream_version or session_id.len == 0 or length > max_stream_payload_bytes) break;

        const payload_end = payload_start + @as(usize, length);
        if (payload_end > data.len) break;

        const payload = data[payload_start..payload_end];
        if (std.hash.Crc32.hash(payload) != expected_crc) break;

        try visitor.visit(.{
            .kind = kind,
            .session_id = session_id,
            .seq = seq,
            .payload = payload,
        });
        frames_seen += 1;

        offset = payload_end;
        valid_bytes = offset;
    }

    return .{ .valid_bytes = valid_bytes, .frames_seen = frames_seen };
}

pub fn encodeResizePayload(out: []u8, cols: u16, rows: u16) ![]u8 {
    if (cols == 0 or rows == 0) return error.InvalidSize;
    if (out.len < 4) return error.NoSpaceLeft;

    std.mem.writeInt(u16, out[0..2], cols, .big);
    std.mem.writeInt(u16, out[2..4], rows, .big);
    return out[0..4];
}

pub fn decodeResizePayload(payload: []const u8) !ResizePayload {
    if (payload.len != 4) return error.InvalidResizePayload;
    const cols = std.mem.readInt(u16, payload[0..2], .big);
    const rows = std.mem.readInt(u16, payload[2..4], .big);
    if (cols == 0 or rows == 0) return error.InvalidSize;
    return .{ .cols = cols, .rows = rows };
}

pub fn encodeExitPayload(out: []u8, exit_code: i32, signal: i32) ![]u8 {
    if (out.len < 8) return error.NoSpaceLeft;

    std.mem.writeInt(i32, out[0..4], exit_code, .big);
    std.mem.writeInt(i32, out[4..8], signal, .big);
    return out[0..8];
}

pub fn decodeExitPayload(payload: []const u8) !ExitPayload {
    if (payload.len != 8) return error.InvalidExitPayload;
    return .{
        .exit_code = std.mem.readInt(i32, payload[0..4], .big),
        .signal = std.mem.readInt(i32, payload[4..8], .big),
    };
}

fn trimStreamSessionId(field: []const u8) []const u8 {
    return std.mem.trimEnd(u8, field, &.{0});
}

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

test "control request JSON accepts protocol type and camelCase identifiers" {
    var parsed = try std.json.parseFromSlice(ControlRequestJson, std.testing.allocator,
        \\{"id":"1","type":"create","sessionId":"s1","terminalId":"t1"}
    , .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    try std.testing.expectEqual(RequestType.create, parsed.value.requestType());
    try std.testing.expectEqualStrings("s1", parsed.value.requestSessionId().?);
    try std.testing.expectEqualStrings("t1", parsed.value.requestTerminalId().?);
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

test "stream frames encode and parse binary payloads" {
    var buffer: [128]u8 = undefined;
    const encoded = try encodeStreamFrame(&buffer, .output, "session-1", 7, "hello");

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), frame: StreamFrame) !void {
            self.count += 1;
            try std.testing.expectEqual(StreamKind.output, frame.kind);
            try std.testing.expectEqualStrings("session-1", frame.session_id);
            try std.testing.expectEqual(@as(u64, 7), frame.seq);
            try std.testing.expectEqualStrings("hello", frame.payload);
        }
    }{};

    const result = try parseStreamFrames(encoded, &recorder);
    try std.testing.expectEqual(encoded.len, result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 1), result.frames_seen);
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
}

test "stream parser leaves partial tails unread" {
    var buffer: [256]u8 = undefined;
    const first = try encodeStreamFrame(buffer[0..128], .snapshot, "session-1", 8, "state");
    const second = try encodeStreamFrame(buffer[first.len..], .output, "session-1", 9, "tail");
    const total_len = first.len + second.len - 2;

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), _: StreamFrame) !void {
            self.count += 1;
        }
    }{};

    const result = try parseStreamFrames(buffer[0..total_len], &recorder);
    try std.testing.expectEqual(first.len, result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 1), result.frames_seen);
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
}

test "stream parser rejects corrupt CRC payloads" {
    var buffer: [128]u8 = undefined;
    const encoded = try encodeStreamFrame(&buffer, .agent, "session-1", 10, "{\"ok\":true}");
    buffer[stream_header_size] ^= 0xff;

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), _: StreamFrame) !void {
            self.count += 1;
        }
    }{};

    const result = try parseStreamFrames(encoded, &recorder);
    try std.testing.expectEqual(@as(usize, 0), result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 0), result.frames_seen);
    try std.testing.expectEqual(@as(usize, 0), recorder.count);
}

test "stream resize and exit payload helpers round-trip" {
    var resize_buffer: [4]u8 = undefined;
    const resize_payload = try encodeResizePayload(&resize_buffer, 120, 40);
    const resize = try decodeResizePayload(resize_payload);
    try std.testing.expectEqual(@as(u16, 120), resize.cols);
    try std.testing.expectEqual(@as(u16, 40), resize.rows);

    var exit_buffer: [8]u8 = undefined;
    const exit_payload = try encodeExitPayload(&exit_buffer, 2, 15);
    const exit = try decodeExitPayload(exit_payload);
    try std.testing.expectEqual(@as(i32, 2), exit.exit_code);
    try std.testing.expectEqual(@as(i32, 15), exit.signal);
}
