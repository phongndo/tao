const std = @import("std");
const adapter = @import("../adapter.zig");
const event_log = @import("../event_log.zig");
const session = @import("../session.zig");

const util = @import("util.zig");
const types = @import("types.zig");

const AgentDetectionSnapshot = types.AgentDetectionSnapshot;
const SearchExcerptSnapshot = types.SearchExcerptSnapshot;

const readSmallFileAlloc = util.readSmallFileAlloc;
const parseArgvJson = util.parseArgvJson;
const isResumableAgentStatus = util.isResumableAgentStatus;

pub fn agentDetectionSnapshotFromStoredArgvLocked(self: anytype, item: *const session.TerminalSession, status: []const u8) !?AgentDetectionSnapshot {
    if (!self.persistence.enabled) return null;
    const database = if (self.database) |*database| database else return null;
    var record = (database.findTerminalSessionById(self.allocator, item.id) catch |err| {
        std.log.warn("failed to load terminal argv for agent refresh {s}: {t}", .{ item.id, err });
        return null;
    }) orelse return null;
    defer record.deinit(self.allocator);

    const argv_json = record.argv_json orelse return null;
    var parsed_argv = parseArgvJson(self.allocator, argv_json) catch |err| {
        std.log.warn("failed to parse terminal argv for agent refresh {s}: {t}", .{ item.id, err });
        return null;
    };
    defer parsed_argv.deinit();

    const parsed_items = parsed_argv.items();
    if (parsed_items.len == 0) return null;

    return self.agentDetectionSnapshotFromArgvLocked(item, parsed_items, argv_json, status);
}

pub fn agentDetectionSnapshotFromArgvLocked(
    self: anytype,
    item: *const session.TerminalSession,
    argv_items: []const []const u8,
    original_argv_json: ?[]const u8,
    status: []const u8,
) !?AgentDetectionSnapshot {
    if (!self.persistence.enabled) return null;
    if (self.database == null) return null;
    if (argv_items.len == 0) return null;

    const argv = try self.allocator.alloc([]const u8, argv_items.len);
    var argv_count: usize = 0;
    var argv_owned_by_result = false;
    errdefer {
        if (!argv_owned_by_result) {
            for (argv[0..argv_count]) |arg| self.allocator.free(arg);
            self.allocator.free(argv);
        }
    }
    for (argv_items, 0..) |arg, index| {
        argv[index] = try self.allocator.dupe(u8, arg);
        argv_count += 1;
    }

    var result: AgentDetectionSnapshot = .{
        .terminal_session_id = try self.allocator.dupe(u8, item.id),
        .session_dir = null,
        .event_log_path = null,
        .excerpt_path = null,
        .cwd = null,
        .argv = argv,
        .original_argv_json = null,
        .status = status,
    };
    argv_owned_by_result = true;
    errdefer result.deinit(self.allocator);

    result.session_dir = if (item.session_dir) |value| try self.allocator.dupe(u8, value) else null;
    result.event_log_path = if (item.event_log_path) |value| try self.allocator.dupe(u8, value) else null;
    result.excerpt_path = if (item.excerpt_path) |value| try self.allocator.dupe(u8, value) else null;
    result.cwd = if (item.cwd) |value| try self.allocator.dupe(u8, value) else null;
    result.original_argv_json = if (original_argv_json) |value| try self.allocator.dupe(u8, value) else null;

    return result;
}

pub fn recordAgentSessionFromSnapshot(self: anytype, snapshot_input: *const AgentDetectionSnapshot) void {
    var detected = (adapter.detectSessionAlloc(self.allocator, self.config.adapters_dir, .{
        .terminal_session_id = snapshot_input.terminal_session_id,
        .session_dir = snapshot_input.session_dir,
        .event_log_path = snapshot_input.event_log_path,
        .excerpt_path = snapshot_input.excerpt_path,
        .cwd = snapshot_input.cwd,
        .argv = snapshot_input.argv,
    }) catch |err| blk: {
        std.log.warn("failed to inspect agent adapter metadata for {s}: {t}", .{ snapshot_input.terminal_session_id, err });
        break :blk null;
    }) orelse return;
    defer detected.deinit(self.allocator);

    const provider = detected.provider;
    if (provider == .unknown) return;

    const agent_id = std.fmt.allocPrint(self.allocator, "agent-{s}-{s}", .{ snapshot_input.terminal_session_id, provider.text() }) catch |err| {
        std.log.warn("failed to allocate agent id for {s}: {t}", .{ snapshot_input.terminal_session_id, err });
        return;
    };
    defer self.allocator.free(agent_id);

    self.lock();
    defer self.unlock();
    if (!self.persistence.enabled) return;
    const database = if (self.database) |*database| database else return;
    database.recordAgentSession(.{
        .id = agent_id,
        .terminal_session_id = snapshot_input.terminal_session_id,
        .provider = provider.text(),
        .native_session_id = detected.native_session_id,
        .original_argv_json = snapshot_input.original_argv_json,
        .resume_argv_json = detected.resume_argv_json,
        .cwd = snapshot_input.cwd,
        .transcript_path = snapshot_input.excerpt_path,
        .status = if (detected.native_session_id != null and detected.resume_argv_json != null and isResumableAgentStatus(snapshot_input.status)) "resumable" else snapshot_input.status,
    }) catch |err| {
        std.log.warn("failed to record agent session {s}: {t}", .{ snapshot_input.terminal_session_id, err });
    };
}

