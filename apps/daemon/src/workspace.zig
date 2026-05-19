const std = @import("std");
const db = @import("db.zig");
const git = @import("git.zig");
const rpc = @import("rpc.zig");
const worktree_name = @import("worktree_name.zig");

pub const ErrorCode = enum {
    invalid_workspace,
    invalid_path,
    git_failed,
    state_conflict,
    unauthorized,

    pub fn text(self: ErrorCode) []const u8 {
        return switch (self) {
            .invalid_workspace => "invalid-workspace",
            .invalid_path => "invalid-path",
            .git_failed => "git-failed",
            .state_conflict => "state-conflict",
            .unauthorized => "unauthorized",
        };
    }
};

pub const GitStatusResponse = struct {
    changed: u32,
    staged: u32,
};

pub const WorktreeResponse = struct {
    id: []const u8,
    workspace_id: []const u8,
    title: ?[]const u8 = null,
    folder_name: []const u8,
    path: []const u8,
    branch: []const u8,
    base_branch: ?[]const u8 = null,
    target_branch: ?[]const u8 = null,
    state: []const u8,
    order_index: i64,
    last_active_tab_id: ?[]const u8 = null,
    last_error: ?[]const u8 = null,
    created_by: []const u8,
    created_at: []const u8,
    updated_at: []const u8,
    git_status: ?GitStatusResponse = null,
};

pub const WorkspaceResponse = struct {
    id: []const u8,
    name: []const u8,
    root_path: []const u8,
    git_common_dir: ?[]const u8 = null,
    workspace_slug: []const u8,
    default_branch: ?[]const u8 = null,
    branch: ?[]const u8 = null,
    order_index: i64,
    last_active_tab_id: ?[]const u8 = null,
    created_at: []const u8,
    updated_at: []const u8,
    git_status: ?GitStatusResponse = null,
    worktrees: []const WorktreeResponse = &.{},
};

const WorkspaceListPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    workspaces: []const WorkspaceResponse,
};

const WorkspacePayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    workspace: WorkspaceResponse,
};

pub fn errorJsonAlloc(allocator: std.mem.Allocator, request: rpc.ControlRequestJson, code: []const u8, message: []const u8) ![]u8 {
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = false,
        .error_code = code,
        .error_message = message,
    });
}

pub fn idAlloc(allocator: std.mem.Allocator, prefix: []const u8) ![]u8 {
    var random_bytes: [16]u8 = undefined;
    std.crypto.random.bytes(&random_bytes);
    var tv: std.c.timeval = .{ .sec = 0, .usec = 0 };
    _ = std.c.gettimeofday(&tv, null);
    return std.fmt.allocPrint(allocator, "{s}-{x:0>8}{x:0>4}{x:0>4}", .{
        prefix,
        @as(u32, @truncate(@as(u64, @intCast(tv.sec)))) ^ std.mem.readInt(u32, random_bytes[0..4], .big),
        std.mem.readInt(u16, random_bytes[4..6], .big),
        std.mem.readInt(u16, random_bytes[6..8], .big),
    });
}

pub fn canonicalPathAlloc(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    if (path.len == 0) return error.InvalidPath;
    if (std.fs.path.isAbsolute(path)) {
        return std.fs.realpathAlloc(allocator, path) catch |err| switch (err) {
            error.FileNotFound => error.InvalidPath,
            else => err,
        };
    }
    const cwd = try std.fs.cwd().realpathAlloc(allocator, ".");
    defer allocator.free(cwd);
    const joined = try std.fs.path.join(allocator, &.{ cwd, path });
    defer allocator.free(joined);
    return std.fs.realpathAlloc(allocator, joined) catch |err| switch (err) {
        error.FileNotFound => error.InvalidPath,
        else => err,
    };
}

