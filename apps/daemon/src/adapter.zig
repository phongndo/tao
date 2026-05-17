const std = @import("std");

const adapter_output_max = 64 * 1024;

const known_providers = [_]Provider{ .pi, .codex, .claude };

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

pub const Context = struct {
    terminal_session_id: []const u8,
    session_dir: ?[]const u8 = null,
    event_log_path: ?[]const u8 = null,
    excerpt_path: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    argv: []const []const u8,
};

pub const Detection = struct {
    provider: Provider,
    native_session_id: ?[]u8 = null,
    resume_argv_json: ?[]u8 = null,

    pub fn deinit(self: *Detection, allocator: std.mem.Allocator) void {
        if (self.native_session_id) |value| allocator.free(value);
        if (self.resume_argv_json) |value| allocator.free(value);
        self.* = undefined;
    }
};

const ScriptResponse = struct {
    detected: ?bool = null,
    nativeSessionId: ?[]const u8 = null,
    argv: ?[][]const u8 = null,
};

const CommandResponse = struct {
    detected: ?bool = null,
    native_session_id: ?[]u8 = null,
    argv_json: ?[]u8 = null,

    fn deinit(self: *CommandResponse, allocator: std.mem.Allocator) void {
        if (self.native_session_id) |value| allocator.free(value);
        if (self.argv_json) |value| allocator.free(value);
        self.* = undefined;
    }
};

pub fn detectSessionAlloc(
    allocator: std.mem.Allocator,
    adapters_dir: []const u8,
    context: Context,
) !?Detection {
    for (known_providers) |provider| {
        const script_path = try adapterScriptPathAlloc(allocator, adapters_dir, provider);
        defer allocator.free(script_path);

        var detect_response = (runAdapterCommandAlloc(
            allocator,
            script_path,
            provider,
            context,
            "detect",
            null,
        ) catch |err| blk: {
            std.log.warn("agent adapter {s} detect failed: {t}", .{ provider.text(), err });
            break :blk null;
        }) orelse continue;
        defer detect_response.deinit(allocator);

        if (detect_response.detected != true) continue;

        var native_session_id: ?[]u8 = if (detect_response.native_session_id) |value|
            try allocator.dupe(u8, value)
        else if (discoverNativeSessionIdArgv(context.argv)) |value|
            try allocator.dupe(u8, value)
        else
            null;
        errdefer if (native_session_id) |value| allocator.free(value);

        if (native_session_id == null) {
            var discover_response = (runAdapterCommandAlloc(
                allocator,
                script_path,
                provider,
                context,
                "discover-session",
                null,
            ) catch |err| blk: {
                std.log.warn("agent adapter {s} session discovery failed: {t}", .{ provider.text(), err });
                break :blk null;
            }) orelse CommandResponse{};
            defer discover_response.deinit(allocator);

            if (discover_response.native_session_id) |value| {
                native_session_id = try allocator.dupe(u8, value);
            }
        }

        var resume_argv_json: ?[]u8 = null;
        errdefer if (resume_argv_json) |value| allocator.free(value);

        if (native_session_id) |native_id| {
            var resume_response = (runAdapterCommandAlloc(
                allocator,
                script_path,
                provider,
                context,
                "resume-command",
                native_id,
            ) catch |err| blk: {
                std.log.warn("agent adapter {s} resume command failed: {t}", .{ provider.text(), err });
                break :blk null;
            }) orelse CommandResponse{};
            defer resume_response.deinit(allocator);

            resume_argv_json = if (resume_response.argv_json) |json|
                try allocator.dupe(u8, json)
            else
                try resumeArgvJsonAlloc(
                    allocator,
                    provider,
                    if (context.argv.len > 0) context.argv[0] else provider.text(),
                    native_id,
                );
        }

        return .{
            .provider = provider,
            .native_session_id = native_session_id,
            .resume_argv_json = resume_argv_json,
        };
    }

    return detectSessionHeuristicAlloc(allocator, context.argv);
}

pub fn detectSessionHeuristicAlloc(allocator: std.mem.Allocator, argv: []const []const u8) !?Detection {
    const provider = Provider.detectArgv(argv);
    if (provider == .unknown) return null;

    const native = discoverNativeSessionIdArgv(argv);
    const native_owned = if (native) |value| try allocator.dupe(u8, value) else null;
    errdefer if (native_owned) |value| allocator.free(value);

    const resume_json = if (native_owned) |value|
        try resumeArgvJsonAlloc(allocator, provider, argv[0], value)
    else
        null;
    errdefer if (resume_json) |value| allocator.free(value);

    return .{
        .provider = provider,
        .native_session_id = native_owned,
        .resume_argv_json = resume_json,
    };
}

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

