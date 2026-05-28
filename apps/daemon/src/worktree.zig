const std = @import("std");
const db = @import("db.zig");
const git = @import("git.zig");
const rpc = @import("rpc.zig");
const workspace = @import("workspace.zig");
const worktree_name = @import("worktree_name.zig");

const assert = std.debug.assert;

const ErrorCode = enum {
    invalid_workspace,
    invalid_worktree,
    invalid_path,
    invalid_name,
    branch_exists,
    branch_checked_out,
    worktree_dirty,
    git_failed,
    state_conflict,

    fn text(self: ErrorCode) []const u8 {
        return switch (self) {
            .invalid_workspace => "invalid-workspace",
            .invalid_worktree => "invalid-worktree",
            .invalid_path => "invalid-path",
            .invalid_name => "invalid-name",
            .branch_exists => "branch-exists",
            .branch_checked_out => "branch-checked-out",
            .worktree_dirty => "worktree-dirty",
            .git_failed => "git-failed",
            .state_conflict => "state-conflict",
        };
    }
};

const WorktreeListPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    worktrees: []const workspace.WorktreeResponse,
};

const WorktreePayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    worktree: workspace.WorktreeResponse,
};

const WorktreeHandoffPayload = struct {
    id: ?[]const u8 = null,
    ok: bool = true,
    branch: []const u8,
    source_path: []const u8,
    destination_path: []const u8,
};

pub fn handleListLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorResponse(allocator, request, .state_conflict, "database is unavailable");
    const workspace_id = request.requestWorkspaceId() orelse return errorResponse(allocator, request, .invalid_workspace, "workspace_id is required");
    const rows = try database.listWorktreesForWorkspace(self.allocator, workspace_id);
    defer {
        for (rows) |*row| row.deinit(self.allocator);
        self.allocator.free(rows);
    }

    const responses = try worktreeResponsesAlloc(self.allocator, rows);
    defer workspace.freeWorktreeResponses(self.allocator, responses);

    return jsonAlloc(allocator, WorktreeListPayload{ .id = request.requestId(), .worktrees = responses });
}

pub fn handleCreateLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorResponse(allocator, request, .state_conflict, "database is unavailable");
    const workspace_id = request.requestWorkspaceId() orelse return errorResponse(allocator, request, .invalid_workspace, "workspace_id is required");
    var workspace_row = (try database.findWorkspaceById(self.allocator, workspace_id)) orelse return errorResponse(allocator, request, .invalid_workspace, "workspace not found");
    defer workspace_row.deinit(self.allocator);
    if (workspace_row.git_common_dir == null) return errorResponse(allocator, request, .invalid_workspace, "workspace is not a Git repository");

    const base_branch_owned = if (request.requestBaseBranch()) |value|
        try self.allocator.dupe(u8, value)
    else if (workspace_row.default_branch) |value|
        try self.allocator.dupe(u8, value)
    else blk: {
        const current = blk_current: {
            self.unlock();
            defer self.lock();
            break :blk_current try git.currentBranchAlloc(self.allocator, workspace_row.root_path);
        };
        break :blk current orelse return errorResponse(allocator, request, .invalid_workspace, "workspace default branch not found");
    };
    defer self.allocator.free(base_branch_owned);
    const start_point = request.requestStartPoint() orelse base_branch_owned;

    var folder_name: []u8 = undefined;
    var branch_name: []u8 = undefined;
    var generated_folder = false;
    var generated_branch = false;
    var generated_names = false;
    defer if (generated_folder) self.allocator.free(folder_name);
    defer if (generated_branch) self.allocator.free(branch_name);

    if (request.requestFolderName()) |manual_folder| {
        if (!worktree_name.isValidFolderName(manual_folder)) return errorResponse(allocator, request, .invalid_name, "invalid folder_name");
        folder_name = @constCast(manual_folder);
    } else if (request.branch != null) {
        folder_name = try generateAvailableFolderAlloc(self, database, &workspace_row);
        generated_folder = true;
    } else {
        const names = try generateAvailableNamesAlloc(self, database, &workspace_row);
        folder_name = names.folder;
        branch_name = names.branch;
        generated_folder = true;
        generated_branch = true;
        generated_names = true;
    }

    if (request.branch) |manual_branch| {
        if (!worktree_name.isSafeBranchName(manual_branch)) return errorResponse(allocator, request, .invalid_name, "invalid branch");
        branch_name = @constCast(manual_branch);
    } else if (!generated_names) {
        branch_name = try worktree_name.branchForFolderAlloc(self.allocator, folder_name);
        generated_branch = true;
    }

    if (try database.worktreeFolderExists(workspace_row.id, folder_name)) return errorResponse(allocator, request, .invalid_name, "folder_name already exists");
    if (try database.worktreeBranchExists(workspace_row.id, branch_name)) return errorResponse(allocator, request, .branch_exists, "branch already exists in Tao worktrees");
    const branch_in_git = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.branchExists(self.allocator, workspace_row.root_path, branch_name);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "failed to check branch existence"),
        else => return err,
    };
    if (branch_in_git) return errorResponse(allocator, request, .branch_exists, "branch already exists");

    const parent_path = try worktreeParentPathAlloc(self.allocator, self.config.root_dir, workspace_row.workspace_slug);
    defer self.allocator.free(parent_path);
    const worktree_path = try std.fs.path.join(self.allocator, &.{ parent_path, folder_name });
    defer self.allocator.free(worktree_path);
    assert(parent_path.len > 0);
    assert(worktree_path.len > parent_path.len);
    if (!isPathUnder(parent_path, worktree_path)) return errorResponse(allocator, request, .invalid_path, "worktree path escaped root");
    const worktree_path_exists = blk: {
        self.unlock();
        defer self.lock();
        break :blk pathExists(worktree_path);
    };
    if (worktree_path_exists or try database.worktreePathExists(worktree_path)) return errorResponse(allocator, request, .invalid_path, "worktree path already exists");

    // The Git/path checks above drop the daemon lock. Re-check the persisted
    // uniqueness boundaries immediately before reserving the row.
    if (try database.worktreeFolderExists(workspace_row.id, folder_name)) return errorResponse(allocator, request, .invalid_name, "folder_name already exists");
    if (try database.worktreeBranchExists(workspace_row.id, branch_name)) return errorResponse(allocator, request, .branch_exists, "branch already exists in Tao worktrees");
    if (try database.worktreePathExists(worktree_path)) return errorResponse(allocator, request, .invalid_path, "worktree path already exists");

    const worktree_id = try workspace.idAlloc(self.allocator, "worktree");
    defer self.allocator.free(worktree_id);
    const order_index = try database.nextWorktreeOrder(workspace_row.id);
    const target_branch = request.requestTargetBranch() orelse branch_name;

    try database.insertWorktree(.{
        .id = worktree_id,
        .workspace_id = workspace_row.id,
        .title = request.title orelse branch_name,
        .folder_name = folder_name,
        .path = worktree_path,
        .branch = branch_name,
        .base_branch = base_branch_owned,
        .target_branch = target_branch,
        .state = "creating",
        .order_index = order_index,
    });
    var inserted_row = (try database.findWorktreeByPath(self.allocator, worktree_path)) orelse return errorResponse(allocator, request, .invalid_worktree, "created worktree not found");
    defer inserted_row.deinit(self.allocator);
    const effective_worktree_id = inserted_row.id;

    (blk: {
        self.unlock();
        defer self.lock();
        break :blk std.fs.cwd().makePath(parent_path);
    }) catch |err| {
        try database.updateWorktreeState(effective_worktree_id, "error", @errorName(err));
        return errorResponse(allocator, request, .invalid_path, "failed to create worktree parent directory");
    };

    const prune_args = [_][]const u8{ "worktree", "prune" };
    {
        self.unlock();
        defer self.lock();
        if (git.runGitAlloc(self.allocator, workspace_row.root_path, &prune_args)) |out| self.allocator.free(out) else |_| {}
    }

    (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.worktreeAddNewBranch(self.allocator, workspace_row.root_path, branch_name, worktree_path, start_point);
    }) catch |err| {
        std.log.warn("git worktree add failed for {s}; leaving path in place for reconciliation", .{worktree_path});
        try database.updateWorktreeState(effective_worktree_id, "error", @errorName(err));
        return errorResponse(allocator, request, .git_failed, "git worktree add failed");
    };

    try database.updateWorktreeState(effective_worktree_id, "active", null);
    var row = (try database.findWorktreeByPath(self.allocator, worktree_path)) orelse return errorResponse(allocator, request, .invalid_worktree, "created worktree not found");
    defer row.deinit(self.allocator);
    const response = try workspace.worktreeResponseFromRowAlloc(self.allocator, row, null);
    defer workspace.freeWorktreeResponseFields(self.allocator, response);

    return jsonAlloc(allocator, WorktreePayload{ .id = request.requestId(), .worktree = response });
}