pub fn handleAddLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorJsonAlloc(allocator, request, ErrorCode.state_conflict.text(), "database is unavailable");
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");

    const selected_path = canonicalPathAlloc(self.allocator, input_path) catch |err| {
        std.log.warn("workspace.add invalid path {s}: {t}", .{ input_path, err });
        return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "invalid workspace path");
    };
    defer self.allocator.free(selected_path);

    const git_root: ?[]u8 = git.toplevelAlloc(self.allocator, selected_path) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => null,
        else => return err,
    };
    defer if (git_root) |value| self.allocator.free(value);
    const root_path = git_root orelse selected_path;

    var existing = try database.findWorkspaceByRoot(self.allocator, root_path);
    defer if (existing) |*row| row.deinit(self.allocator);

    const git_common_dir: ?[]u8 = if (git_root != null) git.commonDirAlloc(self.allocator, root_path) catch null else null;
    defer if (git_common_dir) |value| self.allocator.free(value);
    const default_branch: ?[]u8 = if (git_root != null) git.defaultBranchAlloc(self.allocator, root_path) catch null else null;
    defer if (default_branch) |value| self.allocator.free(value);
    const workspace_slug = try worktree_name.workspaceSlugAlloc(self.allocator, root_path);
    defer self.allocator.free(workspace_slug);
    const name = request.name orelse std.fs.path.basename(root_path);

    var generated_workspace_id: ?[]u8 = null;
    defer if (generated_workspace_id) |value| self.allocator.free(value);
    const workspace_id = if (existing) |row| row.id else request.requestWorkspaceId() orelse blk: {
        generated_workspace_id = try idAlloc(self.allocator, "workspace");
        break :blk generated_workspace_id.?;
    };
    const order_index = if (existing) |row| row.order_index else request.requestOrderIndex() orelse try database.nextWorkspaceOrder();
    const last_active_tab_id = if (existing) |row| row.last_active_tab_id else null;

    if (existing == null) {
        if (request.requestWorkspaceId()) |requested_id| {
            if (try database.findWorkspaceById(self.allocator, requested_id)) |conflict_row| {
                var conflict = conflict_row;
                conflict.deinit(self.allocator);
                return errorJsonAlloc(allocator, request, ErrorCode.state_conflict.text(), "workspace id already exists");
            }
        }
    }

    if (existing) |_| {
        try database.updateWorkspace(.{
            .id = workspace_id,
            .name = name,
            .root_path = root_path,
            .git_common_dir = git_common_dir,
            .workspace_slug = workspace_slug,
            .default_branch = default_branch,
            .order_index = order_index,
            .last_active_tab_id = last_active_tab_id,
        });
    } else {
        try database.insertWorkspace(.{
            .id = workspace_id,
            .name = name,
            .root_path = root_path,
            .git_common_dir = git_common_dir,
            .workspace_slug = workspace_slug,
            .default_branch = default_branch,
            .order_index = order_index,
            .last_active_tab_id = last_active_tab_id,
        });
    }

    var fresh = (try database.findWorkspaceById(self.allocator, workspace_id)) orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_workspace.text(), "workspace not found");
    defer fresh.deinit(self.allocator);
    reconcileWorkspaceWorktrees(self, database, &fresh) catch |err| {
        std.log.warn("workspace.add worktree reconciliation failed for {s}: {t}", .{ fresh.root_path, err });
    };
    if (try database.findWorkspaceById(self.allocator, workspace_id)) |reconciled| {
        fresh.deinit(self.allocator);
        fresh = reconciled;
    }
    const responses = try workspaceResponsesAlloc(self, (&[_]db.WorkspaceRow{fresh})[0..], true);
    defer freeWorkspaceResponses(self.allocator, responses);

    return jsonAlloc(allocator, WorkspacePayload{
        .id = request.requestId(),
        .workspace = responses[0],
    });
}

pub fn handleListLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorJsonAlloc(allocator, request, ErrorCode.state_conflict.text(), "database is unavailable");
    const initial_rows = try database.listWorkspaces(self.allocator);
    defer {
        for (initial_rows) |*row| row.deinit(self.allocator);
        self.allocator.free(initial_rows);
    }

    for (initial_rows) |*row| {
        refreshWorkspaceGitMetadata(self, database, row) catch |err| {
            std.log.warn("workspace.list git metadata refresh failed for {s}: {t}", .{ row.root_path, err });
        };
        reconcileWorkspaceWorktrees(self, database, row) catch |err| {
            std.log.warn("workspace.list worktree reconciliation failed for {s}: {t}", .{ row.root_path, err });
        };
    }

    const rows = try database.listWorkspaces(self.allocator);
    defer {
        for (rows) |*row| row.deinit(self.allocator);
        self.allocator.free(rows);
    }

    const responses = try workspaceResponsesAlloc(self, rows, true);
    defer freeWorkspaceResponses(self.allocator, responses);

    return jsonAlloc(allocator, WorkspaceListPayload{
        .id = request.requestId(),
        .workspaces = responses,
    });
}