fn adapterScriptPathAlloc(allocator: std.mem.Allocator, adapters_dir: []const u8, provider: Provider) ![]u8 {
    const file_name = try std.fmt.allocPrint(allocator, "{s}.ts", .{provider.text()});
    defer allocator.free(file_name);
    return try std.fs.path.join(allocator, &.{ adapters_dir, file_name });
}

fn runAdapterCommandAlloc(
    allocator: std.mem.Allocator,
    script_path: []const u8,
    provider: Provider,
    context: Context,
    command: []const u8,
    native_session_id: ?[]const u8,
) !?CommandResponse {
    if (!fileExists(script_path)) return null;

    const request_json = try adapterRequestJsonAlloc(allocator, command, provider, context, native_session_id);
    defer allocator.free(request_json);

    const runner = std.process.getEnvVarOwned(allocator, "TAOD_ADAPTER_RUNNER") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
    defer if (runner) |value| allocator.free(value);
    const default_runner = if (std.mem.endsWith(u8, script_path, ".ts")) "tsx" else "node";
    const runner_exe = if (runner) |value| if (value.len > 0) value else default_runner else default_runner;

    const child_argv = [_][]const u8{ runner_exe, script_path, request_json };
    const result = std.process.Child.run(.{
        .allocator = allocator,
        .argv = &child_argv,
        .max_output_bytes = adapter_output_max,
    }) catch |err| switch (err) {
        error.FileNotFound => {
            std.log.warn("agent adapter runner not found for {s}: {s}", .{ provider.text(), runner_exe });
            return null;
        },
        else => return err,
    };
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);

    switch (result.term) {
        .Exited => |code| if (code != 0) {
            std.log.warn("agent adapter {s} command {s} exited with code {d}: {s}", .{ provider.text(), command, code, result.stderr });
            return null;
        },
        else => |term| {
            std.log.warn("agent adapter {s} command {s} ended unexpectedly: {any}", .{ provider.text(), command, term });
            return null;
        },
    }

    const line = firstJsonLine(result.stdout) orelse return null;
    return try parseCommandResponseAlloc(allocator, line);
}