pub fn handleRefreshLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorResponse(allocator, request, .state_conflict, "database is unavailable");
    if (request.requestWorktreeId()) |worktree_id| {
        refreshSingleWorktree(self, database, worktree_id) catch |err| switch (err) {
            error.InvalidWorktree => return errorResponse(allocator, request, .invalid_worktree, "worktree not found"),
            error.InvalidWorkspace => return errorResponse(allocator, request, .invalid_workspace, "workspace not found"),
            error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "git worktree list failed"),
            else => return err,
        };
        var row = (try database.findWorktreeById(self.allocator, worktree_id)) orelse return errorResponse(allocator, request, .invalid_worktree, "worktree not found");
        defer row.deinit(self.allocator);
        const response = try workspace.worktreeResponseFromRowAlloc(self.allocator, row, null);
        defer workspace.freeWorktreeResponseFields(self.allocator, response);
        return jsonAlloc(allocator, WorktreePayload{ .id = request.requestId(), .worktree = response });
    }

    const workspace_id = request.requestWorkspaceId() orelse return errorResponse(allocator, request, .invalid_workspace, "workspace_id is required");
    refreshWorkspaceWorktrees(self, database, workspace_id) catch |err| switch (err) {
        error.InvalidWorkspace => return errorResponse(allocator, request, .invalid_workspace, "workspace not found"),
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "git worktree list failed"),
        else => return err,
    };
    return handleListLocked(self, allocator, request);
}