pub fn handleRefreshLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorJsonAlloc(allocator, request, ErrorCode.state_conflict.text(), "database is unavailable");
    const row = if (request.requestWorkspaceId()) |workspace_id|
        (try database.findWorkspaceById(self.allocator, workspace_id))
    else if (request.requestRootPath()) |root_path|
        (try database.findWorkspaceByRoot(self.allocator, root_path))
    else
        null;
    var workspace_row = row orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_workspace.text(), "workspace not found");
    defer workspace_row.deinit(self.allocator);

    refreshWorkspaceGitMetadata(self, database, &workspace_row) catch |err| {
        std.log.warn("workspace.refresh git metadata failed for {s}: {t}", .{ workspace_row.root_path, err });
    };
    reconcileWorkspaceWorktrees(self, database, &workspace_row) catch |err| {
        std.log.warn("workspace.refresh worktree reconciliation failed for {s}: {t}", .{ workspace_row.root_path, err });
    };

    if (try database.findWorkspaceById(self.allocator, workspace_row.id)) |fresh| {
        workspace_row.deinit(self.allocator);
        workspace_row = fresh;
    }

    const responses = try workspaceResponsesAlloc(self, (&[_]db.WorkspaceRow{workspace_row})[0..], true);
    defer freeWorkspaceResponses(self.allocator, responses);

    return jsonAlloc(allocator, WorkspacePayload{
        .id = request.requestId(),
        .workspace = responses[0],
    });
}

pub fn handleRemoveLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorJsonAlloc(allocator, request, ErrorCode.state_conflict.text(), "database is unavailable");
    const workspace_id = request.requestWorkspaceId() orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_workspace.text(), "workspace_id is required");
    try database.archiveWorkspace(workspace_id);
    try database.archiveWorktreesForWorkspace(workspace_id);
    return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
}

pub fn handleReorderLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorJsonAlloc(allocator, request, ErrorCode.state_conflict.text(), "database is unavailable");
    const workspace_id = request.requestWorkspaceId() orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_workspace.text(), "workspace_id is required");
    const order_index = request.requestOrderIndex() orelse return errorJsonAlloc(allocator, request, ErrorCode.state_conflict.text(), "order_index is required");
    try database.reorderWorkspace(workspace_id, order_index);
    return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
}

pub fn refreshWorkspaceGitMetadata(self: anytype, database: *db.Database, row: *const db.WorkspaceRow) !void {
    const common_dir: ?[]u8 = git.commonDirAlloc(self.allocator, row.root_path) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => null,
        else => return err,
    };
    defer if (common_dir) |value| self.allocator.free(value);
    const default_branch: ?[]u8 = if (common_dir != null) git.defaultBranchAlloc(self.allocator, row.root_path) catch null else null;
    defer if (default_branch) |value| self.allocator.free(value);
    const slug = try worktree_name.workspaceSlugAlloc(self.allocator, row.root_path);
    defer self.allocator.free(slug);
    try database.updateWorkspace(.{
        .id = row.id,
        .name = row.name,
        .root_path = row.root_path,
        .git_common_dir = common_dir,
        .workspace_slug = slug,
        .default_branch = default_branch,
        .order_index = row.order_index,
        .last_active_tab_id = row.last_active_tab_id,
    });
}

