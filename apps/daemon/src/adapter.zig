const std = @import("std");
const builtin = @import("builtin");

const adapter_output_max = 64 * 1024;
const adapter_command_timeout_ms = 3000;
const adapter_kill_grace_ms = 250;

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
    switch (adapterDirTrustStatus(adapters_dir)) {
        .trusted => {},
        .missing => return detectSessionHeuristicAlloc(allocator, context.argv),
        .untrusted => {
            std.log.warn("agent adapter directory is not trusted; falling back to argv heuristics", .{});
            return detectSessionHeuristicAlloc(allocator, context.argv);
        },
    }

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

fn isAllowedAdapterRunner(runner: []const u8) bool {
    const basename = std.fs.path.basename(runner);
    return std.mem.eql(u8, basename, "node") or std.mem.eql(u8, basename, "tsx");
}

fn adapterRunnerOrDefault(runner: ?[]const u8, default_runner: []const u8) ?[]const u8 {
    const value = runner orelse return default_runner;
    if (value.len == 0) return default_runner;
    if (!isAllowedAdapterRunner(value)) return null;
    return value;
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
    if (!isTrustedAdapterScript(script_path)) {
        std.log.warn("agent adapter script is not trusted for {s}; skipping", .{provider.text()});
        return null;
    }

    const runner = std.process.getEnvVarOwned(allocator, "TAUD_ADAPTER_RUNNER") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
    defer if (runner) |value| allocator.free(value);
    const default_runner = if (std.mem.endsWith(u8, script_path, ".ts")) "tsx" else "node";
    const runner_exe = adapterRunnerOrDefault(runner, default_runner) orelse {
        std.log.warn("ignoring unsafe TAUD_ADAPTER_RUNNER value for {s}", .{provider.text()});
        return null;
    };

    return try runAdapterCommandWithRunnerAlloc(
        allocator,
        runner_exe,
        script_path,
        provider,
        context,
        command,
        native_session_id,
        adapter_command_timeout_ms,
    );
}