pub fn handleHandoffLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorResponse(allocator, request, .state_conflict, "database is unavailable");
    const raw_path = request.requestRootPath() orelse request.cwd orelse return errorResponse(allocator, request, .invalid_path, "path is required");
    const current_path = (blk: {
        self.unlock();
        defer self.lock();
        break :blk workspace.canonicalPathAlloc(self.allocator, raw_path);
    }) catch return errorResponse(allocator, request, .invalid_path, "invalid handoff path");
    defer self.allocator.free(current_path);

    const location = findHandoffLocationAlloc(self.allocator, database, current_path) catch |err| switch (err) {
        error.InvalidWorkspace => return errorResponse(allocator, request, .invalid_workspace, "handoff must run from inside a taod workspace or worktree"),
        else => return err,
    };
    defer location.deinit(self.allocator);

    var workspace_row = (try database.findWorkspaceById(self.allocator, location.workspace_id)) orelse return errorResponse(allocator, request, .invalid_workspace, "workspace not found");
    defer workspace_row.deinit(self.allocator);
    if (workspace_row.git_common_dir == null) return errorResponse(allocator, request, .invalid_workspace, "workspace is not a Git repository");

    if (location.worktree_id) |worktree_id| {
        var row = (try database.findWorktreeById(self.allocator, worktree_id)) orelse return errorResponse(allocator, request, .invalid_worktree, "worktree not found");
        defer row.deinit(self.allocator);
        return handleWorktreeToLocalHandoffLocked(self, allocator, request, database, &workspace_row, &row);
    }

    return handleLocalToWorktreeHandoffLocked(self, allocator, request, database, &workspace_row);
}

pub fn handleRemoveLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorResponse(allocator, request, .state_conflict, "database is unavailable");
    const worktree_id = request.requestWorktreeId() orelse return errorResponse(allocator, request, .invalid_worktree, "worktree_id is required");
    var row = (try database.findWorktreeById(self.allocator, worktree_id)) orelse return errorResponse(allocator, request, .invalid_worktree, "worktree not found");
    defer row.deinit(self.allocator);
    var workspace_row = (try database.findWorkspaceById(self.allocator, row.workspace_id)) orelse return errorResponse(allocator, request, .invalid_workspace, "workspace not found");
    defer workspace_row.deinit(self.allocator);

    if (std.mem.eql(u8, workspace_row.root_path, row.path)) return errorResponse(allocator, request, .invalid_path, "cannot remove workspace root as worktree");

    if (std.mem.eql(u8, row.created_by, "external") and !request.requestForce()) {
        try database.archiveWorktree(row.id);
        return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
    }
    assert(!std.mem.eql(u8, row.created_by, "external") or request.requestForce());

    const entries = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.worktreeListAlloc(self.allocator, workspace_row.root_path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "git worktree list failed"),
        else => return err,
    };
    defer {
        for (entries) |*entry| entry.deinit(self.allocator);
        self.allocator.free(entries);
    }
    const git_entry = blk: {
        self.unlock();
        defer self.lock();
        break :blk findGitWorktree(self.allocator, entries, row.path);
    };
    const row_path_exists = blk: {
        self.unlock();
        defer self.lock();
        break :blk pathExists(row.path);
    };
    if (!row_path_exists or git_entry == null or (git_entry != null and git_entry.?.prunable)) {
        {
            self.unlock();
            defer self.lock();
            pruneGitWorktrees(self.allocator, workspace_row.root_path);
        }
        try database.archiveWorktree(row.id);
        return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
    }

    if (!request.requestForce()) {
        const dirty = (blk: {
            self.unlock();
            defer self.lock();
            break :blk git.isDirty(self.allocator, row.path);
        }) catch |err| switch (err) {
            error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "failed to determine worktree status"),
            else => return err,
        };
        if (dirty) return errorResponse(allocator, request, .worktree_dirty, "worktree has uncommitted or untracked changes");
    }

    try database.updateWorktreeState(row.id, "removing", null);
    (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.worktreeRemove(self.allocator, workspace_row.root_path, row.path, request.requestForce());
    }) catch |err| {
        const removed_path_exists = blk_exists: {
            self.unlock();
            defer self.lock();
            break :blk_exists pathExists(row.path);
        };
        if (!removed_path_exists) {
            {
                self.unlock();
                defer self.lock();
                pruneGitWorktrees(self.allocator, workspace_row.root_path);
            }
            try database.archiveWorktree(row.id);
            return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
        }
        try database.updateWorktreeState(row.id, "error", @errorName(err));
        return errorResponse(allocator, request, .git_failed, "git worktree remove failed");
    };
    try database.archiveWorktree(row.id);

    if (request.requestDeleteBranch()) {
        const delete_args = [_][]const u8{ "branch", "-D", row.branch };
        {
            self.unlock();
            defer self.lock();
            if (git.runGitAlloc(self.allocator, workspace_row.root_path, &delete_args)) |out| self.allocator.free(out) else |err| {
                std.log.warn("branch deletion failed for {s}: {t}", .{ row.branch, err });
            }
        }
    }

    return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
}

