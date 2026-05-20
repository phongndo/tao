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

    const base_branch_owned = try resolveBaseBranchAlloc(self.allocator, workspace_row.root_path, workspace_row.default_branch, request.requestBaseBranch());
    defer self.allocator.free(base_branch_owned);
    const target_branch = request.requestTargetBranch() orelse base_branch_owned;
    const start_point = request.requestStartPoint() orelse base_branch_owned;

    var folder_name: []u8 = undefined;
    var branch_name: []u8 = undefined;
    var generated_folder = false;
    var generated_branch = false;
    defer if (generated_folder) self.allocator.free(folder_name);
    defer if (generated_branch) self.allocator.free(branch_name);

    if (request.requestFolderName()) |manual_folder| {
        if (!worktree_name.isValidFolderName(manual_folder)) return errorResponse(allocator, request, .invalid_name, "invalid folder_name");
        folder_name = @constCast(manual_folder);
    } else {
        folder_name = try generateAvailableFolderAlloc(self.allocator, database, &workspace_row, self.config.root_dir);
        generated_folder = true;
    }

    if (request.branch) |manual_branch| {
        if (!worktree_name.isSafeBranchName(manual_branch)) return errorResponse(allocator, request, .invalid_name, "invalid branch");
        branch_name = @constCast(manual_branch);
    } else {
        branch_name = try worktree_name.branchForFolderAlloc(self.allocator, folder_name);
        generated_branch = true;
    }

    if (try database.worktreeFolderExists(workspace_row.id, folder_name)) return errorResponse(allocator, request, .invalid_name, "folder_name already exists");
    if (try database.worktreeBranchExists(workspace_row.id, branch_name)) return errorResponse(allocator, request, .branch_exists, "branch already exists in Tao worktrees");
    const branch_in_git = git.branchExists(self.allocator, workspace_row.root_path, branch_name) catch |err| switch (err) {
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
    if (pathExists(worktree_path) or try database.worktreePathExists(worktree_path)) return errorResponse(allocator, request, .invalid_path, "worktree path already exists");

    const worktree_id = try workspace.idAlloc(self.allocator, "worktree");
    defer self.allocator.free(worktree_id);
    const order_index = try database.nextWorktreeOrder(workspace_row.id);

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

    std.fs.cwd().makePath(parent_path) catch |err| {
        try database.updateWorktreeState(worktree_id, "error", @errorName(err));
        return errorResponse(allocator, request, .invalid_path, "failed to create worktree parent directory");
    };

    const prune_args = [_][]const u8{ "worktree", "prune" };
    if (git.runGitAlloc(self.allocator, workspace_row.root_path, &prune_args)) |out| self.allocator.free(out) else |_| {}

    git.worktreeAddNewBranch(self.allocator, workspace_row.root_path, branch_name, worktree_path, start_point) catch |err| {
        safeDeletePartialWorktree(self.allocator, self.config.root_dir, worktree_path);
        try database.updateWorktreeState(worktree_id, "error", @errorName(err));
        return errorResponse(allocator, request, .git_failed, "git worktree add failed");
    };

    try database.updateWorktreeState(worktree_id, "active", null);
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
        else => return err,
    };
    return handleListLocked(self, allocator, request);
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

    const entries = git.worktreeListAlloc(self.allocator, workspace_row.root_path) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "git worktree list failed"),
        else => return err,
    };
    defer {
        for (entries) |*entry| entry.deinit(self.allocator);
        self.allocator.free(entries);
    }
    const git_entry = findGitWorktree(self.allocator, entries, row.path);
    if (!pathExists(row.path) or git_entry == null or (git_entry != null and git_entry.?.prunable)) {
        pruneGitWorktrees(self.allocator, workspace_row.root_path);
        try database.archiveWorktree(row.id);
        return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
    }

    if (!request.requestForce()) {
        const dirty = git.isDirty(self.allocator, row.path) catch |err| switch (err) {
            error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "failed to determine worktree status"),
            else => return err,
        };
        if (dirty) return errorResponse(allocator, request, .worktree_dirty, "worktree has uncommitted changes");
    }

    try database.updateWorktreeState(row.id, "removing", null);
    git.worktreeRemove(self.allocator, workspace_row.root_path, row.path, request.requestForce()) catch |err| {
        if (!pathExists(row.path)) {
            pruneGitWorktrees(self.allocator, workspace_row.root_path);
            try database.archiveWorktree(row.id);
            return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
        }
        try database.updateWorktreeState(row.id, "error", @errorName(err));
        return errorResponse(allocator, request, .git_failed, "git worktree remove failed");
    };
    try database.archiveWorktree(row.id);

    if (request.requestDeleteBranch()) {
        const delete_args = [_][]const u8{ "branch", "-D", row.branch };
        if (git.runGitAlloc(self.allocator, workspace_row.root_path, &delete_args)) |out| self.allocator.free(out) else |err| {
            std.log.warn("branch deletion failed for {s}: {t}", .{ row.branch, err });
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

    const canonical = workspace.canonicalPathAlloc(self.allocator, path) catch return errorResponse(allocator, request, .invalid_path, "invalid worktree path");
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

    const entries = git.worktreeListAlloc(self.allocator, workspace_row.root_path) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => return errorResponse(allocator, request, .git_failed, "git worktree list failed"),
        else => return err,
    };
    defer {
        for (entries) |*entry| entry.deinit(self.allocator);
        self.allocator.free(entries);
    }
    const entry = findGitWorktree(self.allocator, entries, canonical) orelse return errorResponse(allocator, request, .invalid_path, "path is not a Git worktree for this workspace");
    if (entry.prunable) {
        pruneGitWorktrees(self.allocator, workspace_row.root_path);
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
    try database.reorderWorktree(worktree_id, order_index);
    return rpc.responseJsonAlloc(allocator, .{ .id = request.requestId(), .ok = true });
}

fn refreshSingleWorktree(self: anytype, database: *db.Database, worktree_id: []const u8) !void {
    var row = (try database.findWorktreeById(self.allocator, worktree_id)) orelse return error.InvalidWorktree;
    defer row.deinit(self.allocator);
    try refreshWorkspaceWorktrees(self, database, row.workspace_id);
}

fn refreshWorkspaceWorktrees(self: anytype, database: *db.Database, workspace_id: []const u8) !void {
    var workspace_row = (try database.findWorkspaceById(self.allocator, workspace_id)) orelse return error.InvalidWorkspace;
    defer workspace_row.deinit(self.allocator);
    const entries = git.worktreeListAlloc(self.allocator, workspace_row.root_path) catch |err| switch (err) {
        error.GitFailed, error.GitNotFound => {
            std.log.warn("git worktree list failed for {s}: {t}", .{ workspace_row.root_path, err });
            return;
        },
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
        if (findGitWorktree(self.allocator, entries, row.path)) |entry| {
            if (entry.prunable or !pathExists(row.path)) {
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
            try database.updateWorktreeState(row.id, "missing", null);
        }
    }
}

fn generateAvailableFolderAlloc(allocator: std.mem.Allocator, database: *db.Database, workspace_row: *const db.WorkspaceRow, root_dir: []const u8) ![]u8 {
    var suffix_len: usize = 4;
    var attempts: usize = 0;
    while (attempts < 64) : (attempts += 1) {
        if (attempts == 16) suffix_len = 6;
        if (attempts == 32) suffix_len = 8;
        const folder = try worktree_name.generatedFolderNameAlloc(allocator, suffix_len);
        var keep_folder = false;
        defer if (!keep_folder) allocator.free(folder);
        const branch = try worktree_name.branchForFolderAlloc(allocator, folder);
        defer allocator.free(branch);
        const parent = try worktreeParentPathAlloc(allocator, root_dir, workspace_row.workspace_slug);
        defer allocator.free(parent);
        const candidate_path = try std.fs.path.join(allocator, &.{ parent, folder });
        defer allocator.free(candidate_path);
        if (pathExists(candidate_path)) continue;
        if (try database.worktreeFolderExists(workspace_row.id, folder)) continue;
        if (try database.worktreeBranchExists(workspace_row.id, branch)) continue;
        if (git.branchExists(allocator, workspace_row.root_path, branch) catch false) continue;
        keep_folder = true;
        return folder;
    }
    return error.TooManyCollisions;
}

fn resolveBaseBranchAlloc(allocator: std.mem.Allocator, root_path: []const u8, default_branch: ?[]const u8, requested: ?[]const u8) ![]u8 {
    if (requested) |value| return allocator.dupe(u8, value);
    if (default_branch) |value| return allocator.dupe(u8, value);
    if (try git.currentBranchAlloc(allocator, root_path)) |value| return value;
    return error.InvalidWorkspace;
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

fn pathExists(path: []const u8) bool {
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
}

fn safeDeletePartialWorktree(allocator: std.mem.Allocator, root_dir: []const u8, worktree_path: []const u8) void {
    const worktree_root = std.fs.path.join(allocator, &.{ root_dir, "worktrees" }) catch return;
    defer allocator.free(worktree_root);
    if (!isPathUnder(worktree_root, worktree_path)) return;
    std.fs.cwd().deleteTree(worktree_path) catch |err| {
        std.log.warn("failed to remove partial worktree {s}: {t}", .{ worktree_path, err });
    };
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

test "worktree path containment requires separator" {
    try std.testing.expect(isPathUnder("/tmp/root", "/tmp/root/child"));
    try std.testing.expect(!isPathUnder("/tmp/root", "/tmp/root-other/child"));
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
