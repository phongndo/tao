const std = @import("std");
const limits = @import("limits.zig");

const assert = std.debug.assert;

pub const file_magic = [_]u8{ 0x54, 0x41, 0x4f, 0x45, 0x56, 0x00, 0x01, 0x00 }; // TAOEV\0\1\0
pub const session_id_header_size: usize = 36;
pub const file_header_size: usize = file_magic.len + session_id_header_size + 8;
pub const frame_magic: u32 = 0x54414546; // TAEF
pub const frame_header_size: usize = 32;
pub const max_payload_bytes: u32 = limits.event_log_payload_bytes_max;
pub const max_replay_bytes: usize = limits.event_log_replay_bytes_max;
pub const max_excerpt_bytes: usize = limits.event_log_excerpt_bytes_max;

/// Event-log files are append-only recovery streams:
///
/// * file header: 8-byte magic, 36-byte padded session id, 8-byte created-at ms.
/// * frame header: 4-byte magic, 2-byte version, 2-byte kind, 8-byte sequence,
///   8-byte monotonic timestamp, 4-byte payload length, 4-byte payload CRC32.
/// * payload: kind-specific bytes. Parsers accept only strictly increasing
///   sequences and stop at the first invalid tail so repair can truncate safely.
pub const EventLogError = error{
    InvalidSessionId,
    InvalidFrameKind,
    InvalidSequence,
    InvalidSize,
    PayloadTooLarge,
    SequenceOverflow,
    NoSpaceLeft,
    FileSyncFailed,
    OutOfMemory,
};

comptime {
    assert(file_magic.len == 8);
    assert(file_header_size == 52);
    assert(frame_header_size == 32);
    assert(max_payload_bytes > 0);
}

pub const FrameKind = enum(u16) {
    output = 1,
    input = 2,
    resize = 3,
    title = 4,
    cwd = 5,
    agent_event = 6,
    snapshot_mark = 7,
    exit = 8,
    _,

    pub fn fromRaw(raw: u16) ?FrameKind {
        return switch (raw) {
            1 => .output,
            2 => .input,
            3 => .resize,
            4 => .title,
            5 => .cwd,
            6 => .agent_event,
            7 => .snapshot_mark,
            8 => .exit,
            else => null,
        };
    }
};

pub const Frame = struct {
    kind: FrameKind,
    seq: u64,
    monotonic_ms: u64,
    payload: []const u8,
};

pub const ParseResult = struct {
    valid_bytes: usize,
    frames_seen: usize,
};

const FileParseResult = struct {
    valid_bytes: usize,
    frames_seen: usize,
    file_size: usize,

    fn assertInvariants(self: FileParseResult) void {
        assert(self.valid_bytes <= self.file_size);
        if (self.frames_seen == 0) assert(self.valid_bytes == 0 or self.valid_bytes == file_header_size);
        if (self.frames_seen > 0) assert(self.valid_bytes >= file_header_size + frame_header_size);
    }
};

pub const SessionFiles = struct {
    dir: []const u8,
    event_log_path: []const u8,
    excerpt_path: []const u8,
    last_seq: u64,

    pub fn deinit(self: *SessionFiles, allocator: std.mem.Allocator) void {
        allocator.free(self.dir);
        allocator.free(self.event_log_path);
        allocator.free(self.excerpt_path);
        self.* = undefined;
    }
};

pub const OwnedFrame = struct {
    kind: FrameKind,
    seq: u64,
    payload: []u8,

    pub fn deinit(self: *OwnedFrame, allocator: std.mem.Allocator) void {
        allocator.free(self.payload);
        self.* = undefined;
    }
};

pub fn encodedFrameSize(payload_len: usize) usize {
    return frame_header_size + payload_len;
}

pub fn encodeFileHeader(out: []u8, session_id: []const u8, created_at_ms: u64) ![]u8 {
    if (session_id.len == 0) return error.InvalidSessionId;
    if (out.len < file_header_size) return error.NoSpaceLeft;

    @memcpy(out[0..file_magic.len], &file_magic);
    @memset(out[file_magic.len .. file_magic.len + session_id_header_size], ' ');
    const copy_len = @min(session_id.len, session_id_header_size);
    @memcpy(out[file_magic.len .. file_magic.len + copy_len], session_id[0..copy_len]);
    std.mem.writeInt(u64, out[file_magic.len + session_id_header_size ..][0..8], created_at_ms, .big);

    return out[0..file_header_size];
}

pub fn hasValidHeader(data: []const u8) bool {
    return data.len >= file_header_size and std.mem.eql(u8, data[0..file_magic.len], &file_magic);
}

