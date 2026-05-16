const std = @import("std");

pub const Provider = enum {
    pi,
    codex,
    claude,
    unknown,

    pub fn text(self: Provider) []const u8 {
        return switch (self) {
            .pi => "pi",
            .codex => "codex",
            .claude => "claude",
            .unknown => "unknown",
        };
    }

    pub fn detectArgv(argv: []const []const u8) Provider {
        if (argv.len == 0) return .unknown;
        const exe = std.fs.path.basename(argv[0]);
        if (std.mem.eql(u8, exe, "pi")) return .pi;
        if (std.mem.eql(u8, exe, "codex")) return .codex;
        if (std.mem.eql(u8, exe, "claude")) return .claude;
        return .unknown;
    }
};

pub const Session = struct {
    provider: Provider,
    native_session_id: ?[]const u8 = null,
};

pub fn discoverNativeSessionIdArgv(argv: []const []const u8) ?[]const u8 {
    var index: usize = 0;
    while (index < argv.len) : (index += 1) {
        const arg = argv[index];
        if (valueAfterPrefix(arg, "--session=")) |value| return nonEmpty(value);
        if (valueAfterPrefix(arg, "--session-id=")) |value| return nonEmpty(value);
        if (valueAfterPrefix(arg, "--conversation=")) |value| return nonEmpty(value);
        if (valueAfterPrefix(arg, "--resume=")) |value| return nonEmpty(value);

        if (isSessionValueFlag(arg)) {
            if (index + 1 < argv.len) return nonEmpty(argv[index + 1]);
            return null;
        }

        if (std.mem.eql(u8, arg, "resume") and index + 1 < argv.len) {
            return nonEmpty(argv[index + 1]);
        }
    }
    return null;
}

pub fn resumeArgvJsonAlloc(
    allocator: std.mem.Allocator,
    provider: Provider,
    executable: []const u8,
    native_session_id: []const u8,
) !?[]u8 {
    if (provider == .unknown or native_session_id.len == 0) return null;

    const exe = if (executable.len > 0) executable else provider.text();
    switch (provider) {
        .pi => {
            const argv = [_][]const u8{ exe, "--session", native_session_id };
            return try argvJsonAlloc(allocator, &argv);
        },
        .codex => {
            const argv = [_][]const u8{ exe, "resume", native_session_id };
            return try argvJsonAlloc(allocator, &argv);
        },
        .claude => {
            const argv = [_][]const u8{ exe, "--resume", native_session_id };
            return try argvJsonAlloc(allocator, &argv);
        },
        .unknown => return null,
    }
}

fn isSessionValueFlag(arg: []const u8) bool {
    return std.mem.eql(u8, arg, "--session") or
        std.mem.eql(u8, arg, "--session-id") or
        std.mem.eql(u8, arg, "--conversation") or
        std.mem.eql(u8, arg, "--resume") or
        std.mem.eql(u8, arg, "-r");
}

fn valueAfterPrefix(arg: []const u8, prefix: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, arg, prefix)) return null;
    return arg[prefix.len..];
}

fn nonEmpty(value: []const u8) ?[]const u8 {
    if (value.len == 0 or value[0] == '-') return null;
    return value;
}

fn argvJsonAlloc(allocator: std.mem.Allocator, argv: []const []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    try out.writer.writeByte('[');
    for (argv, 0..) |arg, index| {
        if (index > 0) try out.writer.writeByte(',');
        try out.writer.print("{f}", .{std.json.fmt(arg, .{})});
    }
    try out.writer.writeByte(']');

    return try out.toOwnedSlice();
}

test "agent provider detection uses argv executable name" {
    try std.testing.expectEqual(Provider.pi, Provider.detectArgv(&.{"/usr/local/bin/pi"}));
    try std.testing.expectEqualStrings("pi", Provider.pi.text());
    try std.testing.expectEqual(Provider.unknown, Provider.detectArgv(&.{"bash"}));
}

test "agent adapter extracts native session ids from common argv shapes" {
    try std.testing.expectEqualStrings("abc", discoverNativeSessionIdArgv(&.{ "pi", "--session", "abc" }).?);
    try std.testing.expectEqualStrings("def", discoverNativeSessionIdArgv(&.{ "codex", "resume", "def" }).?);
    try std.testing.expectEqualStrings("ghi", discoverNativeSessionIdArgv(&.{ "claude", "--resume=ghi" }).?);
    try std.testing.expect(discoverNativeSessionIdArgv(&.{ "codex", "--session" }) == null);
}

test "agent adapter builds conservative resume argv JSON" {
    const json = (try resumeArgvJsonAlloc(std.testing.allocator, .codex, "codex", "native-1")).?;
    defer std.testing.allocator.free(json);
    try std.testing.expectEqualStrings("[\"codex\",\"resume\",\"native-1\"]", json);
}
