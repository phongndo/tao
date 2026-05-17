const std = @import("std");

pub const file_magic = [_]u8{ 0x54, 0x41, 0x4f, 0x45, 0x56, 0x00, 0x01, 0x00 }; // TAOEV\0\1\0
pub const session_id_header_size: usize = 36;
pub const file_header_size: usize = file_magic.len + session_id_header_size + 8;
pub const frame_magic: u32 = 0x54414546; // TAEF
pub const frame_header_size: usize = 32;
pub const max_payload_bytes: u32 = 64 * 1024 * 1024;
pub const max_replay_bytes: usize = 1024 * 1024;
pub const max_excerpt_bytes: usize = 1024 * 1024;

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

pub fn encodeFrame(
    out: []u8,
    kind: FrameKind,
    seq: u64,
    monotonic_ms: u64,
    payload: []const u8,
) ![]u8 {
    if (payload.len > max_payload_bytes) return error.PayloadTooLarge;
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

    return out[0..total_len];
}

pub fn parseFrames(data: []const u8, visitor: anytype) !ParseResult {
    var offset: usize = 0;
    var valid_bytes: usize = 0;
    var frames_seen: usize = 0;
    var last_seq: u64 = 0;

    while (offset + frame_header_size <= data.len) {
        if (std.mem.readInt(u32, data[offset..][0..4], .big) != frame_magic) break;

        const version = std.mem.readInt(u16, data[offset + 4 ..][0..2], .big);
        const kind_raw = std.mem.readInt(u16, data[offset + 6 ..][0..2], .big);
        const seq = std.mem.readInt(u64, data[offset + 8 ..][0..8], .big);
        const monotonic_ms = std.mem.readInt(u64, data[offset + 16 ..][0..8], .big);
        const length = std.mem.readInt(u32, data[offset + 24 ..][0..4], .big);
        const expected_crc = std.mem.readInt(u32, data[offset + 28 ..][0..4], .big);
        const payload_start = offset + frame_header_size;
        const payload_end = payload_start + length;

        if (version != 1 or length > max_payload_bytes or payload_end > data.len) break;

        const payload = data[payload_start..payload_end];
        if (seq > last_seq and std.hash.Crc32.hash(payload) == expected_crc) {
            try visitor.visit(.{
                .kind = @enumFromInt(kind_raw),
                .seq = seq,
                .monotonic_ms = monotonic_ms,
                .payload = payload,
            });
            frames_seen += 1;
            last_seq = seq;
        }

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
    try writeFile(event_log_path, encoded, 0o600);
    try writeFile(excerpt_path, &.{}, 0o600);

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

    const data = try readFileAlloc(allocator, event_log_path, file_header_size + max_payload_bytes);
    defer if (data) |bytes| allocator.free(bytes);
    if (data == null or !hasValidHeader(data.?)) {
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
    const frame = try allocator.alloc(u8, encodedFrameSize(payload.len));
    defer allocator.free(frame);

    const encoded = try encodeFrame(frame, kind, seq, nowMs(), payload);
    try appendFile(path, encoded, 0o600);
}

pub fn appendOutput(
    allocator: std.mem.Allocator,
    event_log_path: []const u8,
    excerpt_path: ?[]const u8,
    last_seq: *u64,
    payload: []const u8,
) !u64 {
    last_seq.* += 1;
    try appendFramePath(allocator, event_log_path, .output, last_seq.*, payload);
    if (excerpt_path) |path| appendBoundedExcerpt(allocator, path, payload) catch {};
    return last_seq.*;
}

pub fn appendInput(
    allocator: std.mem.Allocator,
    event_log_path: []const u8,
    last_seq: *u64,
    payload: []const u8,
) !u64 {
    last_seq.* += 1;
    try appendFramePath(allocator, event_log_path, .input, last_seq.*, payload);
    return last_seq.*;
}

pub fn appendResize(
    allocator: std.mem.Allocator,
    event_log_path: []const u8,
    last_seq: *u64,
    cols: u16,
    rows: u16,
) !u64 {
    var payload: [4]u8 = undefined;
    std.mem.writeInt(u16, payload[0..2], cols, .big);
    std.mem.writeInt(u16, payload[2..4], rows, .big);

    last_seq.* += 1;
    try appendFramePath(allocator, event_log_path, .resize, last_seq.*, &payload);
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

    last_seq.* += 1;
    try appendFramePath(allocator, event_log_path, .exit, last_seq.*, &payload);
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

    last_seq.* += 1;
    try appendFramePath(allocator, event_log_path, .snapshot_mark, last_seq.*, payload);
    return last_seq.*;
}

pub fn readOwnedFrames(allocator: std.mem.Allocator, path: []const u8) ![]OwnedFrame {
    const data = try readFileAlloc(allocator, path, file_header_size + max_payload_bytes);
    defer if (data) |bytes| allocator.free(bytes);

    const bytes = data orelse return allocator.alloc(OwnedFrame, 0);
    var recorder = OwnedFrameRecorder{ .allocator = allocator };
    errdefer recorder.deinit();
    _ = try parseEventLog(bytes, &recorder);
    return recorder.frames.toOwnedSlice(allocator);
}

pub fn readReplayOutputFrames(
    allocator: std.mem.Allocator,
    path: []const u8,
    max_bytes: usize,
) ![]OwnedFrame {
    const frames = try readOwnedFrames(allocator, path);
    errdefer deinitOwnedFrames(allocator, frames);

    var total: usize = 0;
    var output_count: usize = 0;
    for (frames) |frame| {
        if (frame.kind == .output and frame.payload.len > 0) {
            total += frame.payload.len;
            output_count += 1;
        }
    }

    var keep_start: usize = 0;
    while (total > max_bytes and keep_start < frames.len) : (keep_start += 1) {
        if (frames[keep_start].kind != .output) continue;
        if (output_count <= 1) break;
        total -= frames[keep_start].payload.len;
        output_count -= 1;
    }

    var replay: std.ArrayList(OwnedFrame) = .empty;
    errdefer {
        for (replay.items) |*frame| frame.deinit(allocator);
        replay.deinit(allocator);
    }

    for (frames, 0..) |*frame, index| {
        if (frame.kind != .output or frame.payload.len == 0) {
            frame.deinit(allocator);
            continue;
        }
        if (index < keep_start) {
            frame.deinit(allocator);
            continue;
        }
        try replay.append(allocator, frame.*);
        frame.* = undefined;
    }
    allocator.free(frames);

    return replay.toOwnedSlice(allocator);
}

pub fn deinitOwnedFrames(allocator: std.mem.Allocator, frames: []OwnedFrame) void {
    for (frames) |*frame| frame.deinit(allocator);
    allocator.free(frames);
}

pub fn readLastSeq(allocator: std.mem.Allocator, path: []const u8) !u64 {
    const data = try readFileAlloc(allocator, path, file_header_size + max_payload_bytes);
    defer if (data) |bytes| allocator.free(bytes);

    const bytes = data orelse return 0;
    var last_seq: u64 = 0;
    var recorder = struct {
        value: *u64,
        pub fn visit(self: *@This(), frame: Frame) !void {
            self.value.* = frame.seq;
        }
    }{ .value = &last_seq };
    _ = try parseEventLog(bytes, &recorder);
    return last_seq;
}

fn repairEventLog(allocator: std.mem.Allocator, path: []const u8, session_id: []const u8) !void {
    const data = try readFileAlloc(allocator, path, file_header_size + max_payload_bytes);
    defer if (data) |bytes| allocator.free(bytes);

    if (data == null or !hasValidHeader(data.?)) {
        var header: [file_header_size]u8 = undefined;
        const encoded = try encodeFileHeader(&header, session_id, nowMs());
        try writeFile(path, encoded, 0o600);
        return;
    }

    var visitor = struct {
        pub fn visit(_: *@This(), _: Frame) !void {}
    }{};
    const result = try parseEventLog(data.?, &visitor);
    if (result.valid_bytes < data.?.len) try truncateFile(path, result.valid_bytes);
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

fn appendBoundedExcerpt(allocator: std.mem.Allocator, path: []const u8, payload: []const u8) !void {
    if (payload.len == 0) return;

    try appendFile(path, payload, 0o600);

    const data = (try readFileAlloc(allocator, path, max_excerpt_bytes + payload.len)) orelse return;
    defer allocator.free(data);
    if (data.len <= max_excerpt_bytes) return;

    try writeFile(path, data[data.len - max_excerpt_bytes ..], 0o600);
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

    return data[0..offset];
}

fn writeFile(path: []const u8, data: []const u8, mode: std.c.mode_t) !void {
    const allocator = std.heap.smp_allocator;
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

fn appendFile(path: []const u8, data: []const u8, mode: std.c.mode_t) !void {
    const allocator = std.heap.smp_allocator;
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
}

fn truncateFile(path: []const u8, size: usize) !void {
    const allocator = std.heap.smp_allocator;
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
    if (std.c.mkdir(path, mode) == 0) {
        _ = std.c.chmod(path, mode);
        return;
    }
    switch (std.posix.errno(-1)) {
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
    try std.testing.expectEqual(encoded.len, result.valid_bytes);
}