fn nextSequence(last_seq: *const u64) !u64 {
    return std.math.add(u64, last_seq.*, 1) catch error.SequenceOverflow;
}

pub fn encodeFrame(
    out: []u8,
    kind: FrameKind,
    seq: u64,
    monotonic_ms: u64,
    payload: []const u8,
) ![]u8 {
    if (FrameKind.fromRaw(@intFromEnum(kind)) == null) return error.InvalidFrameKind;
    if (payload.len > max_payload_bytes) return error.PayloadTooLarge;
    if (seq == 0) return error.InvalidSequence;
    const total_len = encodedFrameSize(payload.len);
    if (out.len < total_len) return error.NoSpaceLeft;

    std.mem.writeInt(u32, out[0..4], frame_magic, .big);
    std.mem.writeInt(u16, out[4..6], 1, .big);
    std.mem.writeInt(u16, out[6..8], @intFromEnum(kind), .big);
    std.mem.writeInt(u64, out[8..16], seq, .big);
    std.mem.writeInt(u64, out[16..24], monotonic_ms, .big);
    std.mem.writeInt(u32, out[24..28], @intCast(payload.len), .big);
    std.mem.writeInt(u32, out[28..32], std.hash.Crc32.hash(payload), .big);
    @memcpy(out[frame_header_size..total_len], payload);

    assert(total_len == frame_header_size + payload.len);

    return out[0..total_len];
}

pub fn parseFrames(data: []const u8, visitor: anytype) !ParseResult {
    var offset: usize = 0;
    var valid_bytes: usize = 0;
    var frames_seen: usize = 0;
    var last_seq: u64 = 0;

    while (offset <= data.len and data.len - offset >= frame_header_size) {
        if (std.mem.readInt(u32, data[offset..][0..4], .big) != frame_magic) break;

        const version = std.mem.readInt(u16, data[offset + 4 ..][0..2], .big);
        const kind_raw = std.mem.readInt(u16, data[offset + 6 ..][0..2], .big);
        const seq = std.mem.readInt(u64, data[offset + 8 ..][0..8], .big);
        const monotonic_ms = std.mem.readInt(u64, data[offset + 16 ..][0..8], .big);
        const length = std.mem.readInt(u32, data[offset + 24 ..][0..4], .big);
        const expected_crc = std.mem.readInt(u32, data[offset + 28 ..][0..4], .big);
        const payload_start = offset + frame_header_size;

        const kind = FrameKind.fromRaw(kind_raw) orelse break;
        if (version != 1 or seq <= last_seq or length > max_payload_bytes) break;
        if (length > data.len - payload_start) break;

        const payload_end = payload_start + @as(usize, length);

        const payload = data[payload_start..payload_end];
        if (std.hash.Crc32.hash(payload) != expected_crc) break;

        try visitor.visit(.{
            .kind = kind,
            .seq = seq,
            .monotonic_ms = monotonic_ms,
            .payload = payload,
        });
        frames_seen += 1;
        last_seq = seq;

        offset = payload_end;
        valid_bytes = offset;
    }

    return .{ .valid_bytes = valid_bytes, .frames_seen = frames_seen };
}

pub fn parseEventLog(data: []const u8, visitor: anytype) !ParseResult {
    if (!hasValidHeader(data)) return .{ .valid_bytes = 0, .frames_seen = 0 };

    const result = try parseFrames(data[file_header_size..], visitor);
    return .{
        .valid_bytes = file_header_size + result.valid_bytes,
        .frames_seen = result.frames_seen,
    };
}

pub fn openPersistentSession(
    allocator: std.mem.Allocator,
    sessions_dir: []const u8,
    session_id: []const u8,
) !SessionFiles {
    try mkdirPath(allocator, sessions_dir, 0o700);

    const sanitized_id = try sanitizeSessionId(allocator, session_id);
    defer allocator.free(sanitized_id);

    const dir = try std.fs.path.join(allocator, &.{ sessions_dir, sanitized_id });
    errdefer allocator.free(dir);
    try mkdirPath(allocator, dir, 0o700);

    const event_log_path = try std.fs.path.join(allocator, &.{ dir, "events.taoev" });
    errdefer allocator.free(event_log_path);
    const excerpt_path = try std.fs.path.join(allocator, &.{ dir, "excerpt.txt" });
    errdefer allocator.free(excerpt_path);

    try repairEventLog(allocator, event_log_path, session_id);
    const last_seq = try readLastSeq(allocator, event_log_path);

    return .{
        .dir = dir,
        .event_log_path = event_log_path,
        .excerpt_path = excerpt_path,
        .last_seq = last_seq,
    };
}