pub fn handleAdoptLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorResponse(allocator, request, .state_conflict, "database is unavailable");
    const workspace_id = request.requestWorkspaceId() orelse return errorResponse(allocator, request, .invalid_workspace, "workspace_id is required");
    const path = request.requestRootPath() orelse return errorResponse(allocator, request, .invalid_path, "path is required");
    var workspace_row = (try database.findWorkspaceById(self.allocator, workspace_id)) orelse return errorResponse(allocator, request, .invalid_workspace, "workspace not found");
    defer workspace_row.deinit(self.allocator);

    const canonical = (blk: {
        self.unlock();
        defer self.lock();
        break :blk workspace.canonicalPathAlloc(self.allocator, path);
    }) catch return errorResponse(allocator, request, .invalid_path, "invalid worktree path");
    defer self.allocator.free(canonical);
    if (std.mem.eql(u8, canonical, workspace_row.root_path)) return errorResponse(allocator, request, .invalid_path, "cannot adopt workspace root as worktree");
    if (try database.findWorktreeByPath(self.allocator, canonical)) |existing_row| {
        var existing = existing_row;
        defer existing.deinit(self.allocator);
        if (!std.mem.eql(u8, existing.workspace_id, workspace_row.id)) {
            return errorResponse(allocator, request, .invalid_path, "path belongs to a different workspace");
        }
        const response = try workspace.worktreeResponseFromRowAlloc(self.allocator, existing, null);
        defer workspace.freeWorktreeResponseFields(self.allocator, response);
        return jsonAlloc(allocator, WorktreePayload{ .id = request.requestId(), .worktree = response });
    }

    const entries = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.worktreeListAlloc(self.allocator, workspace_row.root_path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "git worktree list failed"),
        else => return err,
    };
    defer {
        for (entries) |*entry| entry.deinit(self.allocator);
        self.allocator.free(entries);
    }
    const entry = (blk: {
        self.unlock();
        defer self.lock();
        break :blk findGitWorktree(self.allocator, entries, canonical);
    }) orelse return errorResponse(allocator, request, .invalid_path, "path is not a Git worktree for this workspace");
    if (entry.prunable) {
        {
            self.unlock();
            defer self.lock();
            pruneGitWorktrees(self.allocator, workspace_row.root_path);
        }
        return errorResponse(allocator, request, .invalid_path, "path is a prunable Git worktree");
    }
    const basename = std.fs.path.basename(canonical);
    const folder_name = try workspace.adoptedFolderNameAlloc(self.allocator, database, workspace_row.id, canonical);
    defer self.allocator.free(folder_name);
    const worktree_id = try workspace.idAlloc(self.allocator, "worktree");
    defer self.allocator.free(worktree_id);
    var branch_owned: ?[]u8 = null;
    defer if (branch_owned) |value| self.allocator.free(value);
    const branch = entry.branch orelse blk: {
        branch_owned = try worktree_name.detachedBranchForFolderAlloc(self.allocator, worktree_id);
        break :blk branch_owned.?;
    };
    if (try database.worktreeBranchExists(workspace_row.id, branch)) return errorResponse(allocator, request, .branch_exists, "branch already exists in Tao worktrees");
    try database.insertWorktree(.{
        .id = worktree_id,
        .workspace_id = workspace_row.id,
        .title = basename,
        .folder_name = folder_name,
        .path = canonical,
        .branch = branch,
        .state = "active",
        .order_index = try database.nextWorktreeOrder(workspace_row.id),
        .created_by = "external",
    });
    var row = (try database.findWorktreeByPath(self.allocator, canonical)) orelse return errorResponse(allocator, request, .invalid_worktree, "adopted worktree not found");
    defer row.deinit(self.allocator);
    const response = try workspace.worktreeResponseFromRowAlloc(self.allocator, row, null);
    defer workspace.freeWorktreeResponseFields(self.allocator, response);
    return jsonAlloc(allocator, WorktreePayload{ .id = request.requestId(), .worktree = response });
}

pub fn handleReorderLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const database = if (self.database) |*database| database else return errorResponse(allocator, request, .state_conflict, "database is unavailable");
    const worktree_id = request.requestWorktreeId() orelse return errorResponse(allocator, request, .invalid_worktree, "worktree_id is required");
    const order_index = request.requestOrderIndex() orelse return errorResponse(allocator, request, .state_conflict, "order_index is required");
    var row = (try database.findWorktreeById(self.allocator, worktree_id)) orelse return errorResponse(allocator, request, .invalid_worktree, "worktree not found");
    row.deinit(self.allocator);
    try database.reorderWorktree(worktree_id, order_index);
    return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
}

const HandoffLocation = struct {
    workspace_id: []u8,
    worktree_id: ?[]u8 = null,

    fn deinit(self: *const HandoffLocation, allocator: std.mem.Allocator) void {
        allocator.free(self.workspace_id);
        if (self.worktree_id) |value| allocator.free(value);
    }
};

fn handleWorktreeToLocalHandoffLocked(
    self: anytype,
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    database: *db.Database,
    workspace_row: *const db.WorkspaceRow,
    row: *const db.WorktreeRow,
) ![]u8 {
    const branch = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.currentNamedBranchAlloc(self.allocator, row.path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "failed to read current worktree branch"),
        else => return err,
    } orelse return errorResponse(allocator, request, .invalid_worktree, "current worktree checkout is detached");
    defer self.allocator.free(branch);

    const branch_exists = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.branchExists(self.allocator, workspace_row.root_path, branch);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "failed to check local branch"),
        else => return err,
    };
    if (!branch_exists) return errorResponse(allocator, request, .invalid_worktree, "local branch does not exist");

    const dirty = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.isDirty(self.allocator, row.path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "failed to determine worktree status"),
        else => return err,
    };
    if (dirty) return errorResponse(allocator, request, .worktree_dirty, "current worktree has uncommitted or untracked changes");

    var restore_failed = false;
    (blk: {
        self.unlock();
        defer self.lock();
        gitSwitch(self.allocator, row.path, &.{ "switch", "--detach" }) catch |detach_err| break :blk detach_err;
        gitSwitch(self.allocator, workspace_row.root_path, &.{ "switch", "--no-guess", branch }) catch |switch_err| {
            gitSwitch(self.allocator, row.path, &.{ "switch", "--no-guess", branch }) catch |restore_err| {
                restore_failed = true;
                std.log.warn("failed to restore worktree branch {s} at {s}: {t}", .{ branch, row.path, restore_err });
            };
            break :blk switch_err;
        };
        break :blk {};
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => {
            if (restore_failed) return handoffRestoreFailedResponse(allocator, request, row.path, branch);
            return errorResponse(allocator, request, .git_failed, "git handoff failed");
        },
        else => return err,
    };

    refreshWorkspaceWorktrees(self, database, workspace_row.id) catch |err| switch (err) {
        error.InvalidWorkspace => return errorResponse(allocator, request, .invalid_workspace, "workspace not found"),
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "git worktree list failed"),
        else => return err,
    };

    return jsonAlloc(allocator, WorktreeHandoffPayload{
        .id = request.requestId(),
        .branch = branch,
        .source_path = row.path,
        .destination_path = workspace_row.root_path,
    });
}