fn parseCommandResponseAlloc(allocator: std.mem.Allocator, line: []const u8) !CommandResponse {
    var parsed = try std.json.parseFromSlice(ScriptResponse, allocator, line, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    const native_session_id = if (parsed.value.nativeSessionId) |value| try allocator.dupe(u8, value) else null;
    errdefer if (native_session_id) |value| allocator.free(value);
    const argv_json = if (parsed.value.argv) |argv| try argvJsonAlloc(allocator, argv) else null;
    errdefer if (argv_json) |value| allocator.free(value);

    return .{
        .detected = parsed.value.detected,
        .native_session_id = native_session_id,
        .argv_json = argv_json,
    };
}

fn adapterRequestJsonAlloc(
    allocator: std.mem.Allocator,
    command: []const u8,
    provider: Provider,
    context: Context,
    native_session_id: ?[]const u8,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    try out.writer.writeByte('{');
    try writeJsonStringField(&out.writer, "command", command, false);
    try writeJsonStringField(&out.writer, "provider", provider.text(), true);
    try writeJsonStringField(&out.writer, "terminalSessionId", context.terminal_session_id, true);
    try writeOptionalJsonStringField(&out.writer, "sessionDir", context.session_dir, true);
    try writeOptionalJsonStringField(&out.writer, "eventLogPath", context.event_log_path, true);
    try writeOptionalJsonStringField(&out.writer, "excerptPath", context.excerpt_path, true);
    try writeOptionalJsonStringField(&out.writer, "cwd", context.cwd, true);
    try writeOptionalJsonStringField(&out.writer, "nativeSessionId", native_session_id, true);
    try out.writer.writeAll(",\"argv\":[");
    for (context.argv, 0..) |arg, index| {
        if (index > 0) try out.writer.writeByte(',');
        try out.writer.print("{f}", .{std.json.fmt(arg, .{})});
    }
    try out.writer.writeAll("]}");

    return try out.toOwnedSlice();
}

fn writeJsonStringField(writer: *std.Io.Writer, key: []const u8, value: []const u8, needs_comma: bool) !void {
    if (needs_comma) try writer.writeByte(',');
    try writer.print("\"{s}\":{f}", .{ key, std.json.fmt(value, .{}) });
}

fn writeOptionalJsonStringField(writer: *std.Io.Writer, key: []const u8, value: ?[]const u8, needs_comma: bool) !void {
    if (needs_comma) try writer.writeByte(',');
    try writer.print("\"{s}\":", .{key});
    if (value) |text| {
        try writer.print("{f}", .{std.json.fmt(text, .{})});
    } else {
        try writer.writeAll("null");
    }
}

fn firstJsonLine(stdout: []const u8) ?[]const u8 {
    var remaining = stdout;
    while (remaining.len > 0) {
        const newline = std.mem.indexOfScalar(u8, remaining, '\n') orelse remaining.len;
        const line = std.mem.trim(u8, remaining[0..newline], " \t\r\n");
        if (line.len > 0 and (line[0] == '{' or line[0] == '[')) return line;
        if (newline == remaining.len) return null;
        remaining = remaining[newline + 1 ..];
    }
    return null;
}

fn fileExists(path: []const u8) bool {
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
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

test "agent adapter request and response JSON are stable" {
    const request = try adapterRequestJsonAlloc(std.testing.allocator, "detect", .pi, .{
        .terminal_session_id = "session-1",
        .session_dir = "/tmp/session-1",
        .event_log_path = "/tmp/session-1/events.taoev",
        .excerpt_path = "/tmp/session-1/excerpt.txt",
        .cwd = "/project",
        .argv = &.{ "pi", "--session", "native-1" },
    }, null);
    defer std.testing.allocator.free(request);

    try std.testing.expect(std.mem.indexOf(u8, request, "\"command\":\"detect\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, request, "\"provider\":\"pi\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, request, "\"argv\":[\"pi\",\"--session\",\"native-1\"]") != null);

    var response = try parseCommandResponseAlloc(std.testing.allocator,
        \\{"detected":true,"nativeSessionId":"native-1","argv":["pi","--session","native-1"]}
    );
    defer response.deinit(std.testing.allocator);
    try std.testing.expect(response.detected == true);
    try std.testing.expectEqualStrings("native-1", response.native_session_id.?);
    try std.testing.expectEqualStrings("[\"pi\",\"--session\",\"native-1\"]", response.argv_json.?);
}

test "agent adapter external detection falls back to argv heuristics" {
    var detection = (try detectSessionAlloc(std.testing.allocator, "/definitely/missing/adapters", .{
        .terminal_session_id = "session-1",
        .argv = &.{ "claude", "--resume", "native-claude" },
    })).?;
    defer detection.deinit(std.testing.allocator);

    try std.testing.expectEqual(Provider.claude, detection.provider);
    try std.testing.expectEqualStrings("native-claude", detection.native_session_id.?);
    try std.testing.expectEqualStrings("[\"claude\",\"--resume\",\"native-claude\"]", detection.resume_argv_json.?);
}

test "agent adapter external detection executes TypeScript adapters" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.writeFile(.{ .sub_path = "pi.ts", .data = 
        \\const msg: Record<string, unknown> = JSON.parse(process.argv[2] || '{}')
        \\const toSession = (id: unknown): string => String(id)
        \\switch (msg.command) {
        \\  case 'detect':
        \\    console.log(JSON.stringify({ detected: true, nativeSessionId: 'adapter-native' }))
        \\    break
        \\  case 'resume-command':
        \\    console.log(JSON.stringify({ argv: ['pi', '--session', toSession(msg.nativeSessionId)] }))
        \\    break
        \\  default:
        \\    console.log(JSON.stringify({ detected: false }))
        \\}
    });

    const adapters_dir = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer std.testing.allocator.free(adapters_dir);

    var detection = (try detectSessionAlloc(std.testing.allocator, adapters_dir, .{
        .terminal_session_id = "session-1",
        .argv = &.{"pi"},
    })).?;
    defer detection.deinit(std.testing.allocator);

    try std.testing.expectEqual(Provider.pi, detection.provider);
    try std.testing.expectEqualStrings("adapter-native", detection.native_session_id.?);
    try std.testing.expectEqualStrings("[\"pi\",\"--session\",\"adapter-native\"]", detection.resume_argv_json.?);
}
