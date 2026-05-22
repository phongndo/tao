const std = @import("std");
const db = @import("db.zig");
const git = @import("git.zig");
const rpc = @import("rpc.zig");
const worktree_name = @import("worktree_name.zig");

const assert = std.debug.assert;
const port_pid_scan_limit = 256;
const git_stage_path_args = [_][]const u8{ "add", "--all", "--" };
const git_unstage_path_args = [_][]const u8{ "restore", "--staged", "--" };
const git_revert_path_args = [_][]const u8{ "restore", "--" };

pub const ErrorCode = enum {
    invalid_workspace,
    invalid_path,
    invalid_name,
    git_failed,
    state_conflict,
    unauthorized,

    pub fn text(self: ErrorCode) []const u8 {
        return switch (self) {
            .invalid_workspace => "invalid-workspace",
            .invalid_path => "invalid-path",
            .invalid_name => "invalid-name",
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

const WorkspaceBranchesPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    branches: []const []const u8,
};

const WorkspaceBranchPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    branch: ?[]const u8,
};

const GitWorktreeInfoResponse = struct {
    path: []const u8,
    branch: []const u8,
    hash: []const u8,
    is_bare: bool,
};

const WorkspaceGitWorktreesPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    worktrees: []const GitWorktreeInfoResponse,
};

const WorkspaceStatusPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    git_status: GitStatusResponse,
};

const WorkspaceFileStatusResponse = struct {
    path: []const u8,
    status: []const u8,
};

const WorkspaceFileTreeResponse = struct {
    paths: []const []const u8,
    git_status: []const WorkspaceFileStatusResponse,
};

const WorkspaceFileTreePayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    file_tree: WorkspaceFileTreeResponse,
};

const WorkspaceDiffPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    diff_patch: []const u8,
};

const WorkspacePortResponse = struct {
    port: u16,
    process_name: ?[]const u8 = null,
};

const WorkspacePortsPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    ports: []const WorkspacePortResponse,
};

const PullRequestResponse = struct {
    number: u32,
    title: []const u8,
    url: []const u8,
    state: []const u8,
    head_ref_name: ?[]const u8 = null,
};

const WorkspacePullRequestPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    pull_request: ?PullRequestResponse,
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

    const git_root: ?[]u8 = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.toplevelAlloc(self.allocator, selected_path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => null,
        else => return err,
    };
    defer if (git_root) |value| self.allocator.free(value);
    const root_path = git_root orelse selected_path;

    var existing = try database.findWorkspaceByRoot(self.allocator, root_path);
    defer if (existing) |*row| row.deinit(self.allocator);

    const git_common_dir: ?[]u8 = if (git_root != null) blk: {
        self.unlock();
        defer self.lock();
        break :blk git.commonDirAlloc(self.allocator, root_path) catch null;
    } else null;
    defer if (git_common_dir) |value| self.allocator.free(value);
    const default_branch: ?[]u8 = if (git_root != null) blk: {
        self.unlock();
        defer self.lock();
        break :blk git.defaultBranchAlloc(self.allocator, root_path) catch null;
    } else null;
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
        try database.reactivateWorkspace(.{
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

pub fn handleBranchLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");

    const branch = blk: {
        self.unlock();
        defer self.lock();
        break :blk git.currentBranchAlloc(self.allocator, input_path);
    } catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorJsonAlloc(allocator, request, ErrorCode.git_failed.text(), "failed to read git branch"),
        else => return err,
    };
    defer if (branch) |value| self.allocator.free(value);

    return jsonAlloc(allocator, WorkspaceBranchPayload{
        .id = request.requestId(),
        .branch = branch,
    });
}

pub fn handleBranchesLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");

    const branches = blk: {
        self.unlock();
        defer self.lock();
        break :blk git.branchesAlloc(self.allocator, input_path);
    } catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorJsonAlloc(allocator, request, ErrorCode.git_failed.text(), "failed to list branches"),
        else => return err,
    };
    defer git.freeBranches(self.allocator, branches);

    return jsonAlloc(allocator, WorkspaceBranchesPayload{
        .id = request.requestId(),
        .branches = branches,
    });
}

pub fn handleGitWorktreesLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");

    const entries = blk: {
        self.unlock();
        defer self.lock();
        break :blk git.worktreeListAlloc(self.allocator, input_path);
    } catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorJsonAlloc(allocator, request, ErrorCode.git_failed.text(), "failed to list git worktrees"),
        else => return err,
    };
    defer git.freeWorktreeList(self.allocator, entries);

    const worktrees = try allocator.alloc(GitWorktreeInfoResponse, entries.len);
    defer allocator.free(worktrees);
    for (entries, 0..) |entry, index| {
        worktrees[index] = .{
            .path = entry.path,
            .branch = gitWorktreeBranch(entry),
            .hash = entry.head orelse "",
            .is_bare = entry.bare,
        };
    }

    return jsonAlloc(allocator, WorkspaceGitWorktreesPayload{
        .id = request.requestId(),
        .worktrees = worktrees,
    });
}

pub fn handleStatusLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");

    const status = blk: {
        self.unlock();
        defer self.lock();
        break :blk git.statusSummaryAlloc(self.allocator, input_path);
    } catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorJsonAlloc(allocator, request, ErrorCode.git_failed.text(), "failed to read git status"),
        else => return err,
    };

    return jsonAlloc(allocator, WorkspaceStatusPayload{
        .id = request.requestId(),
        .git_status = gitStatusResponseFromSummary(status),
    });
}

const FileTreeGitOutputs = struct {
    paths: []u8,
    status: []u8,
};

pub fn handleFileTreeLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");

    const outputs = blk: {
        self.unlock();
        defer self.lock();

        const paths_args = [_][]const u8{ "ls-files", "-co", "--exclude-standard", "-z" };
        const paths = git.runGitAlloc(self.allocator, input_path, &paths_args) catch |err| switch (err) {
            error.GitFailed, error.GitNotFound => break :blk null,
            else => return err,
        };
        errdefer self.allocator.free(paths);

        const status_args = [_][]const u8{ "status", "--porcelain=v1", "-z" };
        const status = git.runGitAlloc(self.allocator, input_path, &status_args) catch |err| switch (err) {
            error.GitFailed, error.GitNotFound => try self.allocator.dupe(u8, ""),
            else => return err,
        };

        break :blk FileTreeGitOutputs{ .paths = paths, .status = status };
    };

    if (outputs) |value| {
        defer self.allocator.free(value.paths);
        defer self.allocator.free(value.status);

        const paths = try parseNulSeparatedPathsAlloc(allocator, value.paths);
        defer freePathList(allocator, paths);
        const statuses = try parseWorkspaceFileStatusAlloc(allocator, value.status);
        defer freeWorkspaceFileStatuses(allocator, statuses);

        return jsonAlloc(allocator, WorkspaceFileTreePayload{
            .id = request.requestId(),
            .file_tree = .{
                .paths = paths,
                .git_status = statuses,
            },
        });
    }

    return jsonAlloc(allocator, WorkspaceFileTreePayload{
        .id = request.requestId(),
        .file_tree = .{ .paths = &.{}, .git_status = &.{} },
    });
}

pub fn handleDiffLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");
    const scope = request.requestScope() orelse "all";

    const patch = blk: {
        self.unlock();
        defer self.lock();
        break :blk runDiffForScopeAlloc(self.allocator, input_path, scope, request.requestCompareBranch()) catch |err| switch (err) {
            error.InvalidName => return errorJsonAlloc(allocator, request, ErrorCode.invalid_name.text(), "invalid compare branch"),
            error.InvalidScope => return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "invalid diff scope"),
            error.GitFailed, error.GitNotFound => return errorJsonAlloc(allocator, request, ErrorCode.git_failed.text(), "failed to read git diff"),
            else => return err,
        };
    };
    defer self.allocator.free(patch);

    return jsonAlloc(allocator, WorkspaceDiffPayload{
        .id = request.requestId(),
        .diff_patch = patch,
    });
}

const GitPathAction = enum {
    stage,
    unstage,
    revert,
};

pub fn handleStagePathLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    return handleGitPathActionLocked(self, allocator, request, .stage);
}

pub fn handleUnstagePathLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    return handleGitPathActionLocked(self, allocator, request, .unstage);
}