fn handleLocalToWorktreeHandoffLocked(
    self: anytype,
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    database: *db.Database,
    workspace_row: *const db.WorkspaceRow,
) ![]u8 {
    const branch = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.currentNamedBranchAlloc(self.allocator, workspace_row.root_path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "failed to read local workspace branch"),
        else => return err,
    } orelse return errorResponse(allocator, request, .invalid_workspace, "local workspace checkout is detached");
    defer self.allocator.free(branch);

    var row = findHandoffTargetWorktreeAlloc(self, database, workspace_row, branch) catch |err| switch (err) {
        error.InvalidWorktree => return errorResponse(allocator, request, .invalid_worktree, "no taod-managed worktree can receive the current branch"),
        error.StateConflict => return errorResponse(allocator, request, .state_conflict, "current branch matched multiple taod-managed worktrees"),
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "failed to resolve worktree handoff target"),
        else => return err,
    };
    defer row.deinit(self.allocator);

    const dirty = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.isDirty(self.allocator, workspace_row.root_path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "failed to determine local workspace status"),
        else => return err,
    };
    if (dirty) return errorResponse(allocator, request, .worktree_dirty, "local workspace has uncommitted or untracked changes");

    var restore_failed = false;
    (blk: {
        self.unlock();
        defer self.lock();
        gitSwitch(self.allocator, workspace_row.root_path, &.{ "switch", "--detach" }) catch |detach_err| break :blk detach_err;
        gitSwitch(self.allocator, row.path, &.{ "switch", "--no-guess", branch }) catch |switch_err| {
            gitSwitch(self.allocator, workspace_row.root_path, &.{ "switch", "--no-guess", branch }) catch |restore_err| {
                restore_failed = true;
                std.log.warn("failed to restore local branch {s} at {s}: {t}", .{ branch, workspace_row.root_path, restore_err });
            };
            break :blk switch_err;
        };
        break :blk {};
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => {
            if (restore_failed) return handoffRestoreFailedResponse(allocator, request, workspace_row.root_path, branch);
            return errorResponse(allocator, request, .git_failed, "git handoff failed");
        },
        else => return err,
    };

    refreshWorkspaceWorktrees(self, database, workspace_row.id) catch |err| switch (err) {
        error.InvalidWorkspace => return errorResponse(allocator, request, .invalid_workspace, "workspace not found"),
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "git worktree list failed"),
        else => return err,
    };

    return jsonAlloc(allocator, WorktreeHandoffPayload{
        .id = request.requestId(),
        .branch = branch,
        .source_path = workspace_row.root_path,
        .destination_path = row.path,
    });
}

fn refreshSingleWorktree(self: anytype, database: *db.Database, worktree_id: []const u8) !void {
    var row = (try database.findWorktreeById(self.allocator, worktree_id)) orelse return error.InvalidWorktree;
    defer row.deinit(self.allocator);
    try refreshWorkspaceWorktrees(self, database, row.workspace_id);
}

fn refreshWorkspaceWorktrees(self: anytype, database: *db.Database, workspace_id: []const u8) !void {
    var workspace_row = (try database.findWorkspaceById(self.allocator, workspace_id)) orelse return error.InvalidWorkspace;
    defer workspace_row.deinit(self.allocator);
    const entries = (blk: {
        self.unlock();
        defer self.lock();
        break :blk git.worktreeListAlloc(self.allocator, workspace_row.root_path);
    }) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return err,
        else => return err,
    };
    defer {
        for (entries) |*entry| entry.deinit(self.allocator);
        self.allocator.free(entries);
    }
    const rows = try database.listWorktreesForWorkspace(self.allocator, workspace_id);
    defer {
        for (rows) |*row| row.deinit(self.allocator);
        self.allocator.free(rows);
    }
    for (rows) |row| {
        const maybe_entry = blk: {
            self.unlock();
            defer self.lock();
            break :blk findGitWorktree(self.allocator, entries, row.path);
        };
        if (maybe_entry) |entry| {
            const row_path_exists = blk: {
                self.unlock();
                defer self.lock();
                break :blk pathExists(row.path);
            };
            if (entry.prunable or !row_path_exists) {
                try database.archiveWorktree(row.id);
                continue;
            }
            var branch_owned: ?[]u8 = null;
            defer if (branch_owned) |value| self.allocator.free(value);
            const branch = entry.branch orelse blk: {
                branch_owned = try worktree_name.detachedBranchForFolderAlloc(self.allocator, row.id);
                break :blk branch_owned.?;
            };
            try database.updateWorktreeGit(row.id, branch, "active");
        } else {
            const row_path_exists = blk: {
                self.unlock();
                defer self.lock();
                break :blk pathExists(row.path);
            };
            if (!row_path_exists) {
                try database.archiveWorktree(row.id);
            } else {
                try database.updateWorktreeState(row.id, "missing", null);
            }
        }
    }
}

const GeneratedWorktreeNames = struct {
    folder: []u8,
    branch: []u8,
};