pub fn resetPersistentSession(
    allocator: std.mem.Allocator,
    sessions_dir: []const u8,
    session_id: []const u8,
) !SessionFiles {
    try mkdirPath(allocator, sessions_dir, 0o700);

    const sanitized_id = try sanitizeSessionId(allocator, session_id);
    defer allocator.free(sanitized_id);

    const dir = try std.fs.path.join(allocator, &.{ sessions_dir, sanitized_id });
    errdefer allocator.free(dir);
    try mkdirPath(allocator, dir, 0o700);

    const event_log_path = try std.fs.path.join(allocator, &.{ dir, "events.taoev" });
    errdefer allocator.free(event_log_path);
    const excerpt_path = try std.fs.path.join(allocator, &.{ dir, "excerpt.txt" });
    errdefer allocator.free(excerpt_path);

    var header: [file_header_size]u8 = undefined;
    const encoded = try encodeFileHeader(&header, session_id, nowMs());
    try writeFile(allocator, event_log_path, encoded, 0o600);
    try writeFile(allocator, excerpt_path, &.{}, 0o600);

    return .{
        .dir = dir,
        .event_log_path = event_log_path,
        .excerpt_path = excerpt_path,
        .last_seq = 0,
    };
}

pub fn openExistingSession(
    allocator: std.mem.Allocator,
    sessions_dir: []const u8,
    session_id: []const u8,
) !?SessionFiles {
    const sanitized_id = try sanitizeSessionId(allocator, session_id);
    defer allocator.free(sanitized_id);

    const dir = try std.fs.path.join(allocator, &.{ sessions_dir, sanitized_id });
    errdefer allocator.free(dir);
    const event_log_path = try std.fs.path.join(allocator, &.{ dir, "events.taoev" });
    errdefer allocator.free(event_log_path);
    const excerpt_path = try std.fs.path.join(allocator, &.{ dir, "excerpt.txt" });
    errdefer allocator.free(excerpt_path);

    if (!try eventLogFileHasValidHeader(allocator, event_log_path)) {
        allocator.free(dir);
        allocator.free(event_log_path);
        allocator.free(excerpt_path);
        return null;
    }

    return .{
        .dir = dir,
        .event_log_path = event_log_path,
        .excerpt_path = excerpt_path,
        .last_seq = try readLastSeq(allocator, event_log_path),
    };
}

pub fn appendFramePath(
    allocator: std.mem.Allocator,
    path: []const u8,
    kind: FrameKind,
    seq: u64,
    payload: []const u8,
) !void {
    return appendFramePathOptions(allocator, path, kind, seq, payload, .{});
}

pub fn appendFramePathDurable(
    allocator: std.mem.Allocator,
    path: []const u8,
    kind: FrameKind,
    seq: u64,
    payload: []const u8,
) !void {
    return appendFramePathOptions(allocator, path, kind, seq, payload, .{ .sync = true });
}

const AppendFrameOptions = struct {
    sync: bool = false,
};

fn appendFramePathOptions(
    allocator: std.mem.Allocator,
    path: []const u8,
    kind: FrameKind,
    seq: u64,
    payload: []const u8,
    options: AppendFrameOptions,
) !void {
    if (payload.len > max_payload_bytes) return error.PayloadTooLarge;

    const frame = try allocator.alloc(u8, encodedFrameSize(payload.len));
    defer allocator.free(frame);

    const encoded = try encodeFrame(frame, kind, seq, nowMs(), payload);
    try appendFile(allocator, path, encoded, 0o600, options.sync);
}

pub fn appendOutput(
    allocator: std.mem.Allocator,
    event_log_path: []const u8,
    excerpt_path: ?[]const u8,
    last_seq: *u64,
    payload: []const u8,
) !u64 {
    const seq = try nextSequence(last_seq);
    try appendFramePath(allocator, event_log_path, .output, seq, payload);
    last_seq.* = seq;
    if (excerpt_path) |path| appendBoundedExcerpt(allocator, path, payload) catch {};
    return last_seq.*;
}

pub fn appendInput(
    allocator: std.mem.Allocator,
    event_log_path: []const u8,
    last_seq: *u64,
    payload: []const u8,
) !u64 {
    const seq = try nextSequence(last_seq);
    try appendFramePath(allocator, event_log_path, .input, seq, payload);
    last_seq.* = seq;
    return last_seq.*;
}