pub fn handleRevertPathLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    return handleGitPathActionLocked(self, allocator, request, .revert);
}

fn handleGitPathActionLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson, action: GitPathAction) ![]u8 {
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");
    const paths = request.requestGitPaths() orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "paths are required");
    if (!validGitPathActionPaths(paths)) {
        return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "invalid path");
    }

    {
        self.unlock();
        defer self.lock();
        runGitPathAction(self.allocator, input_path, paths, action) catch |err| switch (err) {
            error.GitFailed, error.GitNotFound => return errorJsonAlloc(allocator, request, ErrorCode.git_failed.text(), "git path action failed"),
            else => return err,
        };
    }

    return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
}

pub fn handlePortsLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");

    const ports = blk: {
        self.unlock();
        defer self.lock();
        break :blk workspacePortsAlloc(self.allocator, input_path);
    } catch try self.allocator.alloc(WorkspacePortResponse, 0);
    defer freeWorkspacePorts(self.allocator, ports);

    return jsonAlloc(allocator, WorkspacePortsPayload{
        .id = request.requestId(),
        .ports = ports,
    });
}

pub fn handlePullRequestLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const input_path = request.requestRootPath() orelse request.cwd orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_path.text(), "root_path is required");

    var pull_request = blk: {
        self.unlock();
        defer self.lock();
        break :blk pullRequestInfoAlloc(self.allocator, input_path) catch null;
    };
    defer if (pull_request) |*value| freePullRequestInfo(self.allocator, value);

    return jsonAlloc(allocator, WorkspacePullRequestPayload{
        .id = request.requestId(),
        .pull_request = pull_request,
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
    var row = (try database.findWorkspaceById(self.allocator, workspace_id)) orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_workspace.text(), "workspace not found");
    row.deinit(self.allocator);
    try database.archiveWorkspace(workspace_id);
    try database.archiveWorktreesForWorkspace(workspace_id);
    return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
}

pub fn handleReorderLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorJsonAlloc(allocator, request, ErrorCode.state_conflict.text(), "database is unavailable");
    const workspace_id = request.requestWorkspaceId() orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_workspace.text(), "workspace_id is required");
    const order_index = request.requestOrderIndex() orelse return errorJsonAlloc(allocator, request, ErrorCode.state_conflict.text(), "order_index is required");
    var row = (try database.findWorkspaceById(self.allocator, workspace_id)) orelse return errorJsonAlloc(allocator, request, ErrorCode.invalid_workspace.text(), "workspace not found");
    row.deinit(self.allocator);
    try database.reorderWorkspace(workspace_id, order_index);
    return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
}

pub fn refreshWorkspaceGitMetadata(self: anytype, database: *db.Database, row: *const db.WorkspaceRow) !void {
    const common_dir: ?[]u8 = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.commonDirAlloc(self.allocator, row.root_path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => null,
        else => return err,
    };
    defer if (common_dir) |value| self.allocator.free(value);
    const default_branch: ?[]u8 = if (common_dir != null) blk: {
        self.unlock();
        defer self.lock();
        break :blk git.defaultBranchAlloc(self.allocator, row.root_path) catch null;
    } else null;
    defer if (default_branch) |value| self.allocator.free(value);
    const slug = try worktree_name.workspaceSlugAlloc(self.allocator, row.root_path);
    defer self.allocator.free(slug);
    var current = (try database.findWorkspaceById(self.allocator, row.id)) orelse return;
    defer current.deinit(self.allocator);
    if (current.archived_at != null) return;
    try database.updateWorkspace(.{
        .id = current.id,
        .name = current.name,
        .root_path = current.root_path,
        .git_common_dir = common_dir,
        .workspace_slug = slug,
        .default_branch = default_branch,
        .order_index = current.order_index,
        .last_active_tab_id = current.last_active_tab_id,
    });
}