fn generateAvailableFolderAlloc(self: anytype, database: *db.Database, workspace_row: *const db.WorkspaceRow) ![]u8 {
    const parent = try worktreeParentPathAlloc(self.allocator, self.config.root_dir, workspace_row.workspace_slug);
    defer self.allocator.free(parent);

    var attempts: usize = 0;
    while (attempts < 64) : (attempts += 1) {
        const folder = try worktree_name.generatedFolderNameAlloc(self.allocator);
        var keep_folder = false;
        defer if (!keep_folder) self.allocator.free(folder);
        const candidate_path = try std.fs.path.join(self.allocator, &.{ parent, folder });
        defer self.allocator.free(candidate_path);
        const candidate_exists = blk: {
            self.unlock();
            defer self.lock();
            break :blk pathExists(candidate_path);
        };
        if (candidate_exists) continue;
        if (try database.worktreeFolderExists(workspace_row.id, folder)) continue;
        keep_folder = true;
        return folder;
    }
    return error.TooManyCollisions;
}

fn generateAvailableNamesAlloc(self: anytype, database: *db.Database, workspace_row: *const db.WorkspaceRow) !GeneratedWorktreeNames {
    const parent = try worktreeParentPathAlloc(self.allocator, self.config.root_dir, workspace_row.workspace_slug);
    defer self.allocator.free(parent);

    var attempts: usize = 0;
    while (attempts < 64) : (attempts += 1) {
        const folder = try worktree_name.generatedFolderNameAlloc(self.allocator);
        var keep_folder = false;
        defer if (!keep_folder) self.allocator.free(folder);
        const branch = try worktree_name.generatedBranchNameAlloc(self.allocator);
        var keep_branch = false;
        defer if (!keep_branch) self.allocator.free(branch);
        const candidate_path = try std.fs.path.join(self.allocator, &.{ parent, folder });
        defer self.allocator.free(candidate_path);
        const candidate_exists = blk: {
            self.unlock();
            defer self.lock();
            break :blk pathExists(candidate_path);
        };
        if (candidate_exists) continue;
        if (try database.worktreeFolderExists(workspace_row.id, folder)) continue;
        if (try database.worktreeBranchExists(workspace_row.id, branch)) continue;
        const branch_exists = blk: {
            self.unlock();
            defer self.lock();
            break :blk git.branchExists(self.allocator, workspace_row.root_path, branch) catch false;
        };
        if (branch_exists) continue;
        keep_folder = true;
        keep_branch = true;
        return .{ .folder = folder, .branch = branch };
    }
    return error.TooManyCollisions;
}

fn worktreeParentPathAlloc(allocator: std.mem.Allocator, root_dir: []const u8, workspace_slug: []const u8) ![]u8 {
    return std.fs.path.join(allocator, &.{ root_dir, "worktrees", workspace_slug });
}

fn worktreeResponsesAlloc(allocator: std.mem.Allocator, rows: []const db.WorktreeRow) ![]workspace.WorktreeResponse {
    var responses = try allocator.alloc(workspace.WorktreeResponse, rows.len);
    var initialized: usize = 0;
    errdefer {
        for (responses[0..initialized]) |response| workspace.freeWorktreeResponseFields(allocator, response);
        allocator.free(responses);
    }
    for (rows, 0..) |row, index| {
        responses[index] = try workspace.worktreeResponseFromRowAlloc(allocator, row, null);
        initialized += 1;
    }
    return responses;
}

fn findHandoffLocationAlloc(allocator: std.mem.Allocator, database: *db.Database, current_path: []const u8) !HandoffLocation {
    const workspace_rows = try database.listWorkspaces(allocator);
    defer {
        for (workspace_rows) |*row| row.deinit(allocator);
        allocator.free(workspace_rows);
    }

    var best_workspace_id: ?[]u8 = null;
    errdefer if (best_workspace_id) |value| allocator.free(value);
    var best_worktree_id: ?[]u8 = null;
    errdefer if (best_worktree_id) |value| allocator.free(value);
    var best_score: usize = 0;

    for (workspace_rows) |workspace_row| {
        if (isPathUnderMaybeReal(allocator, workspace_row.root_path, current_path)) {
            const score = pathComponentScore(workspace_row.root_path);
            if (score > best_score) {
                try replaceHandoffLocation(allocator, &best_workspace_id, &best_worktree_id, workspace_row.id, null);
                best_score = score;
            }
        }

        const worktree_rows = try database.listWorktreesForWorkspace(allocator, workspace_row.id);
        defer {
            for (worktree_rows) |*row| row.deinit(allocator);
            allocator.free(worktree_rows);
        }
        for (worktree_rows) |worktree_row| {
            if (!isPathUnderMaybeReal(allocator, worktree_row.path, current_path)) continue;
            const score = pathComponentScore(worktree_row.path);
            if (score <= best_score) continue;
            try replaceHandoffLocation(allocator, &best_workspace_id, &best_worktree_id, workspace_row.id, worktree_row.id);
            best_score = score;
        }
    }

    return .{
        .workspace_id = best_workspace_id orelse return error.InvalidWorkspace,
        .worktree_id = best_worktree_id,
    };
}

fn replaceHandoffLocation(
    allocator: std.mem.Allocator,
    best_workspace_id: *?[]u8,
    best_worktree_id: *?[]u8,
    workspace_id: []const u8,
    worktree_id: ?[]const u8,
) !void {
    const new_workspace_id = try allocator.dupe(u8, workspace_id);
    errdefer allocator.free(new_workspace_id);
    const new_worktree_id = if (worktree_id) |id| try allocator.dupe(u8, id) else null;
    errdefer if (new_worktree_id) |value| allocator.free(value);

    if (best_workspace_id.*) |value| allocator.free(value);
    if (best_worktree_id.*) |value| allocator.free(value);
    best_workspace_id.* = new_workspace_id;
    best_worktree_id.* = new_worktree_id;
}