fn reconcileWorkspaceWorktrees(self: anytype, database: *db.Database, row: *const db.WorkspaceRow) !void {
    const entries = git.worktreeListAlloc(self.allocator, row.root_path) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return,
        else => return err,
    };
    defer {
        for (entries) |*entry| entry.deinit(self.allocator);
        self.allocator.free(entries);
    }

    pruneGitWorktrees(self.allocator, row.root_path);

    const known_rows = try database.listWorktreesForWorkspace(self.allocator, row.id);
    defer {
        for (known_rows) |*known| known.deinit(self.allocator);
        self.allocator.free(known_rows);
    }

    for (known_rows) |known| {
        if (findGitWorktree(self.allocator, entries, known.path)) |entry| {
            if (entry.prunable or !pathExists(known.path)) {
                try database.archiveWorktree(known.id);
                continue;
            }
            var branch_owned: ?[]u8 = null;
            defer if (branch_owned) |value| self.allocator.free(value);
            const branch = entry.branch orelse blk: {
                branch_owned = try worktree_name.detachedBranchForFolderAlloc(self.allocator, known.id);
                break :blk branch_owned.?;
            };
            try database.updateWorktreeGit(known.id, branch, "active");
        } else if (!pathExists(known.path)) {
            try database.archiveWorktree(known.id);
        } else {
            try database.updateWorktreeState(known.id, "missing", null);
        }
    }

    for (entries) |entry| {
        if (entry.bare) continue;
        if (entry.prunable) continue;
        if (samePath(self.allocator, entry.path, row.root_path)) continue;

        if (try findWorktreeByPathAny(self.allocator, database, entry.path)) |existing_row| {
            var existing = existing_row;
            defer existing.deinit(self.allocator);
            var branch_owned: ?[]u8 = null;
            defer if (branch_owned) |value| self.allocator.free(value);
            const branch = entry.branch orelse blk: {
                branch_owned = try worktree_name.detachedBranchForFolderAlloc(self.allocator, existing.id);
                break :blk branch_owned.?;
            };
            if (std.mem.eql(u8, existing.workspace_id, row.id)) {
                try database.updateWorktreeGit(existing.id, branch, "active");
            }
            continue;
        }

        const folder_name = try adoptedFolderNameAlloc(self.allocator, database, row.id, entry.path);
        defer self.allocator.free(folder_name);
        const worktree_id = try idAlloc(self.allocator, "worktree");
        defer self.allocator.free(worktree_id);
        var branch_owned: ?[]u8 = null;
        defer if (branch_owned) |value| self.allocator.free(value);
        const branch = entry.branch orelse blk: {
            branch_owned = try worktree_name.detachedBranchForFolderAlloc(self.allocator, worktree_id);
            break :blk branch_owned.?;
        };
        const title = branch;
        try database.insertWorktree(.{
            .id = worktree_id,
            .workspace_id = row.id,
            .title = title,
            .folder_name = folder_name,
            .path = entry.path,
            .branch = branch,
            .state = "active",
            .order_index = try database.nextWorktreeOrder(row.id),
            .created_by = "external",
        });
    }
}

fn findWorktreeByPathAny(allocator: std.mem.Allocator, database: *db.Database, path: []const u8) !?db.WorktreeRow {
    if (try database.findWorktreeByPath(allocator, path)) |row| return row;
    const real_path = std.fs.realpathAlloc(allocator, path) catch return null;
    defer allocator.free(real_path);
    if (std.mem.eql(u8, real_path, path)) return null;
    return try database.findWorktreeByPath(allocator, real_path);
}

pub fn adoptedFolderNameAlloc(allocator: std.mem.Allocator, database: *db.Database, workspace_id: []const u8, path: []const u8) ![]u8 {
    const base = try worktree_name.workspaceSlugAlloc(allocator, std.fs.path.basename(path));
    defer allocator.free(base);
    const prefix = if (worktree_name.isValidFolderName(base)) base else "external-worktree";
    if (!try database.worktreeFolderExists(workspace_id, prefix)) return try allocator.dupe(u8, prefix);

    var index: usize = 1;
    while (index < 10_000) : (index += 1) {
        const candidate = try std.fmt.allocPrint(allocator, "{s}-{d}", .{ prefix, index });
        errdefer allocator.free(candidate);
        if (!try database.worktreeFolderExists(workspace_id, candidate)) return candidate;
        allocator.free(candidate);
    }
    return error.TooManyCollisions;
}

fn findGitWorktree(allocator: std.mem.Allocator, entries: []const git.WorktreeListEntry, path: []const u8) ?git.WorktreeListEntry {
    for (entries) |entry| {
        if (std.mem.eql(u8, entry.path, path)) return entry;
    }
    const real_path = std.fs.realpathAlloc(allocator, path) catch return null;
    defer allocator.free(real_path);
    for (entries) |entry| {
        if (std.mem.eql(u8, entry.path, real_path)) return entry;
    }
    return null;
}