pub fn appendResize(
    allocator: std.mem.Allocator,
    event_log_path: []const u8,
    last_seq: *u64,
    cols: u16,
    rows: u16,
) !u64 {
    if (cols == 0 or rows == 0) return error.InvalidSize;

    var payload: [4]u8 = undefined;
    std.mem.writeInt(u16, payload[0..2], cols, .big);
    std.mem.writeInt(u16, payload[2..4], rows, .big);

    const seq = try nextSequence(last_seq);
    try appendFramePath(allocator, event_log_path, .resize, seq, &payload);
    last_seq.* = seq;
    return last_seq.*;
}

pub fn appendExit(
    allocator: std.mem.Allocator,
    event_log_path: []const u8,
    last_seq: *u64,
    exit_code: i32,
    signal: i32,
) !u64 {
    var payload: [8]u8 = undefined;
    std.mem.writeInt(i32, payload[0..4], exit_code, .big);
    std.mem.writeInt(i32, payload[4..8], signal, .big);

    const seq = try nextSequence(last_seq);
    try appendFramePath(allocator, event_log_path, .exit, seq, &payload);
    last_seq.* = seq;
    return last_seq.*;
}

pub fn appendSnapshotMark(
    allocator: std.mem.Allocator,
    event_log_path: []const u8,
    last_seq: *u64,
    snapshot_seq: u64,
    snapshot_path: []const u8,
) !u64 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    try out.writer.print(
        "{{\"snapshotSeq\":{d},\"path\":{f}}}",
        .{ snapshot_seq, std.json.fmt(snapshot_path, .{}) },
    );
    const payload = try out.toOwnedSlice();
    defer allocator.free(payload);

    const seq = try nextSequence(last_seq);
    try appendFramePath(allocator, event_log_path, .snapshot_mark, seq, payload);
    last_seq.* = seq;
    return last_seq.*;
}

pub fn readOwnedFrames(allocator: std.mem.Allocator, path: []const u8) ![]OwnedFrame {
    var recorder = OwnedFrameRecorder{ .allocator = allocator };
    errdefer recorder.deinit();
    _ = try parseEventLogFile(allocator, path, &recorder) orelse return allocator.alloc(OwnedFrame, 0);
    return recorder.frames.toOwnedSlice(allocator);
}

pub fn readReplayOutputFrames(
    allocator: std.mem.Allocator,
    path: []const u8,
    max_bytes: usize,
) ![]OwnedFrame {
    var recorder = ReplayOutputRecorder{ .allocator = allocator, .max_bytes = max_bytes };
    errdefer recorder.deinit();
    _ = try parseEventLogFile(allocator, path, &recorder) orelse return allocator.alloc(OwnedFrame, 0);
    return recorder.frames.toOwnedSlice(allocator);
}

pub fn deinitOwnedFrames(allocator: std.mem.Allocator, frames: []OwnedFrame) void {
    for (frames) |*frame| frame.deinit(allocator);
    allocator.free(frames);
}

pub fn readLastSeq(allocator: std.mem.Allocator, path: []const u8) !u64 {
    var last_seq: u64 = 0;
    var recorder = struct {
        value: *u64,
        pub fn visit(self: *@This(), frame: Frame) !void {
            self.value.* = frame.seq;
        }
    }{ .value = &last_seq };
    _ = try parseEventLogFile(allocator, path, &recorder) orelse return last_seq;
    return last_seq;
}

fn repairEventLog(allocator: std.mem.Allocator, path: []const u8, session_id: []const u8) !void {
    var visitor = struct {
        pub fn visit(_: *@This(), _: Frame) !void {}
    }{};
    const result = try parseEventLogFile(allocator, path, &visitor);
    const parsed = result orelse {
        var header: [file_header_size]u8 = undefined;
        const encoded = try encodeFileHeader(&header, session_id, nowMs());
        try writeFile(allocator, path, encoded, 0o600);
        return;
    };
    if (parsed.valid_bytes == 0) {
        var header: [file_header_size]u8 = undefined;
        const encoded = try encodeFileHeader(&header, session_id, nowMs());
        try writeFile(allocator, path, encoded, 0o600);
        return;
    }

    if (parsed.valid_bytes < parsed.file_size) try truncateFile(allocator, path, parsed.valid_bytes);
}

fn eventLogFileHasValidHeader(allocator: std.mem.Allocator, path: []const u8) !bool {
    const file = try openReadFile(allocator, path) orelse return false;
    defer _ = std.c.close(file.fd);

    var header: [file_header_size]u8 = undefined;
    const header_bytes = try readExactFd(file.fd, &header);
    return header_bytes == file_header_size and hasValidHeader(&header);
}

fn parseEventLogFile(allocator: std.mem.Allocator, path: []const u8, visitor: anytype) !?FileParseResult {
    const file = try openReadFile(allocator, path) orelse return null;
    defer _ = std.c.close(file.fd);

    const result = try parseEventLogFd(allocator, file.fd, visitor);
    const parsed: FileParseResult = .{
        .valid_bytes = result.valid_bytes,
        .frames_seen = result.frames_seen,
        .file_size = file.size,
    };
    parsed.assertInvariants();
    return parsed;
}