fn reconcileWorkspaceWorktrees(self: anytype, database: *db.Database, row: *const db.WorkspaceRow) !void {
    const entries = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.worktreeListAlloc(self.allocator, row.root_path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return,
        else => return err,
    };
    defer {
        for (entries) |*entry| entry.deinit(self.allocator);
        self.allocator.free(entries);
    }

    {
        self.unlock();
        defer self.lock();
        pruneGitWorktrees(self.allocator, row.root_path);
    }

    var current = (try database.findWorkspaceById(self.allocator, row.id)) orelse return;
    defer current.deinit(self.allocator);
    if (current.archived_at != null) return;

    const known_rows = try database.listWorktreesForWorkspace(self.allocator, current.id);
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
        if (samePath(self.allocator, entry.path, current.root_path)) continue;

        if (try findWorktreeByPathAny(self.allocator, database, entry.path)) |existing_row| {
            var existing = existing_row;
            defer existing.deinit(self.allocator);
            var branch_owned: ?[]u8 = null;
            defer if (branch_owned) |value| self.allocator.free(value);
            const branch = entry.branch orelse blk: {
                branch_owned = try worktree_name.detachedBranchForFolderAlloc(self.allocator, existing.id);
                break :blk branch_owned.?;
            };
            if (std.mem.eql(u8, existing.workspace_id, current.id)) {
                try database.updateWorktreeGit(existing.id, branch, "active");
            }
            continue;
        }
        if (try archivedWorktreePathExistsAny(self.allocator, database, entry.path)) continue;

        const folder_name = try adoptedFolderNameAlloc(self.allocator, database, current.id, entry.path);
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
            .workspace_id = current.id,
            .title = title,
            .folder_name = folder_name,
            .path = entry.path,
            .branch = branch,
            .state = "active",
            .order_index = try database.nextWorktreeOrder(current.id),
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

fn archivedWorktreePathExistsAny(allocator: std.mem.Allocator, database: *db.Database, path: []const u8) !bool {
    if (try database.archivedWorktreePathExists(path)) return true;
    const real_path = std.fs.realpathAlloc(allocator, path) catch return false;
    defer allocator.free(real_path);
    if (std.mem.eql(u8, real_path, path)) return false;
    return try database.archivedWorktreePathExists(real_path);
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

fn gitWorktreeBranch(entry: git.WorktreeListEntry) []const u8 {
    if (entry.branch) |branch| return branch;
    if (entry.detached) return "detached";
    return "";
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

fn validGitPathActionPaths(paths: []const []const u8) bool {
    if (paths.len == 0) return false;
    for (paths) |path| {
        if (path.len == 0) return false;
        if (std.mem.startsWith(u8, path, "-")) return false;
        if (std.mem.indexOfScalar(u8, path, 0) != null) return false;
    }
    return true;
}

fn runGitPathAction(allocator: std.mem.Allocator, repository_path: []const u8, paths: []const []const u8, action: GitPathAction) !void {
    const prefix: []const []const u8 = switch (action) {
        .stage => &git_stage_path_args,
        .unstage => &git_unstage_path_args,
        .revert => &git_revert_path_args,
    };

    const args = try allocator.alloc([]const u8, prefix.len + paths.len);
    defer allocator.free(args);
    @memcpy(args[0..prefix.len], prefix);
    for (paths, 0..) |path, index| args[prefix.len + index] = path;

    const out = try git.runGitAlloc(allocator, repository_path, args);
    allocator.free(out);
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
            const status = if (include_status) worktreeStatusOrNull(self, allocator, worktree_row.path) else null;
            worktree_responses[worktree_index] = try worktreeResponseFromRowAlloc(allocator, worktree_row, status);
            initialized_worktrees += 1;
        }

        responses[index] = try workspaceResponseFromRowAlloc(self, row, worktree_responses, include_status);
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

fn workspaceResponseFromRowAlloc(self: anytype, row: db.WorkspaceRow, worktrees: []const WorktreeResponse, include_status: bool) !WorkspaceResponse {
    const allocator = self.allocator;
    var id: ?[]u8 = null;
    errdefer if (id) |value| allocator.free(value);
    id = try allocator.dupe(u8, row.id);

    var name: ?[]u8 = null;
    errdefer if (name) |value| allocator.free(value);
    name = try allocator.dupe(u8, row.name);

    var root_path: ?[]u8 = null;
    errdefer if (root_path) |value| allocator.free(value);
    root_path = try allocator.dupe(u8, row.root_path);

    var git_common_dir: ?[]u8 = null;
    errdefer if (git_common_dir) |value| allocator.free(value);
    git_common_dir = try dupeOptional(allocator, row.git_common_dir);

    var workspace_slug: ?[]u8 = null;
    errdefer if (workspace_slug) |value| allocator.free(value);
    workspace_slug = try allocator.dupe(u8, row.workspace_slug);

    var default_branch: ?[]u8 = null;
    errdefer if (default_branch) |value| allocator.free(value);
    default_branch = try dupeOptional(allocator, row.default_branch);

    var branch: ?[]u8 = null;
    errdefer if (branch) |value| allocator.free(value);
    branch = if (include_status) branchOrNull(self, allocator, row.root_path) else null;

    var last_active_tab_id: ?[]u8 = null;
    errdefer if (last_active_tab_id) |value| allocator.free(value);
    last_active_tab_id = try dupeOptional(allocator, row.last_active_tab_id);

    var created_at: ?[]u8 = null;
    errdefer if (created_at) |value| allocator.free(value);
    created_at = try allocator.dupe(u8, row.created_at);

    var updated_at: ?[]u8 = null;
    errdefer if (updated_at) |value| allocator.free(value);
    updated_at = try allocator.dupe(u8, row.updated_at);

    const response: WorkspaceResponse = .{
        .id = id.?,
        .name = name.?,
        .root_path = root_path.?,
        .git_common_dir = git_common_dir,
        .workspace_slug = workspace_slug.?,
        .default_branch = default_branch,
        .branch = branch,
        .order_index = row.order_index,
        .last_active_tab_id = last_active_tab_id,
        .created_at = created_at.?,
        .updated_at = updated_at.?,
        .git_status = if (include_status) workspaceStatusOrNull(self, allocator, row.root_path) else null,
        .worktrees = worktrees,
    };
    assertWorkspaceResponse(response);
    id = null;
    name = null;
    root_path = null;
    git_common_dir = null;
    workspace_slug = null;
    default_branch = null;
    branch = null;
    last_active_tab_id = null;
    created_at = null;
    updated_at = null;
    return response;
}

pub fn worktreeResponseFromRowAlloc(allocator: std.mem.Allocator, row: db.WorktreeRow, status: ?GitStatusResponse) !WorktreeResponse {
    var id: ?[]u8 = null;
    errdefer if (id) |value| allocator.free(value);
    id = try allocator.dupe(u8, row.id);

    var workspace_id: ?[]u8 = null;
    errdefer if (workspace_id) |value| allocator.free(value);
    workspace_id = try allocator.dupe(u8, row.workspace_id);

    var title: ?[]u8 = null;
    errdefer if (title) |value| allocator.free(value);
    title = try dupeOptional(allocator, row.title);

    var folder_name: ?[]u8 = null;
    errdefer if (folder_name) |value| allocator.free(value);
    folder_name = try allocator.dupe(u8, row.folder_name);

    var path: ?[]u8 = null;
    errdefer if (path) |value| allocator.free(value);
    path = try allocator.dupe(u8, row.path);

    var branch: ?[]u8 = null;
    errdefer if (branch) |value| allocator.free(value);
    branch = try allocator.dupe(u8, row.branch);

    var base_branch: ?[]u8 = null;
    errdefer if (base_branch) |value| allocator.free(value);
    base_branch = try dupeOptional(allocator, row.base_branch);

    var target_branch: ?[]u8 = null;
    errdefer if (target_branch) |value| allocator.free(value);
    target_branch = try dupeOptional(allocator, row.target_branch);

    var state: ?[]u8 = null;
    errdefer if (state) |value| allocator.free(value);
    state = try allocator.dupe(u8, row.state);

    var last_active_tab_id: ?[]u8 = null;
    errdefer if (last_active_tab_id) |value| allocator.free(value);
    last_active_tab_id = try dupeOptional(allocator, row.last_active_tab_id);

    var last_error: ?[]u8 = null;
    errdefer if (last_error) |value| allocator.free(value);
    last_error = try dupeOptional(allocator, row.last_error);

    var created_by: ?[]u8 = null;
    errdefer if (created_by) |value| allocator.free(value);
    created_by = try allocator.dupe(u8, row.created_by);

    var created_at: ?[]u8 = null;
    errdefer if (created_at) |value| allocator.free(value);
    created_at = try allocator.dupe(u8, row.created_at);

    var updated_at: ?[]u8 = null;
    errdefer if (updated_at) |value| allocator.free(value);
    updated_at = try allocator.dupe(u8, row.updated_at);

    const response: WorktreeResponse = .{
        .id = id.?,
        .workspace_id = workspace_id.?,
        .title = title,
        .folder_name = folder_name.?,
        .path = path.?,
        .branch = branch.?,
        .base_branch = base_branch,
        .target_branch = target_branch,
        .state = state.?,
        .order_index = row.order_index,
        .last_active_tab_id = last_active_tab_id,
        .last_error = last_error,
        .created_by = created_by.?,
        .created_at = created_at.?,
        .updated_at = updated_at.?,
        .git_status = status,
    };
    assertWorktreeResponse(response);
    id = null;
    workspace_id = null;
    title = null;
    folder_name = null;
    path = null;
    branch = null;
    base_branch = null;
    target_branch = null;
    state = null;
    last_active_tab_id = null;
    last_error = null;
    created_by = null;
    created_at = null;
    updated_at = null;
    return response;
}

fn assertWorkspaceResponse(response: WorkspaceResponse) void {
    assert(response.id.len > 0);
    assert(response.name.len > 0);
    assert(response.root_path.len > 0);
    assert(response.workspace_slug.len > 0);
    assert(response.created_at.len > 0);
    assert(response.updated_at.len > 0);
    for (response.worktrees) |worktree_response| {
        assertWorktreeResponse(worktree_response);
        assert(std.mem.eql(u8, worktree_response.workspace_id, response.id));
    }
}

fn assertWorktreeResponse(response: WorktreeResponse) void {
    assert(response.id.len > 0);
    assert(response.workspace_id.len > 0);
    assert(response.folder_name.len > 0);
    assert(response.path.len > 0);
    assert(response.branch.len > 0);
    assert(response.state.len > 0);
    assert(response.created_by.len > 0);
    assert(response.created_at.len > 0);
    assert(response.updated_at.len > 0);
}

fn dupeOptional(allocator: std.mem.Allocator, value: ?[]const u8) !?[]u8 {
    return if (value) |text| try allocator.dupe(u8, text) else null;
}

fn branchOrNull(self: anytype, allocator: std.mem.Allocator, path: []const u8) ?[]u8 {
    self.unlock();
    defer self.lock();
    return git.currentBranchAlloc(allocator, path) catch null;
}

fn workspaceStatusOrNull(self: anytype, allocator: std.mem.Allocator, path: []const u8) ?GitStatusResponse {
    self.unlock();
    defer self.lock();
    const status = git.statusSummaryAlloc(allocator, path) catch return null;
    return gitStatusResponseFromSummary(status);
}

fn worktreeStatusOrNull(self: anytype, allocator: std.mem.Allocator, path: []const u8) ?GitStatusResponse {
    return workspaceStatusOrNull(self, allocator, path);
}

fn gitStatusResponseFromSummary(status: git.StatusSummary) GitStatusResponse {
    return .{ .changed = status.changed +| status.untracked, .staged = status.staged };
}

fn pathLessThan(_: void, lhs: []const u8, rhs: []const u8) bool {
    return std.mem.order(u8, lhs, rhs) == .lt;
}

fn parseNulSeparatedPathsAlloc(allocator: std.mem.Allocator, output: []const u8) ![]const []const u8 {
    var paths: std.ArrayList([]const u8) = .empty;
    errdefer freePathList(allocator, paths.items);

    var fields = std.mem.splitScalar(u8, output, 0);
    while (fields.next()) |field| {
        const path = std.mem.trim(u8, field, " \n\r\t");
        if (path.len == 0) continue;
        const owned_path = try allocator.dupe(u8, path);
        errdefer allocator.free(owned_path);
        try paths.append(allocator, owned_path);
    }

    std.mem.sort([]const u8, paths.items, {}, pathLessThan);
    return paths.toOwnedSlice(allocator);
}

fn workspaceFileStatusKind(index_status: u8, working_tree_status: u8) []const u8 {
    if (index_status == '?' and working_tree_status == '?') return "untracked";
    if (index_status == '!' and working_tree_status == '!') return "ignored";
    if (index_status == 'D' or working_tree_status == 'D') return "deleted";
    if (index_status == 'R' or working_tree_status == 'R') return "renamed";
    if (index_status == 'A') return "added";
    return "modified";
}

fn parseWorkspaceFileStatusAlloc(allocator: std.mem.Allocator, output: []const u8) ![]const WorkspaceFileStatusResponse {
    var entries: std.ArrayList(WorkspaceFileStatusResponse) = .empty;
    errdefer freeWorkspaceFileStatuses(allocator, entries.items);

    var skip_next = false;
    var fields = std.mem.splitScalar(u8, output, 0);
    while (fields.next()) |field| {
        if (skip_next) {
            skip_next = false;
            continue;
        }
        if (field.len < 4) continue;

        const index_status = field[0];
        const working_tree_status = field[1];
        const path = field[3..];
        if (path.len == 0) continue;

        const owned_path = try allocator.dupe(u8, path);
        errdefer allocator.free(owned_path);
        try entries.append(allocator, .{
            .path = owned_path,
            .status = workspaceFileStatusKind(index_status, working_tree_status),
        });
        if (index_status == 'R' or index_status == 'C') skip_next = true;
    }

    return entries.toOwnedSlice(allocator);
}

fn freePathList(allocator: std.mem.Allocator, paths: []const []const u8) void {
    for (paths) |path| allocator.free(path);
    allocator.free(paths);
}

fn freeWorkspaceFileStatuses(allocator: std.mem.Allocator, entries: []const WorkspaceFileStatusResponse) void {
    for (entries) |entry| allocator.free(entry.path);
    allocator.free(entries);
}

fn validateDiffCompareBranch(branch: []const u8) ![]const u8 {
    const trimmed = std.mem.trim(u8, branch, " \n\r\t");
    if (trimmed.len == 0 or trimmed[0] == '-') return error.InvalidName;
    for (trimmed) |byte| {
        const valid = std.ascii.isAlphanumeric(byte) or byte == '.' or byte == '_' or byte == '/' or byte == '-';
        if (!valid) return error.InvalidName;
    }
    return trimmed;
}

fn defaultDiffCompareBranch(allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    const main_args = [_][]const u8{ "rev-parse", "--verify", "--quiet", "main^{commit}" };
    if (try git.runGitCheck(allocator, path, &main_args)) return "main";
    const master_args = [_][]const u8{ "rev-parse", "--verify", "--quiet", "master^{commit}" };
    if (try git.runGitCheck(allocator, path, &master_args)) return "master";
    return "main";
}

fn runDiffForScopeAlloc(
    allocator: std.mem.Allocator,
    path: []const u8,
    scope: []const u8,
    compare_branch: ?[]const u8,
) ![]u8 {
    const base_args = [_][]const u8{ "diff", "--no-ext-diff", "--no-color", "--patch" };

    if (std.mem.eql(u8, scope, "all")) {
        const branch = if (compare_branch) |value| try validateDiffCompareBranch(value) else try defaultDiffCompareBranch(allocator, path);
        const args = [_][]const u8{ base_args[0], base_args[1], base_args[2], base_args[3], branch, "--" };
        return git.runGitAlloc(allocator, path, &args);
    }
    if (std.mem.eql(u8, scope, "uncommitted")) {
        const args = [_][]const u8{ base_args[0], base_args[1], base_args[2], base_args[3], "HEAD", "--" };
        return git.runGitAlloc(allocator, path, &args);
    }
    if (std.mem.eql(u8, scope, "unstaged")) {
        const args = [_][]const u8{ base_args[0], base_args[1], base_args[2], base_args[3], "--" };
        return git.runGitAlloc(allocator, path, &args);
    }
    if (std.mem.eql(u8, scope, "staged")) {
        const args = [_][]const u8{ base_args[0], base_args[1], base_args[2], base_args[3], "--cached", "--" };
        return git.runGitAlloc(allocator, path, &args);
    }

    return error.InvalidScope;
}

const PortProcessInfo = struct {
    pid: u32,
    port: u16,
    process_name: ?[]u8 = null,

    fn deinit(self: *PortProcessInfo, allocator: std.mem.Allocator) void {
        if (self.process_name) |value| allocator.free(value);
        self.* = undefined;
    }
};

fn runLsofAlloc(allocator: std.mem.Allocator, args: []const []const u8, max_output_bytes: usize) ![]u8 {
    var argv = try allocator.alloc([]const u8, args.len + 1);
    defer allocator.free(argv);
    argv[0] = "lsof";
    for (args, 0..) |arg, index| argv[index + 1] = arg;

    const result = std.process.Child.run(.{
        .allocator = allocator,
        .argv = argv,
        .max_output_bytes = max_output_bytes,
    }) catch |err| switch (err) {
        error.FileNotFound => return error.FileNotFound,
        else => return err,
    };
    defer allocator.free(result.stderr);
    defer allocator.free(result.stdout);

    switch (result.term) {
        .Exited => |code| if (code == 0) return try allocator.dupe(u8, result.stdout),
        else => {},
    }

    return error.LsofFailed;
}

fn parsePortFromName(value: []const u8) ?u16 {
    var index = value.len;
    while (index > 0) {
        index -= 1;
        if (value[index] != ':') continue;

        var end = index + 1;
        while (end < value.len and std.ascii.isDigit(value[end])) end += 1;
        if (end == index + 1) continue;

        const port = std.fmt.parseUnsigned(u16, value[index + 1 .. end], 10) catch continue;
        if (port == 0) continue;
        return port;
    }
    return null;
}

fn parseListeningPortsAlloc(allocator: std.mem.Allocator, output: []const u8) ![]PortProcessInfo {
    var ports: std.ArrayList(PortProcessInfo) = .empty;
    errdefer freeListeningPorts(allocator, ports.items);

    var pid: ?u32 = null;
    var process_name: ?[]const u8 = null;
    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        if (line.len < 2) continue;
        const field = line[0];
        const value = line[1..];
        switch (field) {
            'p' => {
                pid = std.fmt.parseUnsigned(u32, value, 10) catch null;
                process_name = null;
                continue;
            },
            'c' => {
                process_name = if (value.len == 0) null else value;
                continue;
            },
            'n' => {},
            else => continue,
        }

        const process_id = pid orelse continue;
        const port = parsePortFromName(value) orelse continue;
        var duplicate = false;
        for (ports.items) |entry| {
            if (entry.pid == process_id and entry.port == port) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) continue;

        const owned_name = if (process_name) |name| try allocator.dupe(u8, name) else null;
        errdefer if (owned_name) |name| allocator.free(name);
        try ports.append(allocator, .{
            .pid = process_id,
            .port = port,
            .process_name = owned_name,
        });
    }

    std.mem.sort(PortProcessInfo, ports.items, {}, portProcessLessThan);
    return ports.toOwnedSlice(allocator);
}

fn freeListeningPorts(allocator: std.mem.Allocator, ports: []PortProcessInfo) void {
    for (ports) |*entry| entry.deinit(allocator);
    allocator.free(ports);
}

fn processCwdAlloc(allocator: std.mem.Allocator, pid: u32) !?[]u8 {
    const pid_text = try std.fmt.allocPrint(allocator, "{d}", .{pid});
    defer allocator.free(pid_text);
    const args = [_][]const u8{ "-a", "-p", pid_text, "-d", "cwd", "-Fn" };
    const output = runLsofAlloc(allocator, &args, 64 * 1024) catch return null;
    defer allocator.free(output);

    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        if (line.len > 1 and line[0] == 'n') return try allocator.dupe(u8, line[1..]);
    }
    return null;
}

fn isPathInside(parent_path: []const u8, candidate_path: []const u8) bool {
    if (std.mem.eql(u8, parent_path, candidate_path)) return true;
    if (!std.mem.startsWith(u8, candidate_path, parent_path)) return false;
    return parent_path.len > 0 and parent_path[parent_path.len - 1] == std.fs.path.sep or
        (candidate_path.len > parent_path.len and candidate_path[parent_path.len] == std.fs.path.sep);
}

fn portProcessLessThan(_: void, lhs: PortProcessInfo, rhs: PortProcessInfo) bool {
    return lhs.port < rhs.port;
}

fn workspacePortLessThan(_: void, lhs: WorkspacePortResponse, rhs: WorkspacePortResponse) bool {
    return lhs.port < rhs.port;
}

fn workspacePortsAlloc(allocator: std.mem.Allocator, workspace_path: []const u8) ![]WorkspacePortResponse {
    const workspace_real = std.fs.realpathAlloc(allocator, workspace_path) catch return try allocator.alloc(WorkspacePortResponse, 0);
    defer allocator.free(workspace_real);

    const args = [_][]const u8{ "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpnc" };
    const output = runLsofAlloc(allocator, &args, 1024 * 1024) catch return try allocator.alloc(WorkspacePortResponse, 0);
    defer allocator.free(output);

    const listening_ports = try parseListeningPortsAlloc(allocator, output);
    defer freeListeningPorts(allocator, listening_ports);

    var ports: std.ArrayList(WorkspacePortResponse) = .empty;
    errdefer freeWorkspacePorts(allocator, ports.items);

    var scanned_pids: std.ArrayList(u32) = .empty;
    defer scanned_pids.deinit(allocator);

    for (listening_ports) |entry| {
        var already_scanned = false;
        for (scanned_pids.items) |pid| {
            if (pid == entry.pid) {
                already_scanned = true;
                break;
            }
        }
        if (already_scanned) continue;
        if (scanned_pids.items.len >= port_pid_scan_limit) break;
        try scanned_pids.append(allocator, entry.pid);

        const cwd = (try processCwdAlloc(allocator, entry.pid)) orelse continue;
        defer allocator.free(cwd);
        const cwd_real = std.fs.realpathAlloc(allocator, cwd) catch continue;
        defer allocator.free(cwd_real);
        if (!isPathInside(workspace_real, cwd_real)) continue;

        for (listening_ports) |port_entry| {
            if (port_entry.pid != entry.pid) continue;
            const owned_name = if (port_entry.process_name) |name| try allocator.dupe(u8, name) else null;
            errdefer if (owned_name) |name| allocator.free(name);
            try ports.append(allocator, .{
                .port = port_entry.port,
                .process_name = owned_name,
            });
        }
    }

    std.mem.sort(WorkspacePortResponse, ports.items, {}, workspacePortLessThan);
    return ports.toOwnedSlice(allocator);
}

fn freeWorkspacePorts(allocator: std.mem.Allocator, ports: []const WorkspacePortResponse) void {
    for (ports) |entry| {
        if (entry.process_name) |name| allocator.free(name);
    }
    allocator.free(ports);
}

const GhPullRequestJson = struct {
    number: u32,
    title: []const u8,
    url: []const u8,
    state: []const u8,
    headRefName: ?[]const u8 = null,
};

fn runGhAlloc(allocator: std.mem.Allocator, cwd: []const u8, args: []const []const u8) ![]u8 {
    var argv = try allocator.alloc([]const u8, args.len + 1);
    defer allocator.free(argv);
    argv[0] = "gh";
    for (args, 0..) |arg, index| argv[index + 1] = arg;

    const result = std.process.Child.run(.{
        .allocator = allocator,
        .argv = argv,
        .cwd = cwd,
        .max_output_bytes = 1024 * 1024,
    }) catch |err| switch (err) {
        error.FileNotFound => return error.FileNotFound,
        else => return err,
    };
    defer allocator.free(result.stderr);
    defer allocator.free(result.stdout);

    switch (result.term) {
        .Exited => |code| if (code == 0) return try allocator.dupe(u8, std.mem.trim(u8, result.stdout, " \n\r\t")),
        else => {},
    }

    return error.GhFailed;
}

fn pullRequestInfoFromJsonAlloc(allocator: std.mem.Allocator, output: []const u8) !PullRequestResponse {
    if (output.len == 0) return error.NoPullRequest;
    var parsed = try std.json.parseFromSlice(GhPullRequestJson, allocator, output, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    const title = try allocator.dupe(u8, parsed.value.title);
    errdefer allocator.free(title);
    const url = try allocator.dupe(u8, parsed.value.url);
    errdefer allocator.free(url);
    const state = try allocator.dupe(u8, parsed.value.state);
    errdefer allocator.free(state);
    const head_ref_name = if (parsed.value.headRefName) |value| try allocator.dupe(u8, value) else null;
    errdefer if (head_ref_name) |value| allocator.free(value);

    return .{
        .number = parsed.value.number,
        .title = title,
        .url = url,
        .state = state,
        .head_ref_name = head_ref_name,
    };
}

fn pullRequestInfoAlloc(allocator: std.mem.Allocator, workspace_path: []const u8) !?PullRequestResponse {
    const args = [_][]const u8{ "pr", "view", "--json", "number,title,url,state,headRefName" };
    const output = runGhAlloc(allocator, workspace_path, &args) catch return null;
    defer allocator.free(output);
    return pullRequestInfoFromJsonAlloc(allocator, output) catch null;
}

fn freePullRequestInfo(allocator: std.mem.Allocator, pull_request: *PullRequestResponse) void {
    allocator.free(pull_request.title);
    allocator.free(pull_request.url);
    allocator.free(pull_request.state);
    if (pull_request.head_ref_name) |value| allocator.free(value);
    pull_request.* = undefined;
}

fn jsonAlloc(allocator: std.mem.Allocator, payload: anytype) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    try out.writer.print("{f}\n", .{std.json.fmt(payload, .{})});
    return out.toOwnedSlice();
}

fn readProtocolFixtureAlloc(allocator: std.mem.Allocator, name: []const u8) ![]u8 {
    const path = try std.fs.path.join(allocator, &.{ "../../packages/shared/fixtures/taod-protocol", name });
    defer allocator.free(path);
    return std.fs.cwd().readFileAlloc(allocator, path, 8192);
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

test "workspace list and record responses match shared golden fixtures" {
    const allocator = std.testing.allocator;
    const worktrees = [_]WorktreeResponse{.{
        .id = "worktree-fixture",
        .workspace_id = "workspace-fixture",
        .title = "Feature Worktree",
        .folder_name = "feature-worktree",
        .path = "/tmp/tao-workspace/feature-worktree",
        .branch = "feature/demo",
        .base_branch = "main",
        .target_branch = "feature/demo",
        .state = "active",
        .order_index = 2,
        .last_active_tab_id = "tab-2",
        .created_by = "tao",
        .created_at = "2026-05-22T00:00:02Z",
        .updated_at = "2026-05-22T00:00:03Z",
        .git_status = .{ .changed = 3, .staged = 1 },
    }};
    const workspace_response = WorkspaceResponse{
        .id = "workspace-fixture",
        .name = "Tao",
        .root_path = "/tmp/tao-workspace",
        .git_common_dir = ".git",
        .workspace_slug = "tao-workspace",
        .default_branch = "main",
        .branch = "feature",
        .order_index = 1,
        .last_active_tab_id = "tab-1",
        .created_at = "2026-05-22T00:00:00Z",
        .updated_at = "2026-05-22T00:00:01Z",
        .git_status = .{ .changed = 1, .staged = 0 },
        .worktrees = &worktrees,
    };

    const list_json = try jsonAlloc(allocator, WorkspaceListPayload{
        .id = "workspace-list-fixture",
        .workspaces = &[_]WorkspaceResponse{workspace_response},
    });
    defer allocator.free(list_json);
    const list_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-list-response.ndjson");
    defer allocator.free(list_golden);
    try std.testing.expectEqualStrings(list_golden, list_json);

    const record_json = try jsonAlloc(allocator, WorkspacePayload{
        .id = "workspace-record-fixture",
        .workspace = workspace_response,
    });
    defer allocator.free(record_json);
    const record_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-record-response.ndjson");
    defer allocator.free(record_golden);
    try std.testing.expectEqualStrings(record_golden, record_json);
}

test "workspace metadata response json matches shared golden fixtures" {
    const allocator = std.testing.allocator;

    const branches_json = try jsonAlloc(allocator, WorkspaceBranchesPayload{
        .id = "workspace-branches-fixture",
        .branches = &[_][]const u8{ "main", "origin/main" },
    });
    defer allocator.free(branches_json);
    const branches_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-branches-response.ndjson");
    defer allocator.free(branches_golden);
    try std.testing.expectEqualStrings(branches_golden, branches_json);

    const branch_json = try jsonAlloc(allocator, WorkspaceBranchPayload{
        .id = "workspace-branch-fixture",
        .branch = "main",
    });
    defer allocator.free(branch_json);
    const branch_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-branch-response.ndjson");
    defer allocator.free(branch_golden);
    try std.testing.expectEqualStrings(branch_golden, branch_json);

    const git_worktrees_json = try jsonAlloc(allocator, WorkspaceGitWorktreesPayload{
        .id = "workspace-git-worktrees-fixture",
        .worktrees = &[_]GitWorktreeInfoResponse{.{
            .path = "/tmp/tao-workspace",
            .branch = "main",
            .hash = "abc123",
            .is_bare = false,
        }},
    });
    defer allocator.free(git_worktrees_json);
    const git_worktrees_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-git-worktrees-response.ndjson");
    defer allocator.free(git_worktrees_golden);
    try std.testing.expectEqualStrings(git_worktrees_golden, git_worktrees_json);

    const status_json = try jsonAlloc(allocator, WorkspaceStatusPayload{
        .id = "workspace-status-fixture",
        .git_status = .{ .changed = 2, .staged = 1 },
    });
    defer allocator.free(status_json);
    const status_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-status-response.ndjson");
    defer allocator.free(status_golden);
    try std.testing.expectEqualStrings(status_golden, status_json);

    const file_tree_json = try jsonAlloc(allocator, WorkspaceFileTreePayload{
        .id = "workspace-file-tree-fixture",
        .file_tree = .{
            .paths = &[_][]const u8{ "README.md", "src/app.ts" },
            .git_status = &[_]WorkspaceFileStatusResponse{.{
                .path = "src/app.ts",
                .status = "modified",
            }},
        },
    });
    defer allocator.free(file_tree_json);
    const file_tree_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-file-tree-response.ndjson");
    defer allocator.free(file_tree_golden);
    try std.testing.expectEqualStrings(file_tree_golden, file_tree_json);

    const diff_json = try jsonAlloc(allocator, WorkspaceDiffPayload{
        .id = "workspace-diff-fixture",
        .diff_patch = "diff --git a/src/app.ts b/src/app.ts\n+console.log(\"tao\")\n",
    });
    defer allocator.free(diff_json);
    const diff_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-diff-response.ndjson");
    defer allocator.free(diff_golden);
    try std.testing.expectEqualStrings(diff_golden, diff_json);

    const ports_json = try jsonAlloc(allocator, WorkspacePortsPayload{
        .id = "workspace-ports-fixture",
        .ports = &[_]WorkspacePortResponse{.{ .port = 3000, .process_name = "node" }},
    });
    defer allocator.free(ports_json);
    const ports_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-ports-response.ndjson");
    defer allocator.free(ports_golden);
    try std.testing.expectEqualStrings(ports_golden, ports_json);

    const pull_request_json = try jsonAlloc(allocator, WorkspacePullRequestPayload{
        .id = "workspace-pull-request-fixture",
        .pull_request = .{
            .number = 32,
            .title = "Review Tao",
            .url = "https://example.invalid/pr/32",
            .state = "OPEN",
            .head_ref_name = "best-operation",
        },
    });
    defer allocator.free(pull_request_json);
    const pull_request_golden = try readProtocolFixtureAlloc(allocator, "control-workspace-pull-request-response.ndjson");
    defer allocator.free(pull_request_golden);
    try std.testing.expectEqualStrings(pull_request_golden, pull_request_json);
}

test "workspace git path action responses match shared golden fixtures" {
    const allocator = std.testing.allocator;
    const cases = [_]struct {
        fixture: []const u8,
        id: []const u8,
    }{
        .{ .fixture = "control-workspace-stage-path-response.ndjson", .id = "workspace-stage-path-fixture" },
        .{ .fixture = "control-workspace-unstage-path-response.ndjson", .id = "workspace-unstage-path-fixture" },
        .{ .fixture = "control-workspace-revert-path-response.ndjson", .id = "workspace-revert-path-fixture" },
    };

    for (cases) |case| {
        const json = try rpc.responseJsonAlloc(allocator, .{ .id = case.id, .ok = true });
        defer allocator.free(json);
        const golden = try readProtocolFixtureAlloc(allocator, case.fixture);
        defer allocator.free(golden);
        try std.testing.expectEqualStrings(golden, json);
    }
}

test "workspace status response counts untracked files as changed" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const tmp_root_rel = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer allocator.free(tmp_root_rel);
    const tmp_root = try std.fs.cwd().realpathAlloc(allocator, tmp_root_rel);
    defer allocator.free(tmp_root);

    const repo_path = try std.fs.path.join(allocator, &.{ tmp_root, "repo" });
    defer allocator.free(repo_path);
    try std.fs.cwd().makePath(repo_path);

    const init_args = [_][]const u8{"init"};
    const out = try git.runGitAlloc(allocator, repo_path, &init_args);
    allocator.free(out);

    const file_path = try std.fs.path.join(allocator, &.{ repo_path, "untracked.txt" });
    defer allocator.free(file_path);
    try std.fs.cwd().writeFile(.{ .sub_path = file_path, .data = "dirty" });

    var subject = struct {
        allocator: std.mem.Allocator,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{ .allocator = allocator };

    const response = try handleStatusLocked(&subject, allocator, .{
        .id = "status-1",
        .type = "workspace.status",
        .root_path = repo_path,
    });
    defer allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"git_status\":{\"changed\":1,\"staged\":0}") != null);
}