fn findHandoffTargetWorktreeAlloc(self: anytype, database: *db.Database, workspace_row: *const db.WorkspaceRow, branch: []const u8) !db.WorktreeRow {
    const rows = try database.listWorktreesForWorkspace(self.allocator, workspace_row.id);
    defer {
        for (rows) |*row| row.deinit(self.allocator);
        self.allocator.free(rows);
    }

    var match_count: usize = 0;
    var matched_id: ?[]u8 = null;
    defer if (matched_id) |value| self.allocator.free(value);

    for (rows) |row| {
        if (!std.mem.eql(u8, row.branch, branch) and (row.target_branch == null or !std.mem.eql(u8, row.target_branch.?, branch))) continue;
        match_count += 1;
        if (match_count == 1) matched_id = try self.allocator.dupe(u8, row.id);
    }
    if (match_count == 0) {
        const branch_head = blk: {
            self.unlock();
            defer self.lock();
            break :blk try git.revParseAlloc(self.allocator, workspace_row.root_path, branch);
        };
        defer self.allocator.free(branch_head);
        for (rows) |row| {
            const worktree_head = blk: {
                self.unlock();
                defer self.lock();
                break :blk git.revParseAlloc(self.allocator, row.path, "HEAD") catch null;
            };
            if (worktree_head) |head| {
                defer self.allocator.free(head);
                if (!std.mem.eql(u8, head, branch_head)) continue;
                match_count += 1;
                if (match_count == 1) matched_id = try self.allocator.dupe(u8, row.id);
            }
        }
    }

    if (match_count == 0) return error.InvalidWorktree;
    if (match_count > 1) return error.StateConflict;
    return (try database.findWorktreeById(self.allocator, matched_id.?)) orelse error.InvalidWorktree;
}

fn gitSwitch(allocator: std.mem.Allocator, path: []const u8, args: []const []const u8) !void {
    const out = try git.runGitAlloc(allocator, path, args);
    allocator.free(out);
}