fn parseEventLogFd(allocator: std.mem.Allocator, fd: std.c.fd_t, visitor: anytype) !ParseResult {
    assert(fd >= 0);
    var header: [file_header_size]u8 = undefined;
    const header_bytes = try readExactFd(fd, &header);
    if (header_bytes != file_header_size or !hasValidHeader(&header)) {
        return .{ .valid_bytes = 0, .frames_seen = 0 };
    }

    var offset: usize = file_header_size;
    var valid_bytes: usize = file_header_size;
    var frames_seen: usize = 0;
    var last_seq: u64 = 0;

    while (true) {
        var frame_header: [frame_header_size]u8 = undefined;
        const frame_header_bytes = try readExactFd(fd, &frame_header);
        if (frame_header_bytes == 0) break;
        if (frame_header_bytes != frame_header_size) break;

        assert(valid_bytes <= offset);
        if (std.mem.readInt(u32, frame_header[0..4], .big) != frame_magic) break;

        const version = std.mem.readInt(u16, frame_header[4..6], .big);
        const kind_raw = std.mem.readInt(u16, frame_header[6..8], .big);
        const seq = std.mem.readInt(u64, frame_header[8..16], .big);
        const monotonic_ms = std.mem.readInt(u64, frame_header[16..24], .big);
        const length = std.mem.readInt(u32, frame_header[24..28], .big);
        const expected_crc = std.mem.readInt(u32, frame_header[28..32], .big);

        const kind = FrameKind.fromRaw(kind_raw) orelse break;
        if (version != 1 or seq <= last_seq or length > max_payload_bytes) break;
        assert(length <= max_payload_bytes);

        const payload = try allocator.alloc(u8, @as(usize, length));
        defer allocator.free(payload);
        const payload_bytes = try readExactFd(fd, payload);
        if (payload_bytes != payload.len) break;
        if (std.hash.Crc32.hash(payload) != expected_crc) break;

        try visitor.visit(.{
            .kind = kind,
            .seq = seq,
            .monotonic_ms = monotonic_ms,
            .payload = payload,
        });
        frames_seen += 1;
        last_seq = seq;

        const previous_valid_bytes = valid_bytes;
        offset += frame_header_size + payload.len;
        valid_bytes = offset;
        assert(valid_bytes > previous_valid_bytes);
        assert(valid_bytes >= file_header_size);
    }

    return .{ .valid_bytes = valid_bytes, .frames_seen = frames_seen };
}

const OpenReadFile = struct {
    fd: std.c.fd_t,
    size: usize,
};

fn openReadFile(allocator: std.mem.Allocator, path: []const u8) !?OpenReadFile {
    assert(path.len > 0);
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY, .CLOEXEC = true });
    if (fd < 0) {
        return switch (std.posix.errno(fd)) {
            .NOENT => null,
            else => error.FileOpenFailed,
        };
    }
    errdefer _ = std.c.close(fd);

    var stat: std.c.Stat = undefined;
    if (std.c.fstat(fd, &stat) != 0) return error.FileStatFailed;
    if (stat.size < 0) return error.FileTooBig;

    return .{ .fd = fd, .size = @intCast(stat.size) };
}

fn readExactFd(fd: std.c.fd_t, out: []u8) !usize {
    assert(fd >= 0);
    var offset: usize = 0;
    while (offset < out.len) {
        const amount = std.c.read(fd, out[offset..].ptr, out.len - offset);
        if (amount < 0) {
            switch (std.posix.errno(amount)) {
                .INTR => continue,
                else => return error.FileReadFailed,
            }
        }
        if (amount == 0) break;
        offset += @intCast(amount);
    }
    return offset;
}

const OwnedFrameRecorder = struct {
    allocator: std.mem.Allocator,
    frames: std.ArrayList(OwnedFrame) = .empty,

    pub fn deinit(self: *OwnedFrameRecorder) void {
        for (self.frames.items) |*frame| frame.deinit(self.allocator);
        self.frames.deinit(self.allocator);
    }

    pub fn visit(self: *OwnedFrameRecorder, frame: Frame) !void {
        const payload = try self.allocator.dupe(u8, frame.payload);
        errdefer self.allocator.free(payload);
        try self.frames.append(self.allocator, .{
            .kind = frame.kind,
            .seq = frame.seq,
            .payload = payload,
        });
    }
};