test "workspace branch response is served by daemon git path" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const tmp_root_rel = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer allocator.free(tmp_root_rel);
    const tmp_root = try std.fs.cwd().realpathAlloc(allocator, tmp_root_rel);
    defer allocator.free(tmp_root);

    const repo_path = try std.fs.path.join(allocator, &.{ tmp_root, "repo" });
    defer allocator.free(repo_path);
    try std.fs.cwd().makePath(repo_path);

    const init_args = [_][]const u8{"init"};
    const out = try git.runGitAlloc(allocator, repo_path, &init_args);
    allocator.free(out);

    const expected_branch = try git.currentBranchAlloc(allocator, repo_path);
    defer if (expected_branch) |branch| allocator.free(branch);

    var subject = struct {
        allocator: std.mem.Allocator,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{ .allocator = allocator };

    const response = try handleBranchLocked(&subject, allocator, .{
        .id = "branch-1",
        .type = "workspace.branch",
        .root_path = repo_path,
    });
    defer allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    if (expected_branch) |branch| {
        const expected_json = try std.fmt.allocPrint(allocator, "\"branch\":\"{s}\"", .{branch});
        defer allocator.free(expected_json);
        try std.testing.expect(std.mem.indexOf(u8, response, expected_json) != null);
    } else {
        try std.testing.expect(std.mem.indexOf(u8, response, "\"branch\":null") != null);
    }
}