fn handoffRestoreFailedResponse(allocator: std.mem.Allocator, request: rpc.ControlRequestJson, source_path: []const u8, branch: []const u8) ![]u8 {
    const message = try std.fmt.allocPrint(
        allocator,
        "git handoff failed and failed to restore the source checkout; {s} may be left detached. Run `git -C {s} switch --no-guess {s}` to recover.",
        .{ source_path, source_path, branch },
    );
    defer allocator.free(message);
    return errorResponse(allocator, request, .git_failed, message);
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

fn isPathUnder(parent: []const u8, path: []const u8) bool {
    if (!std.mem.startsWith(u8, path, parent)) return false;
    return path.len == parent.len or path[parent.len] == std.fs.path.sep;
}

fn isPathUnderMaybeReal(allocator: std.mem.Allocator, parent: []const u8, path: []const u8) bool {
    if (isPathUnder(parent, path)) return true;
    const real_parent = std.fs.realpathAlloc(allocator, parent) catch return false;
    defer allocator.free(real_parent);
    return isPathUnder(real_parent, path);
}

fn pathComponentScore(path: []const u8) usize {
    var score: usize = 0;
    var iterator = std.fs.path.componentIterator(path) catch return path.len;
    while (iterator.next()) |_| score += 1;
    return score;
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

fn errorResponse(allocator: std.mem.Allocator, request: rpc.ControlRequestJson, code: ErrorCode, message: []const u8) ![]u8 {
    return workspace.errorJsonAlloc(allocator, request, code.text(), message);
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
    return std.fs.cwd().readFileAlloc(allocator, path, 4096);
}

test "worktree response matches shared golden fixture" {
    const allocator = std.testing.allocator;
    const worktree_response = workspace.WorktreeResponse{
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
    };

    const json = try jsonAlloc(allocator, WorktreePayload{
        .id = "worktree-response-fixture",
        .worktree = worktree_response,
    });
    defer allocator.free(json);
    const golden = try readProtocolFixtureAlloc(allocator, "control-worktree-response.ndjson");
    defer allocator.free(golden);
    try std.testing.expectEqualStrings(golden, json);
}

test "worktree path containment requires separator" {
    try std.testing.expect(isPathUnder("/tmp/root", "/tmp/root/child"));
    try std.testing.expect(!isPathUnder("/tmp/root", "/tmp/root-other/child"));
}

test "generated create uses uuid folder and readable branch" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const tmp_root_rel = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer allocator.free(tmp_root_rel);
    const tmp_root = try std.fs.cwd().realpathAlloc(allocator, tmp_root_rel);
    defer allocator.free(tmp_root);

    const repo_path = try std.fs.path.join(allocator, &.{ tmp_root, "repo" });
    defer allocator.free(repo_path);
    const daemon_root = try std.fs.path.join(allocator, &.{ tmp_root, "taod" });
    defer allocator.free(daemon_root);
    try std.fs.cwd().makePath(repo_path);

    const init_args = [_][]const u8{"init"};
    var out = try git.runGitAlloc(allocator, repo_path, &init_args);
    allocator.free(out);
    const commit_args = [_][]const u8{ "-c", "user.name=Tao Test", "-c", "user.email=tao-test@example.invalid", "commit", "--allow-empty", "-m", "initial" };
    out = try git.runGitAlloc(allocator, repo_path, &commit_args);
    allocator.free(out);

    var subject = struct {
        allocator: std.mem.Allocator,
        config: struct { root_dir: []const u8 },
        database: ?db.Database,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{
        .allocator = allocator,
        .config = .{ .root_dir = daemon_root },
        .database = try db.Database.openInMemory(allocator),
    };
    defer {
        if (subject.database) |*subject_database| subject_database.deinit();
    }
    try subject.database.?.insertWorkspace(.{
        .id = "workspace-1",
        .name = "repo",
        .root_path = repo_path,
        .git_common_dir = ".git",
        .workspace_slug = "repo",
        .default_branch = "HEAD",
        .order_index = 0,
    });

    const response = try handleCreateLocked(&subject, allocator, .{
        .id = "create",
        .method = "worktree.create",
        .workspace_id = "workspace-1",
        .base_branch = "HEAD",
    });
    defer allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);

    const rows = try subject.database.?.listWorktreesForWorkspace(allocator, "workspace-1");
    defer {
        for (rows) |*row| row.deinit(allocator);
        allocator.free(rows);
    }
    try std.testing.expectEqual(@as(usize, 1), rows.len);
    try std.testing.expectEqual(@as(usize, 36), rows[0].folder_name.len);
    try std.testing.expectEqual(@as(u8, '-'), rows[0].folder_name[8]);
    try std.testing.expectEqual(@as(u8, '-'), rows[0].folder_name[13]);
    try std.testing.expectEqual(@as(u8, '-'), rows[0].folder_name[18]);
    try std.testing.expectEqual(@as(u8, '-'), rows[0].folder_name[23]);
    try std.testing.expect(!std.mem.eql(u8, rows[0].folder_name, rows[0].branch));
    try std.testing.expect(worktree_name.isValidGeneratedBranchName(rows[0].branch));
    try std.testing.expectEqualStrings(rows[0].branch, rows[0].target_branch.?);
    try std.testing.expectEqualStrings(rows[0].folder_name, std.fs.path.basename(rows[0].path));
}

test "create rechecks branch reservation after unlocked git checks" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const tmp_root_rel = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{tmp.sub_path});
    defer allocator.free(tmp_root_rel);
    const tmp_root = try std.fs.cwd().realpathAlloc(allocator, tmp_root_rel);
    defer allocator.free(tmp_root);

    const repo_path = try std.fs.path.join(allocator, &.{ tmp_root, "repo" });
    defer allocator.free(repo_path);
    const daemon_root = try std.fs.path.join(allocator, &.{ tmp_root, "taod" });
    defer allocator.free(daemon_root);
    try std.fs.cwd().makePath(repo_path);

    const init_args = [_][]const u8{"init"};
    var out = try git.runGitAlloc(allocator, repo_path, &init_args);
    allocator.free(out);
    const commit_args = [_][]const u8{ "-c", "user.name=Tao Test", "-c", "user.email=tao-test@example.invalid", "commit", "--allow-empty", "-m", "initial" };
    out = try git.runGitAlloc(allocator, repo_path, &commit_args);
    allocator.free(out);

    var database = try db.Database.openInMemory(allocator);
    try database.insertWorkspace(.{
        .id = "workspace-1",
        .name = "repo",
        .root_path = repo_path,
        .git_common_dir = ".git",
        .workspace_slug = "repo",
        .default_branch = "HEAD",
        .order_index = 0,
    });

    var subject = struct {
        allocator: std.mem.Allocator,
        config: struct { root_dir: []const u8 },
        database: ?db.Database,
        inserted_conflict: bool = false,

        pub fn unlock(self: *@This()) void {
            if (self.inserted_conflict) return;
            self.inserted_conflict = true;
            self.database.?.insertWorktree(.{
                .id = "worktree-existing",
                .workspace_id = "workspace-1",
                .title = "Existing",
                .folder_name = "other-folder",
                .path = "/tmp/tao-existing-worktree",
                .branch = "feature/reused",
                .state = "creating",
                .order_index = 0,
            }) catch unreachable;
        }

        pub fn lock(_: *@This()) void {}
    }{
        .allocator = allocator,
        .config = .{ .root_dir = daemon_root },
        .database = database,
    };
    defer {
        if (subject.database) |*subject_database| subject_database.deinit();
    }

    const response = try handleCreateLocked(&subject, allocator, .{
        .id = "create",
        .method = "worktree.create",
        .workspace_id = "workspace-1",
        .folder_name = "new-folder",
        .branch = "feature/reused",
        .base_branch = "HEAD",
    });
    defer allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"error_code\":\"branch-exists\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "branch already exists in Tao worktrees") != null);
    try std.testing.expectEqual(@as(u64, 1), try subject.database.?.countWorktrees());
}

test "default remove archives external worktree without deleting git worktree" {
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

    var subject = struct {
        allocator: std.mem.Allocator,
        database: ?db.Database,

        pub fn unlock(_: *@This()) void {}
        pub fn lock(_: *@This()) void {}
    }{
        .allocator = allocator,
        .database = database,
    };
    defer {
        if (subject.database) |*subject_database| subject_database.deinit();
    }

    const response = try handleRemoveLocked(&subject, allocator, .{
        .id = "remove",
        .method = "worktree.remove",
        .worktree_id = "worktree-external",
    });
    defer allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    try std.testing.expect(pathExists(external_path));
    try std.testing.expect(!try subject.database.?.worktreePathExists(external_path));
    var archived = (try subject.database.?.findWorktreeById(allocator, "worktree-external")).?;
    defer archived.deinit(allocator);
    try std.testing.expectEqualStrings("archived", archived.state);
    try std.testing.expect(archived.archived_at != null);

    const entries = try git.worktreeListAlloc(allocator, repo_path);
    defer {
        for (entries) |*entry| entry.deinit(allocator);
        allocator.free(entries);
    }
    try std.testing.expect(findGitWorktree(allocator, entries, external_path) != null);
}