const ReplayOutputRecorder = struct {
    allocator: std.mem.Allocator,
    max_bytes: usize,
    frames: std.ArrayList(OwnedFrame) = .empty,
    total_bytes: usize = 0,

    pub fn deinit(self: *ReplayOutputRecorder) void {
        for (self.frames.items) |*frame| frame.deinit(self.allocator);
        self.frames.deinit(self.allocator);
    }

    pub fn visit(self: *ReplayOutputRecorder, frame: Frame) !void {
        if (frame.kind != .output or frame.payload.len == 0) return;

        const payload = try self.allocator.dupe(u8, frame.payload);
        errdefer self.allocator.free(payload);
        try self.frames.append(self.allocator, .{
            .kind = frame.kind,
            .seq = frame.seq,
            .payload = payload,
        });
        self.total_bytes += payload.len;

        while (self.total_bytes > self.max_bytes and self.frames.items.len > 0) {
            var dropped = self.frames.orderedRemove(0);
            self.total_bytes -= dropped.payload.len;
            dropped.deinit(self.allocator);
        }
    }
};

fn appendBoundedExcerpt(allocator: std.mem.Allocator, path: []const u8, payload: []const u8) !void {
    if (payload.len == 0) return;

    try appendFile(allocator, path, payload, 0o600, false);

    const data = (try readFileAlloc(allocator, path, max_excerpt_bytes + payload.len)) orelse return;
    defer allocator.free(data);
    if (data.len <= max_excerpt_bytes) return;

    try writeFile(allocator, path, data[data.len - max_excerpt_bytes ..], 0o600);
}

fn readFileAlloc(allocator: std.mem.Allocator, path: []const u8, limit: usize) !?[]u8 {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{ .ACCMODE = .RDONLY, .CLOEXEC = true });
    if (fd < 0) {
        return switch (std.posix.errno(fd)) {
            .NOENT => null,
            else => error.FileOpenFailed,
        };
    }
    defer _ = std.c.close(fd);

    var stat: std.c.Stat = undefined;
    if (std.c.fstat(fd, &stat) != 0) return error.FileStatFailed;
    if (stat.size < 0) return error.FileTooBig;
    const size: usize = @intCast(stat.size);
    if (size > limit) return error.FileTooBig;

    const data = try allocator.alloc(u8, size);
    errdefer allocator.free(data);

    var offset: usize = 0;
    while (offset < data.len) {
        const amount = std.c.read(fd, data[offset..].ptr, data.len - offset);
        if (amount < 0) {
            switch (std.posix.errno(amount)) {
                .INTR => continue,
                else => return error.FileReadFailed,
            }
        }
        if (amount == 0) break;
        offset += @intCast(amount);
    }

    if (offset == data.len) return data;
    return try allocator.realloc(data, offset);
}

fn writeFile(allocator: std.mem.Allocator, path: []const u8, data: []const u8, mode: std.c.mode_t) !void {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{
        .ACCMODE = .WRONLY,
        .CREAT = true,
        .TRUNC = true,
        .CLOEXEC = true,
    }, mode);
    if (fd < 0) return error.FileOpenFailed;
    defer _ = std.c.close(fd);
    _ = std.c.fchmod(fd, mode);

    try writeAllFd(fd, data);
}

fn appendFile(allocator: std.mem.Allocator, path: []const u8, data: []const u8, mode: std.c.mode_t, sync: bool) !void {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{
        .ACCMODE = .WRONLY,
        .CREAT = true,
        .APPEND = true,
        .CLOEXEC = true,
    }, mode);
    if (fd < 0) return error.FileOpenFailed;
    defer _ = std.c.close(fd);
    _ = std.c.fchmod(fd, mode);

    try writeAllFd(fd, data);
    if (sync and std.c.fsync(fd) != 0) return error.FileSyncFailed;
}

fn truncateFile(allocator: std.mem.Allocator, path: []const u8, size: usize) !void {
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);

    const fd = std.c.open(path_z.ptr, .{
        .ACCMODE = .WRONLY,
        .CLOEXEC = true,
    });
    if (fd < 0) return error.FileOpenFailed;
    defer _ = std.c.close(fd);

    if (std.c.ftruncate(fd, @intCast(size)) != 0) return error.FileTruncateFailed;
}

fn writeAllFd(fd: std.c.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const written = std.c.write(fd, data[offset..].ptr, data.len - offset);
        if (written < 0) {
            switch (std.posix.errno(written)) {
                .INTR => continue,
                else => return error.FileWriteFailed,
            }
        }
        if (written == 0) return error.FileWriteFailed;
        offset += @intCast(written);
    }
}