test "workspace git worktrees response is served by daemon git path" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const tmp_root_rel = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer allocator.free(tmp_root_rel);
    const tmp_root = try std.fs.cwd().realpathAlloc(allocator, tmp_root_rel);
    defer allocator.free(tmp_root);

    const repo_path = try std.fs.path.join(allocator, &.{ tmp_root, "repo" });
    defer allocator.free(repo_path);
    try std.fs.cwd().makePath(repo_path);

    const worktree_path = try std.fs.path.join(allocator, &.{ tmp_root, "feature-worktree" });
    defer allocator.free(worktree_path);

    const init_args = [_][]const u8{"init"};
    var out = try git.runGitAlloc(allocator, repo_path, &init_args);
    allocator.free(out);

    const tracked_path = try std.fs.path.join(allocator, &.{ repo_path, "tracked.txt" });
    defer allocator.free(tracked_path);
    try std.fs.cwd().writeFile(.{ .sub_path = tracked_path, .data = "clean\n" });
    const add_args = [_][]const u8{ "add", "tracked.txt" };
    out = try git.runGitAlloc(allocator, repo_path, &add_args);
    allocator.free(out);
    const commit_args = [_][]const u8{ "-c", "user.name=Tao Test", "-c", "user.email=tao-test@example.invalid", "commit", "-m", "initial" };
    out = try git.runGitAlloc(allocator, repo_path, &commit_args);
    allocator.free(out);

    const worktree_args = [_][]const u8{ "worktree", "add", "-b", "feature-daemon-test", worktree_path, "HEAD" };
    out = try git.runGitAlloc(allocator, repo_path, &worktree_args);
    allocator.free(out);

    var subject = struct {
        allocator: std.mem.Allocator,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{ .allocator = allocator };

    const response = try handleGitWorktreesLocked(&subject, allocator, .{
        .id = "git-worktrees-1",
        .type = "workspace.gitWorktrees",
        .root_path = repo_path,
    });
    defer allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, repo_path) != null);
    try std.testing.expect(std.mem.indexOf(u8, response, worktree_path) != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"branch\":\"feature-daemon-test\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"is_bare\":false") != null);
}