fn samePath(allocator: std.mem.Allocator, lhs: []const u8, rhs: []const u8) bool {
    if (std.mem.eql(u8, lhs, rhs)) return true;
    const lhs_real = std.fs.realpathAlloc(allocator, lhs) catch return false;
    defer allocator.free(lhs_real);
    const rhs_real = std.fs.realpathAlloc(allocator, rhs) catch return false;
    defer allocator.free(rhs_real);
    return std.mem.eql(u8, lhs_real, rhs_real);
}

fn pathExists(path: []const u8) bool {
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
}

fn pruneGitWorktrees(allocator: std.mem.Allocator, repository_path: []const u8) void {
    const prune_args = [_][]const u8{ "worktree", "prune" };
    if (git.runGitAlloc(allocator, repository_path, &prune_args)) |out| {
        allocator.free(out);
    } else |err| {
        std.log.warn("git worktree prune failed for {s}: {t}", .{ repository_path, err });
    }
}

pub fn workspaceResponsesAlloc(self: anytype, rows: []const db.WorkspaceRow, include_status: bool) ![]WorkspaceResponse {
    const allocator = self.allocator;
    var responses = try allocator.alloc(WorkspaceResponse, rows.len);
    errdefer allocator.free(responses);
    var initialized: usize = 0;
    errdefer freeInitializedWorkspaceResponses(allocator, responses[0..initialized]);

    for (rows, 0..) |row, index| {
        const worktree_rows = try self.database.?.listWorktreesForWorkspace(allocator, row.id);
        defer {
            for (worktree_rows) |*worktree_row| worktree_row.deinit(allocator);
            allocator.free(worktree_rows);
        }

        const worktree_responses = try allocator.alloc(WorktreeResponse, worktree_rows.len);
        var initialized_worktrees: usize = 0;
        errdefer {
            freeInitializedWorktreeResponses(allocator, worktree_responses[0..initialized_worktrees]);
            allocator.free(worktree_responses);
        }
        for (worktree_rows, 0..) |worktree_row, worktree_index| {
            worktree_responses[worktree_index] = try worktreeResponseFromRowAlloc(allocator, worktree_row, if (include_status) worktreeStatusOrNull(allocator, worktree_row.path) else null);
            initialized_worktrees += 1;
        }

        responses[index] = .{
            .id = try allocator.dupe(u8, row.id),
            .name = try allocator.dupe(u8, row.name),
            .root_path = try allocator.dupe(u8, row.root_path),
            .git_common_dir = try dupeOptional(allocator, row.git_common_dir),
            .workspace_slug = try allocator.dupe(u8, row.workspace_slug),
            .default_branch = try dupeOptional(allocator, row.default_branch),
            .branch = if (include_status) branchOrNull(allocator, row.root_path) else null,
            .order_index = row.order_index,
            .last_active_tab_id = try dupeOptional(allocator, row.last_active_tab_id),
            .created_at = try allocator.dupe(u8, row.created_at),
            .updated_at = try allocator.dupe(u8, row.updated_at),
            .git_status = if (include_status) workspaceStatusOrNull(allocator, row.root_path) else null,
            .worktrees = worktree_responses,
        };
        initialized += 1;
    }
    return responses;
}

pub fn freeWorkspaceResponses(allocator: std.mem.Allocator, responses: []WorkspaceResponse) void {
    freeInitializedWorkspaceResponses(allocator, responses);
    allocator.free(responses);
}

fn freeInitializedWorkspaceResponses(allocator: std.mem.Allocator, responses: []WorkspaceResponse) void {
    for (responses) |workspace_response| {
        allocator.free(workspace_response.id);
        allocator.free(workspace_response.name);
        allocator.free(workspace_response.root_path);
        if (workspace_response.git_common_dir) |value| allocator.free(value);
        allocator.free(workspace_response.workspace_slug);
        if (workspace_response.default_branch) |value| allocator.free(value);
        if (workspace_response.branch) |branch| allocator.free(branch);
        if (workspace_response.last_active_tab_id) |value| allocator.free(value);
        allocator.free(workspace_response.created_at);
        allocator.free(workspace_response.updated_at);
        freeInitializedWorktreeResponses(allocator, workspace_response.worktrees);
        allocator.free(workspace_response.worktrees);
    }
}