fn mkdirPath(allocator: std.mem.Allocator, path: []const u8, mode: std.c.mode_t) !void {
    if (path.len == 0) return;

    var buffer = try allocator.dupeZ(u8, path);
    defer allocator.free(buffer);

    var index: usize = if (buffer[0] == '/') 1 else 0;
    while (index < buffer.len) : (index += 1) {
        if (buffer[index] != '/') continue;
        buffer[index] = 0;
        if (std.mem.len(buffer.ptr) > 0) try mkdirOne(buffer.ptr, mode);
        buffer[index] = '/';
    }
    try mkdirOne(buffer.ptr, mode);
}

fn mkdirOne(path: [*:0]const u8, mode: std.c.mode_t) !void {
    const rc = std.c.mkdir(path, mode);
    if (rc == 0) {
        _ = std.c.chmod(path, mode);
        return;
    }
    switch (std.posix.errno(rc)) {
        .EXIST => {},
        else => return error.CreateDirFailed,
    }
}

pub fn sanitizeSessionId(allocator: std.mem.Allocator, session_id: []const u8) ![]u8 {
    if (session_id.len == 0) return error.InvalidSessionId;

    const out = try allocator.alloc(u8, session_id.len);
    for (session_id, 0..) |byte, index| {
        out[index] = switch (byte) {
            'a'...'z', 'A'...'Z', '0'...'9', '.', '_', ':', '-' => byte,
            else => '_',
        };
    }
    return out;
}

fn nowMs() u64 {
    var tv: std.c.timeval = undefined;
    if (std.c.gettimeofday(&tv, null) != 0) return 0;
    return @as(u64, @intCast(tv.sec)) * 1000 + @as(u64, @intCast(@divTrunc(tv.usec, 1000)));
}

test "event log encodes and parses framed payloads" {
    var buffer: [128]u8 = undefined;
    const encoded = try encodeFrame(&buffer, .output, 1, 42, "ok");

    var recorder = struct {
        count: usize = 0,
        last_seq: u64 = 0,
        pub fn visit(self: *@This(), frame: Frame) !void {
            self.count += 1;
            self.last_seq = frame.seq;
            try std.testing.expectEqual(FrameKind.output, frame.kind);
            try std.testing.expectEqualStrings("ok", frame.payload);
        }
    }{};

    const result = try parseFrames(encoded, &recorder);
    try std.testing.expectEqual(encoded.len, result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
    try std.testing.expectEqual(@as(u64, 1), recorder.last_seq);
}

test "event log file header and event parser preserve valid frame offset" {
    var buffer: [file_header_size + 64]u8 = undefined;
    const header = try encodeFileHeader(buffer[0..file_header_size], "session-1", 123);
    const encoded_frame = try encodeFrame(buffer[file_header_size..], .resize, 1, 42, "abcd");
    const data = buffer[0 .. header.len + encoded_frame.len];

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), parsed_frame: Frame) !void {
            self.count += 1;
            try std.testing.expectEqual(FrameKind.resize, parsed_frame.kind);
            try std.testing.expectEqual(@as(u64, 1), parsed_frame.seq);
        }
    }{};

    const result = try parseEventLog(data, &recorder);
    try std.testing.expectEqual(data.len, result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
}

test "event log rejects corrupt CRC payloads without treating tails as valid" {
    var buffer: [128]u8 = undefined;
    const encoded = try encodeFrame(&buffer, .output, 1, 42, "bad");
    buffer[frame_header_size] ^= 0xff;

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), _: Frame) !void {
            self.count += 1;
        }
    }{};

    const result = try parseFrames(encoded, &recorder);
    try std.testing.expectEqual(@as(usize, 0), recorder.count);
    try std.testing.expectEqual(@as(usize, 0), result.valid_bytes);
}

test "event log durable append failure does not advance sequence" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const missing_path = try std.fmt.allocPrint(
        std.testing.allocator,
        ".zig-cache/tmp/{s}/missing/events.taoev",
        .{tmp.sub_path},
    );
    defer std.testing.allocator.free(missing_path);

    var last_seq: u64 = 0;
    const seq = try nextSequence(&last_seq);
    try std.testing.expectError(
        error.FileOpenFailed,
        appendFramePathDurable(std.testing.allocator, missing_path, .output, seq, "not-written"),
    );
    try std.testing.expectEqual(@as(u64, 0), last_seq);
}