test "workspace file tree response includes paths and git status" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const tmp_root_rel = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer allocator.free(tmp_root_rel);
    const tmp_root = try std.fs.cwd().realpathAlloc(allocator, tmp_root_rel);
    defer allocator.free(tmp_root);

    const repo_path = try std.fs.path.join(allocator, &.{ tmp_root, "repo" });
    defer allocator.free(repo_path);
    try std.fs.cwd().makePath(repo_path);

    const init_args = [_][]const u8{"init"};
    var out = try git.runGitAlloc(allocator, repo_path, &init_args);
    allocator.free(out);

    const tracked_path = try std.fs.path.join(allocator, &.{ repo_path, "tracked.txt" });
    defer allocator.free(tracked_path);
    try std.fs.cwd().writeFile(.{ .sub_path = tracked_path, .data = "clean\n" });
    const add_args = [_][]const u8{ "add", "tracked.txt" };
    out = try git.runGitAlloc(allocator, repo_path, &add_args);
    allocator.free(out);
    const commit_args = [_][]const u8{ "-c", "user.name=Tao Test", "-c", "user.email=tao-test@example.invalid", "commit", "-m", "initial" };
    out = try git.runGitAlloc(allocator, repo_path, &commit_args);
    allocator.free(out);

    try std.fs.cwd().writeFile(.{ .sub_path = tracked_path, .data = "dirty\n" });
    const untracked_path = try std.fs.path.join(allocator, &.{ repo_path, "untracked.txt" });
    defer allocator.free(untracked_path);
    try std.fs.cwd().writeFile(.{ .sub_path = untracked_path, .data = "new\n" });

    var subject = struct {
        allocator: std.mem.Allocator,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{ .allocator = allocator };

    const response = try handleFileTreeLocked(&subject, allocator, .{
        .id = "file-tree-1",
        .type = "workspace.fileTree",
        .root_path = repo_path,
    });
    defer allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"paths\":[\"tracked.txt\",\"untracked.txt\"]") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "{\"path\":\"tracked.txt\",\"status\":\"modified\"}") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "{\"path\":\"untracked.txt\",\"status\":\"untracked\"}") != null);
}