fn freeInitializedWorktreeResponses(allocator: std.mem.Allocator, responses: []const WorktreeResponse) void {
    for (responses) |response| {
        allocator.free(response.id);
        allocator.free(response.workspace_id);
        if (response.title) |value| allocator.free(value);
        allocator.free(response.folder_name);
        allocator.free(response.path);
        allocator.free(response.branch);
        if (response.base_branch) |value| allocator.free(value);
        if (response.target_branch) |value| allocator.free(value);
        allocator.free(response.state);
        if (response.last_active_tab_id) |value| allocator.free(value);
        if (response.last_error) |value| allocator.free(value);
        allocator.free(response.created_by);
        allocator.free(response.created_at);
        allocator.free(response.updated_at);
    }
}

pub fn freeWorktreeResponses(allocator: std.mem.Allocator, responses: []const WorktreeResponse) void {
    freeInitializedWorktreeResponses(allocator, responses);
    allocator.free(responses);
}

pub fn freeWorktreeResponseFields(allocator: std.mem.Allocator, response: WorktreeResponse) void {
    freeInitializedWorktreeResponses(allocator, (&[_]WorktreeResponse{response})[0..]);
}

pub fn worktreeResponseFromRowAlloc(allocator: std.mem.Allocator, row: db.WorktreeRow, status: ?GitStatusResponse) !WorktreeResponse {
    return .{
        .id = try allocator.dupe(u8, row.id),
        .workspace_id = try allocator.dupe(u8, row.workspace_id),
        .title = try dupeOptional(allocator, row.title),
        .folder_name = try allocator.dupe(u8, row.folder_name),
        .path = try allocator.dupe(u8, row.path),
        .branch = try allocator.dupe(u8, row.branch),
        .base_branch = try dupeOptional(allocator, row.base_branch),
        .target_branch = try dupeOptional(allocator, row.target_branch),
        .state = try allocator.dupe(u8, row.state),
        .order_index = row.order_index,
        .last_active_tab_id = try dupeOptional(allocator, row.last_active_tab_id),
        .last_error = try dupeOptional(allocator, row.last_error),
        .created_by = try allocator.dupe(u8, row.created_by),
        .created_at = try allocator.dupe(u8, row.created_at),
        .updated_at = try allocator.dupe(u8, row.updated_at),
        .git_status = status,
    };
}

fn dupeOptional(allocator: std.mem.Allocator, value: ?[]const u8) !?[]u8 {
    return if (value) |text| try allocator.dupe(u8, text) else null;
}

fn branchOrNull(allocator: std.mem.Allocator, path: []const u8) ?[]u8 {
    return git.currentBranchAlloc(allocator, path) catch null;
}

fn workspaceStatusOrNull(allocator: std.mem.Allocator, path: []const u8) ?GitStatusResponse {
    const status = git.statusSummaryAlloc(allocator, path) catch return null;
    return .{ .changed = status.changed, .staged = status.staged };
}

fn worktreeStatusOrNull(allocator: std.mem.Allocator, path: []const u8) ?GitStatusResponse {
    return workspaceStatusOrNull(allocator, path);
}

fn jsonAlloc(allocator: std.mem.Allocator, payload: anytype) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    try out.writer.print("{f}\n", .{std.json.fmt(payload, .{})});
    return out.toOwnedSlice();
}

test "workspace response json includes nested worktrees" {
    const worktrees = [_]WorktreeResponse{.{
        .id = "wt1",
        .workspace_id = "ws1",
        .folder_name = "luminous-galileo-a13f",
        .path = "/tmp/wt",
        .branch = "luminous-galileo-a13f",
        .state = "active",
        .order_index = 0,
        .created_by = "tao",
        .created_at = "now",
        .updated_at = "now",
    }};
    const response = try jsonAlloc(std.testing.allocator, WorkspaceListPayload{ .workspaces = &[_]WorkspaceResponse{.{
        .id = "ws1",
        .name = "tao",
        .root_path = "/repo",
        .workspace_slug = "tao",
        .order_index = 0,
        .created_at = "now",
        .updated_at = "now",
        .worktrees = &worktrees,
    }} });
    defer std.testing.allocator.free(response);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"worktrees\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "luminous-galileo-a13f") != null);
}