test "event log recovery streams valid files beyond a whole-file payload cap" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const sessions_dir = try std.fmt.allocPrint(
        std.testing.allocator,
        ".zig-cache/tmp/{s}/sessions",
        .{tmp.sub_path},
    );
    defer std.testing.allocator.free(sessions_dir);

    var files = try resetPersistentSession(std.testing.allocator, sessions_dir, "session:stream/recovery");
    defer files.deinit(std.testing.allocator);

    const simulated_single_payload_cap: usize = 1024;
    var payload: [128]u8 = undefined;
    @memset(&payload, 'x');

    var last_seq = files.last_seq;
    var expected_size: usize = file_header_size;
    while (expected_size <= file_header_size + simulated_single_payload_cap) {
        _ = try appendOutput(std.testing.allocator, files.event_log_path, null, &last_seq, &payload);
        expected_size += encodedFrameSize(payload.len);
    }

    try std.testing.expectError(
        error.FileTooBig,
        readFileAlloc(std.testing.allocator, files.event_log_path, file_header_size + simulated_single_payload_cap),
    );
    try std.testing.expectEqual(last_seq, try readLastSeq(std.testing.allocator, files.event_log_path));

    var reopened = (try openExistingSession(std.testing.allocator, sessions_dir, "session:stream/recovery")).?;
    defer reopened.deinit(std.testing.allocator);
    try std.testing.expectEqual(last_seq, reopened.last_seq);

    try appendFile(std.testing.allocator, files.event_log_path, "invalid-tail", 0o600, false);
    try repairEventLog(std.testing.allocator, files.event_log_path, "session:stream/recovery");
    try std.testing.expectEqual(last_seq, try readLastSeq(std.testing.allocator, files.event_log_path));

    const repaired_file = (try openReadFile(std.testing.allocator, files.event_log_path)).?;
    defer _ = std.c.close(repaired_file.fd);
    try std.testing.expectEqual(expected_size, repaired_file.size);
}

test "event log replay output enforces max bytes for oversized newest frame" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const sessions_dir = try std.fmt.allocPrint(
        std.testing.allocator,
        ".zig-cache/tmp/{s}/sessions",
        .{tmp.sub_path},
    );
    defer std.testing.allocator.free(sessions_dir);

    var files = try resetPersistentSession(std.testing.allocator, sessions_dir, "session:replay/cap");
    defer files.deinit(std.testing.allocator);

    var last_seq = files.last_seq;
    _ = try appendOutput(std.testing.allocator, files.event_log_path, null, &last_seq, "oversized");

    const zero_frames = try readReplayOutputFrames(std.testing.allocator, files.event_log_path, 0);
    defer deinitOwnedFrames(std.testing.allocator, zero_frames);
    try std.testing.expectEqual(@as(usize, 0), zero_frames.len);

    const capped_frames = try readReplayOutputFrames(std.testing.allocator, files.event_log_path, 4);
    defer deinitOwnedFrames(std.testing.allocator, capped_frames);
    try std.testing.expectEqual(@as(usize, 0), capped_frames.len);
}

test "event log parser deterministic malformed-input sweep" {
    var prng = std.Random.DefaultPrng.init(0x54414f5f45564c47);
    const random = prng.random();

    var buffer: [256]u8 = undefined;
    var case_index: usize = 0;
    while (case_index < 256) : (case_index += 1) {
        const len = random.uintLessThan(usize, buffer.len + 1);
        random.bytes(buffer[0..len]);

        var recorder = struct {
            count: usize = 0,
            last_seq: u64 = 0,
            pub fn visit(self: *@This(), frame: Frame) !void {
                try std.testing.expect(frame.seq > self.last_seq);
                try std.testing.expect(frame.payload.len <= max_payload_bytes);
                self.count += 1;
                self.last_seq = frame.seq;
            }
        }{};

        const result = try parseFrames(buffer[0..len], &recorder);
        try std.testing.expect(result.valid_bytes <= len);
        try std.testing.expectEqual(result.frames_seen, recorder.count);
    }
}

fn persistentSessionFilesForAllocationFailure(allocator: std.mem.Allocator, sessions_dir: []const u8) !void {
    var files = try resetPersistentSession(allocator, sessions_dir, "session:oom/test");
    defer files.deinit(allocator);

    try appendFramePath(allocator, files.event_log_path, .output, 1, "hello");
    const frames = try readReplayOutputFrames(allocator, files.event_log_path, max_replay_bytes);
    defer deinitOwnedFrames(allocator, frames);
    try std.testing.expectEqual(@as(usize, 1), frames.len);
}

test "event log session file ownership cleans up on OOM" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const sessions_dir = try std.fmt.allocPrint(
        std.testing.allocator,
        ".zig-cache/tmp/{s}/sessions",
        .{tmp.sub_path},
    );
    defer std.testing.allocator.free(sessions_dir);

    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        persistentSessionFilesForAllocationFailure,
        .{sessions_dir},
    );
}