test "workspace diff response returns staged patch" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const tmp_root_rel = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer allocator.free(tmp_root_rel);
    const tmp_root = try std.fs.cwd().realpathAlloc(allocator, tmp_root_rel);
    defer allocator.free(tmp_root);

    const repo_path = try std.fs.path.join(allocator, &.{ tmp_root, "repo" });
    defer allocator.free(repo_path);
    try std.fs.cwd().makePath(repo_path);

    const init_args = [_][]const u8{"init"};
    var out = try git.runGitAlloc(allocator, repo_path, &init_args);
    allocator.free(out);

    const tracked_path = try std.fs.path.join(allocator, &.{ repo_path, "tracked.txt" });
    defer allocator.free(tracked_path);
    try std.fs.cwd().writeFile(.{ .sub_path = tracked_path, .data = "clean\n" });
    const add_args = [_][]const u8{ "add", "tracked.txt" };
    out = try git.runGitAlloc(allocator, repo_path, &add_args);
    allocator.free(out);
    const commit_args = [_][]const u8{ "-c", "user.name=Tao Test", "-c", "user.email=tao-test@example.invalid", "commit", "-m", "initial" };
    out = try git.runGitAlloc(allocator, repo_path, &commit_args);
    allocator.free(out);

    try std.fs.cwd().writeFile(.{ .sub_path = tracked_path, .data = "clean\ndirty\n" });
    out = try git.runGitAlloc(allocator, repo_path, &add_args);
    allocator.free(out);

    var subject = struct {
        allocator: std.mem.Allocator,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{ .allocator = allocator };

    const response = try handleDiffLocked(&subject, allocator, .{
        .id = "diff-1",
        .type = "workspace.diff",
        .root_path = repo_path,
        .scope = "staged",
    });
    defer allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"diff_patch\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "diff --git") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "+dirty") != null);
}

test "workspace git path actions are served by daemon git path" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const tmp_root_rel = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer allocator.free(tmp_root_rel);
    const tmp_root = try std.fs.cwd().realpathAlloc(allocator, tmp_root_rel);
    defer allocator.free(tmp_root);

    const repo_path = try std.fs.path.join(allocator, &.{ tmp_root, "repo" });
    defer allocator.free(repo_path);
    try std.fs.cwd().makePath(repo_path);

    const init_args = [_][]const u8{"init"};
    var out = try git.runGitAlloc(allocator, repo_path, &init_args);
    allocator.free(out);

    const tracked_path = try std.fs.path.join(allocator, &.{ repo_path, "tracked.txt" });
    defer allocator.free(tracked_path);
    try std.fs.cwd().writeFile(.{ .sub_path = tracked_path, .data = "clean\n" });
    const add_args = [_][]const u8{ "add", "tracked.txt" };
    out = try git.runGitAlloc(allocator, repo_path, &add_args);
    allocator.free(out);
    const commit_args = [_][]const u8{ "-c", "user.name=Tao Test", "-c", "user.email=tao-test@example.invalid", "commit", "-m", "initial" };
    out = try git.runGitAlloc(allocator, repo_path, &commit_args);
    allocator.free(out);

    try std.fs.cwd().writeFile(.{ .sub_path = tracked_path, .data = "dirty\n" });

    var subject = struct {
        allocator: std.mem.Allocator,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{ .allocator = allocator };

    var action_paths = [_][]const u8{"tracked.txt"};
    var response = try handleStagePathLocked(&subject, allocator, .{
        .id = "stage-1",
        .type = "workspace.stagePath",
        .root_path = repo_path,
        .paths = &action_paths,
    });
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    allocator.free(response);

    var status = try git.statusSummaryAlloc(allocator, repo_path);
    try std.testing.expectEqual(@as(u32, 0), status.changed);
    try std.testing.expectEqual(@as(u32, 1), status.staged);

    response = try handleUnstagePathLocked(&subject, allocator, .{
        .id = "unstage-1",
        .type = "workspace.unstagePath",
        .root_path = repo_path,
        .paths = &action_paths,
    });
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    allocator.free(response);

    status = try git.statusSummaryAlloc(allocator, repo_path);
    try std.testing.expectEqual(@as(u32, 1), status.changed);
    try std.testing.expectEqual(@as(u32, 0), status.staged);

    response = try handleRevertPathLocked(&subject, allocator, .{
        .id = "revert-1",
        .type = "workspace.revertPath",
        .root_path = repo_path,
        .paths = &action_paths,
    });
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    allocator.free(response);

    status = try git.statusSummaryAlloc(allocator, repo_path);
    try std.testing.expectEqual(@as(u32, 0), status.changed);
    try std.testing.expectEqual(@as(u32, 0), status.staged);
}

test "workspace git path actions reject option-shaped paths" {
    const allocator = std.testing.allocator;

    var subject = struct {
        allocator: std.mem.Allocator,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{ .allocator = allocator };

    var action_paths = [_][]const u8{"--work-tree=/tmp/other"};
    const response = try handleStagePathLocked(&subject, allocator, .{
        .id = "stage-invalid-1",
        .type = "workspace.stagePath",
        .root_path = "/tmp/repo",
        .paths = &action_paths,
    });
    defer allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"error_code\":\"invalid-path\"") != null);
}