pub fn refreshAgentSessionMetadataFromStoredArgvLocked(self: anytype, item: *const session.TerminalSession, status: []const u8) void {
    if (!self.persistence.enabled) return;
    const database = if (self.database) |*database| database else return;
    var record = (database.findTerminalSessionById(self.allocator, item.id) catch |err| {
        std.log.warn("failed to load terminal argv for agent refresh {s}: {t}", .{ item.id, err });
        return;
    }) orelse return;
    defer record.deinit(self.allocator);

    const argv_json = record.argv_json orelse return;
    var parsed_argv = parseArgvJson(self.allocator, argv_json) catch |err| {
        std.log.warn("failed to parse terminal argv for agent refresh {s}: {t}", .{ item.id, err });
        return;
    };
    defer parsed_argv.deinit();

    const argv = parsed_argv.items();
    if (argv.len == 0) return;
    self.recordAgentSessionLocked(item, argv, argv_json, status);
}

pub fn recordAgentSessionLocked(
    self: anytype,
    item: *const session.TerminalSession,
    argv: []const []const u8,
    original_argv_json: ?[]const u8,
    status: []const u8,
) void {
    if (!self.persistence.enabled) return;
    const database = if (self.database) |*database| database else return;
    var detected = (adapter.detectSessionAlloc(self.allocator, self.config.adapters_dir, .{
        .terminal_session_id = item.id,
        .session_dir = item.session_dir,
        .event_log_path = item.event_log_path,
        .excerpt_path = item.excerpt_path,
        .cwd = item.cwd,
        .argv = argv,
    }) catch |err| blk: {
        std.log.warn("failed to inspect agent adapter metadata for {s}: {t}", .{ item.id, err });
        break :blk null;
    }) orelse return;
    defer detected.deinit(self.allocator);

    const provider = detected.provider;
    if (provider == .unknown) return;

    const agent_id = std.fmt.allocPrint(self.allocator, "agent-{s}-{s}", .{ item.id, provider.text() }) catch |err| {
        std.log.warn("failed to allocate agent id for {s}: {t}", .{ item.id, err });
        return;
    };
    defer self.allocator.free(agent_id);

    database.recordAgentSession(.{
        .id = agent_id,
        .terminal_session_id = item.id,
        .provider = provider.text(),
        .native_session_id = detected.native_session_id,
        .original_argv_json = original_argv_json,
        .resume_argv_json = detected.resume_argv_json,
        .cwd = item.cwd,
        .transcript_path = item.excerpt_path,
        .status = if (detected.native_session_id != null and detected.resume_argv_json != null and isResumableAgentStatus(status)) "resumable" else status,
    }) catch |err| {
        std.log.warn("failed to record agent session {s}: {t}", .{ item.id, err });
    };
}

pub fn indexSearchExcerptFromSnapshot(self: anytype, snapshot_input: *const SearchExcerptSnapshot) void {
    const excerpt = readSmallFileAlloc(self.allocator, snapshot_input.excerpt_path, event_log.max_excerpt_bytes) catch |err| {
        std.log.warn("failed to read search excerpt for {s}: {t}", .{ snapshot_input.terminal_session_id, err });
        return;
    };
    defer if (excerpt) |bytes| self.allocator.free(bytes);
    const bytes = excerpt orelse return;
    if (bytes.len == 0) return;

    self.lock();
    defer self.unlock();
    if (!self.persistence.enabled) return;
    const database = if (self.database) |*database| database else return;

    database.recordTerminalSearch(.{
        .terminal_session_id = snapshot_input.terminal_session_id,
        .title = snapshot_input.title,
        .excerpt = bytes,
    }) catch |err| {
        std.log.warn("failed to index search excerpt for {s}: {t}", .{ snapshot_input.terminal_session_id, err });
    };
}