fn runAdapterCommandWithRunnerAlloc(
    allocator: std.mem.Allocator,
    runner_exe: []const u8,
    script_path: []const u8,
    provider: Provider,
    context: Context,
    command: []const u8,
    native_session_id: ?[]const u8,
    timeout_ms: i64,
) !?CommandResponse {
    if (!fileExists(script_path)) return null;

    const request_json = try adapterRequestJsonAlloc(allocator, command, provider, context, native_session_id);
    defer allocator.free(request_json);

    const child_argv = [_][]const u8{ runner_exe, script_path, request_json };
    const result = runAdapterProcessWithTimeoutAlloc(allocator, &child_argv, timeout_ms) catch |err| switch (err) {
        error.FileNotFound => {
            std.log.warn("agent adapter runner not found for {s}: {s}", .{ provider.text(), runner_exe });
            return null;
        },
        error.AdapterTimedOut => {
            std.log.warn("agent adapter {s} command {s} timed out after {d}ms", .{ provider.text(), command, timeout_ms });
            return null;
        },
        else => return err,
    };
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);

    switch (result.term) {
        .Exited => |code| if (code != 0) {
            std.log.warn("agent adapter {s} command {s} exited with code {d}; stderr redacted ({d} bytes)", .{ provider.text(), command, code, result.stderr.len });
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

const AdapterDirTrust = enum {
    missing,
    untrusted,
    trusted,
};

fn adapterDirTrustStatus(path: []const u8) AdapterDirTrust {
    var dir = std.fs.cwd().openDir(path, .{}) catch |err| switch (err) {
        error.FileNotFound => return .missing,
        else => return .untrusted,
    };
    dir.close();
    return if (pathModeIsNotGroupOrOtherWritable(path)) .trusted else .untrusted;
}

fn isTrustedAdapterScript(path: []const u8) bool {
    const file = std.fs.cwd().openFile(path, .{ .mode = .read_only }) catch return false;
    file.close();
    return pathModeIsNotGroupOrOtherWritable(path);
}

fn pathModeIsNotGroupOrOtherWritable(path: []const u8) bool {
    const stat = std.fs.cwd().statFile(path) catch return false;
    return (stat.mode & @as(std.fs.File.Mode, 0o022)) == 0;
}

const AdapterChildResult = struct {
    done: std.atomic.Value(bool) = .init(false),
    term: ?std.process.Child.Term = null,
    stdout: ?[]u8 = null,
    stderr: ?[]u8 = null,
    err: ?anyerror = null,

    fn deinit(self: *AdapterChildResult, allocator: std.mem.Allocator) void {
        if (self.stdout) |value| allocator.free(value);
        if (self.stderr) |value| allocator.free(value);
        self.* = undefined;
    }
};

fn collectAdapterChild(
    child: *std.process.Child,
    allocator: std.mem.Allocator,
    result: *AdapterChildResult,
) void {
    collectAdapterChildFallible(child, allocator, result) catch |err| {
        result.err = err;
    };
    result.done.store(true, .release);
}

fn collectAdapterChildFallible(
    child: *std.process.Child,
    allocator: std.mem.Allocator,
    result: *AdapterChildResult,
) !void {
    var stdout: std.ArrayList(u8) = .empty;
    defer stdout.deinit(allocator);
    var stderr: std.ArrayList(u8) = .empty;
    defer stderr.deinit(allocator);

    child.collectOutput(allocator, &stdout, &stderr, adapter_output_max) catch |err| {
        _ = child.kill() catch {};
        return err;
    };

    result.stdout = try stdout.toOwnedSlice(allocator);
    errdefer if (result.stdout) |value| {
        allocator.free(value);
        result.stdout = null;
    };
    result.stderr = try stderr.toOwnedSlice(allocator);
    errdefer if (result.stderr) |value| {
        allocator.free(value);
        result.stderr = null;
    };
    result.term = try child.wait();
}

fn runAdapterProcessWithTimeoutAlloc(
    allocator: std.mem.Allocator,
    argv: []const []const u8,
    timeout_ms: i64,
) !std.process.Child.RunResult {
    std.debug.assert(timeout_ms > 0);

    var child = std.process.Child.init(argv, allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Pipe;

    try child.spawn();
    errdefer {
        _ = child.kill() catch {};
    }

    var result = AdapterChildResult{};

    const thread = try std.Thread.spawn(.{}, collectAdapterChild, .{ &child, allocator, &result });
    const deadline_ms = std.time.milliTimestamp() + timeout_ms;
    var timed_out = false;
    while (!result.done.load(.acquire)) {
        if (std.time.milliTimestamp() >= deadline_ms) {
            timed_out = true;
            terminateTimedOutAdapterChild(&child, &result);
            break;
        }
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    thread.join();

    if (timed_out) {
        result.deinit(allocator);
        return error.AdapterTimedOut;
    }
    if (result.err) |err| {
        result.deinit(allocator);
        return err;
    }

    const stdout = result.stdout orelse return error.ProcessTerminated;
    errdefer allocator.free(stdout);
    const stderr = result.stderr orelse {
        allocator.free(stdout);
        return error.ProcessTerminated;
    };
    errdefer allocator.free(stderr);
    const term = result.term orelse {
        allocator.free(stdout);
        allocator.free(stderr);
        return error.ProcessTerminated;
    };
    result.stdout = null;
    result.stderr = null;
    return .{
        .term = term,
        .stdout = stdout,
        .stderr = stderr,
    };
}

fn terminateTimedOutAdapterChild(child: *std.process.Child, result: *AdapterChildResult) void {
    signalAdapterChild(child, .term);
    const deadline_ms = std.time.milliTimestamp() + adapter_kill_grace_ms;
    while (!result.done.load(.acquire) and std.time.milliTimestamp() < deadline_ms) {
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    if (!result.done.load(.acquire)) signalAdapterChild(child, .kill);
}

const AdapterSignal = enum { term, kill };

fn signalAdapterChild(child: *std.process.Child, signal: AdapterSignal) void {
    if (builtin.os.tag == .windows) {
        _ = child.kill() catch {};
        return;
    }
    switch (signal) {
        .term => std.posix.kill(child.id, std.posix.SIG.TERM) catch {},
        .kill => std.posix.kill(child.id, std.posix.SIG.KILL) catch {},
    }
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
        .event_log_path = "/tmp/session-1/events.tauev",
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

test "agent adapter runner allowlist rejects shell-shaped env runners" {
    try std.testing.expectEqualStrings("tsx", adapterRunnerOrDefault(null, "tsx").?);
    try std.testing.expectEqualStrings("node", adapterRunnerOrDefault("", "node").?);
    try std.testing.expectEqualStrings("/usr/local/bin/tsx", adapterRunnerOrDefault("/usr/local/bin/tsx", "node").?);
    try std.testing.expect(adapterRunnerOrDefault("sh", "node") == null);
    try std.testing.expect(adapterRunnerOrDefault("node --eval", "node") == null);
}

test "agent adapter ignores group-writable adapter directory" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const script =
        \\const request = JSON.parse(process.argv[2])
        \\if (request.command === 'detect') {
        \\  console.log(JSON.stringify({ detected: true, nativeSessionId: 'untrusted-native' }))
        \\}
    ;
    try tmp.dir.writeFile(.{ .sub_path = "pi.ts", .data = script });

    const adapters_dir = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer std.testing.allocator.free(adapters_dir);
    try chmodPathForTest(std.testing.allocator, adapters_dir, 0o770);

    const detection = try detectSessionAlloc(std.testing.allocator, adapters_dir, .{
        .terminal_session_id = "s",
        .argv = &[_][]const u8{"unknown-agent"},
    });
    try std.testing.expect(detection == null);
}

test "agent adapter command timeout returns no detection" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.writeFile(.{ .sub_path = "hang.js", .data = 
        \\setInterval(() => {}, 1000)
    });

    const script_path = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/hang.js", .{tmp.sub_path});
    defer std.testing.allocator.free(script_path);

    const started_at = std.time.milliTimestamp();
    const response = try runAdapterCommandWithRunnerAlloc(
        std.testing.allocator,
        "node",
        script_path,
        .pi,
        .{
            .terminal_session_id = "session-timeout",
            .argv = &.{"pi"},
        },
        "detect",
        null,
        100,
    );
    const elapsed_ms = std.time.milliTimestamp() - started_at;

    try std.testing.expect(response == null);
    try std.testing.expect(elapsed_ms < 3000);
}

fn chmodPathForTest(allocator: std.mem.Allocator, path: []const u8, mode: std.c.mode_t) !void {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const path_z = try allocator.dupeZ(u8, path);
    defer allocator.free(path_z);
    if (std.c.chmod(path_z.ptr, mode) != 0) return error.ChmodFailed;
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

fn adapterRequestForAllocationFailure(allocator: std.mem.Allocator) !void {
    const request = adapterRequestJsonAlloc(allocator, "resume-command", .pi, .{
        .terminal_session_id = "session-oom",
        .session_dir = "/tmp/session-oom",
        .event_log_path = "/tmp/session-oom/events.tauev",
        .excerpt_path = "/tmp/session-oom/excerpt.txt",
        .cwd = "/project",
        .argv = &.{ "pi", "--session", "native-oom" },
    }, "native-oom") catch |err| switch (err) {
        error.WriteFailed => return error.OutOfMemory,
        else => return err,
    };
    defer allocator.free(request);
    try std.testing.expect(std.mem.indexOf(u8, request, "\"nativeSessionId\":\"native-oom\"") != null);
}

fn heuristicDetectionForAllocationFailure(allocator: std.mem.Allocator) !void {
    var detection = (detectSessionHeuristicAlloc(allocator, &.{ "codex", "resume", "native-oom" }) catch |err| switch (err) {
        error.WriteFailed => return error.OutOfMemory,
        else => return err,
    }).?;
    defer detection.deinit(allocator);
    try std.testing.expectEqual(Provider.codex, detection.provider);
}

test "agent adapter allocation-heavy helpers clean up on OOM" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        adapterRequestForAllocationFailure,
        .{},
    );
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        heuristicDetectionForAllocationFailure,
        .{},
    );
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