test "workspace port parser deduplicates listening process ports" {
    const output =
        \\p101
        \\ctao-dev
        \\n*:3000 (LISTEN)
        \\n127.0.0.1:3000 (LISTEN)
        \\p102
        \\cnode
        \\n[::1]:5173 (LISTEN)
        \\nmalformed
        \\
    ;

    const ports = try parseListeningPortsAlloc(std.testing.allocator, output);
    defer freeListeningPorts(std.testing.allocator, ports);

    try std.testing.expectEqual(@as(usize, 2), ports.len);
    try std.testing.expectEqual(@as(u32, 101), ports[0].pid);
    try std.testing.expectEqual(@as(u16, 3000), ports[0].port);
    try std.testing.expectEqualStrings("tao-dev", ports[0].process_name.?);
    try std.testing.expectEqual(@as(u32, 102), ports[1].pid);
    try std.testing.expectEqual(@as(u16, 5173), ports[1].port);
    try std.testing.expectEqualStrings("node", ports[1].process_name.?);
}

test "workspace pull request json parser maps gh fields" {
    const output =
        \\{"number":42,"title":"Add Tao","url":"https://example.invalid/pull/42","state":"OPEN","headRefName":"feature/tao"}
    ;

    var pull_request = (try pullRequestInfoFromJsonAlloc(std.testing.allocator, output));
    defer freePullRequestInfo(std.testing.allocator, &pull_request);

    try std.testing.expectEqual(@as(u32, 42), pull_request.number);
    try std.testing.expectEqualStrings("Add Tao", pull_request.title);
    try std.testing.expectEqualStrings("https://example.invalid/pull/42", pull_request.url);
    try std.testing.expectEqualStrings("OPEN", pull_request.state);
    try std.testing.expectEqualStrings("feature/tao", pull_request.head_ref_name.?);
}

test "workspace reconciliation keeps archived external worktree hidden" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const tmp_root_rel = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer allocator.free(tmp_root_rel);
    const tmp_root = try std.fs.cwd().realpathAlloc(allocator, tmp_root_rel);
    defer allocator.free(tmp_root);

    const repo_path = try std.fs.path.join(allocator, &.{ tmp_root, "repo" });
    defer allocator.free(repo_path);
    const external_path = try std.fs.path.join(allocator, &.{ tmp_root, "external-worktree" });
    defer allocator.free(external_path);
    try std.fs.cwd().makePath(repo_path);

    const init_args = [_][]const u8{"init"};
    var out = try git.runGitAlloc(allocator, repo_path, &init_args);
    allocator.free(out);
    const commit_args = [_][]const u8{ "-c", "user.name=Tao Test", "-c", "user.email=tao-test@example.invalid", "commit", "--allow-empty", "-m", "initial" };
    out = try git.runGitAlloc(allocator, repo_path, &commit_args);
    allocator.free(out);
    try git.worktreeAddNewBranch(allocator, repo_path, "external-branch", external_path, "HEAD");

    var database = try db.Database.openInMemory(allocator);
    defer database.deinit();
    try database.insertWorkspace(.{
        .id = "workspace-1",
        .name = "repo",
        .root_path = repo_path,
        .git_common_dir = ".git",
        .workspace_slug = "repo",
        .default_branch = null,
        .order_index = 0,
    });
    try database.insertWorktree(.{
        .id = "worktree-external",
        .workspace_id = "workspace-1",
        .title = "External",
        .folder_name = "external-worktree",
        .path = external_path,
        .branch = "external-branch",
        .state = "active",
        .order_index = 0,
        .created_by = "external",
    });
    try database.archiveWorktree("worktree-external");

    var subject = struct {
        allocator: std.mem.Allocator,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{ .allocator = allocator };

    var workspace_row = (try database.findWorkspaceById(allocator, "workspace-1")).?;
    defer workspace_row.deinit(allocator);
    try reconcileWorkspaceWorktrees(&subject, &database, &workspace_row);

    const active = try database.listWorktreesForWorkspace(allocator, "workspace-1");
    defer {
        for (active) |*row| row.deinit(allocator);
        allocator.free(active);
    }
    try std.testing.expectEqual(@as(usize, 0), active.len);
    try std.testing.expect(!try database.worktreePathExists(external_path));
    try std.testing.expect(try database.archivedWorktreePathExists(external_path));
    var archived = (try database.findWorktreeById(allocator, "worktree-external")).?;
    defer archived.deinit(allocator);
    try std.testing.expectEqualStrings("archived", archived.state);
    try std.testing.expect(archived.archived_at != null);
}

const WorkspaceResponsesAllocationFailureDatabase = struct {
    fn listWorktreesForWorkspace(self: *@This(), allocator: std.mem.Allocator, workspace_id: []const u8) ![]db.WorktreeRow {
        _ = self;
        try std.testing.expectEqualStrings("workspace-oom", workspace_id);
        return allocator.alloc(db.WorktreeRow, 0);
    }
};

fn mutableTestSlice(value: []const u8) []u8 {
    return @constCast(value);
}

fn testWorkspaceRow() db.WorkspaceRow {
    return .{
        .id = mutableTestSlice("workspace-oom"),
        .name = mutableTestSlice("Tao OOM"),
        .root_path = mutableTestSlice("/tmp/tao-workspace-oom"),
        .git_common_dir = mutableTestSlice("/tmp/tao-workspace-oom/.git"),
        .workspace_slug = mutableTestSlice("tao-oom"),
        .default_branch = mutableTestSlice("main"),
        .order_index = 7,
        .last_active_tab_id = mutableTestSlice("tab-oom"),
        .created_at = mutableTestSlice("2026-05-20T00:00:00Z"),
        .updated_at = mutableTestSlice("2026-05-20T00:00:01Z"),
        .archived_at = null,
    };
}

fn testWorktreeRow() db.WorktreeRow {
    return .{
        .id = mutableTestSlice("worktree-oom"),
        .workspace_id = mutableTestSlice("workspace-oom"),
        .title = mutableTestSlice("OOM Worktree"),
        .folder_name = mutableTestSlice("luminous-oom"),
        .path = mutableTestSlice("/tmp/tao-worktree-oom"),
        .branch = mutableTestSlice("luminous-oom"),
        .base_branch = mutableTestSlice("main"),
        .target_branch = mutableTestSlice("main"),
        .state = mutableTestSlice("active"),
        .order_index = 3,
        .last_active_tab_id = mutableTestSlice("tab-oom"),
        .last_error = mutableTestSlice("previous failure"),
        .created_by = mutableTestSlice("tao"),
        .created_at = mutableTestSlice("2026-05-20T00:00:00Z"),
        .updated_at = mutableTestSlice("2026-05-20T00:00:01Z"),
        .archived_at = null,
    };
}

fn workspaceResponsesForAllocationFailure(allocator: std.mem.Allocator) !void {
    var database = WorkspaceResponsesAllocationFailureDatabase{};
    const Subject = struct {
        allocator: std.mem.Allocator,
        database: ?*WorkspaceResponsesAllocationFailureDatabase,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    };
    var self = Subject{
        .allocator = allocator,
        .database = &database,
    };
    const rows = [_]db.WorkspaceRow{testWorkspaceRow()};
    const responses = try workspaceResponsesAlloc(&self, rows[0..], false);
    defer freeWorkspaceResponses(allocator, responses);
    try std.testing.expectEqual(@as(usize, 1), responses.len);
    try std.testing.expectEqualStrings("workspace-oom", responses[0].id);
}

fn worktreeResponseForAllocationFailure(allocator: std.mem.Allocator) !void {
    const response = try worktreeResponseFromRowAlloc(allocator, testWorktreeRow(), .{ .changed = 1, .staged = 2 });
    defer freeWorktreeResponseFields(allocator, response);
    try std.testing.expectEqualStrings("worktree-oom", response.id);
    try std.testing.expectEqual(@as(u32, 1), response.git_status.?.changed);
}

test "workspace response builders clean up on OOM" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        workspaceResponsesForAllocationFailure,
        .{},
    );
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        worktreeResponseForAllocationFailure,
        .{},
    );
}
