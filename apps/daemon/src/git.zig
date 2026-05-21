const std = @import("std");

pub const max_git_output_bytes = 8 * 1024 * 1024;
const assert = std.debug.assert;

pub const GitError = error{
    GitFailed,
    GitNotFound,
    ParseFailed,
    OutOfMemory,
};

pub const StatusSummary = struct {
    changed: u32 = 0,
    staged: u32 = 0,
    untracked: u32 = 0,
};

pub const WorktreeListEntry = struct {
    path: []u8,
    head: ?[]u8 = null,
    branch: ?[]u8 = null,
    detached: bool = false,
    bare: bool = false,
    prunable: bool = false,

    pub fn deinit(self: *WorktreeListEntry, allocator: std.mem.Allocator) void {
        allocator.free(self.path);
        if (self.head) |value| allocator.free(value);
        if (self.branch) |value| allocator.free(value);
        self.* = undefined;
    }
};

const MutableWorktreeListEntry = struct {
    path: ?[]u8 = null,
    head: ?[]u8 = null,
    branch: ?[]u8 = null,
    detached: bool = false,
    bare: bool = false,
    prunable: bool = false,

    fn deinit(self: *MutableWorktreeListEntry, allocator: std.mem.Allocator) void {
        if (self.path) |value| allocator.free(value);
        if (self.head) |value| allocator.free(value);
        if (self.branch) |value| allocator.free(value);
        self.* = .{};
    }

    fn finish(self: *MutableWorktreeListEntry) ?WorktreeListEntry {
        const path = self.path orelse return null;
        assert(path.len > 0);
        const result: WorktreeListEntry = .{
            .path = path,
            .head = self.head,
            .branch = self.branch,
            .detached = self.detached,
            .bare = self.bare,
            .prunable = self.prunable,
        };
        self.* = .{};
        return result;
    }
};

pub fn runGitAlloc(allocator: std.mem.Allocator, repository_path: []const u8, args: []const []const u8) ![]u8 {
    var argv = try allocator.alloc([]const u8, args.len + 3);
    defer allocator.free(argv);
    argv[0] = "git";
    argv[1] = "-C";
    argv[2] = repository_path;
    for (args, 0..) |arg, index| argv[index + 3] = arg;

    const result = std.process.Child.run(.{
        .allocator = allocator,
        .argv = argv,
        .max_output_bytes = max_git_output_bytes,
    }) catch |err| switch (err) {
        error.FileNotFound => return error.GitNotFound,
        else => return err,
    };
    defer allocator.free(result.stderr);
    defer allocator.free(result.stdout);

    switch (result.term) {
        .Exited => |code| if (code == 0) return try allocator.dupe(u8, trimTrailingNewlines(result.stdout)),
        else => {},
    }

    return error.GitFailed;
}

pub fn runGitCheck(allocator: std.mem.Allocator, repository_path: []const u8, args: []const []const u8) !bool {
    var argv = try allocator.alloc([]const u8, args.len + 3);
    defer allocator.free(argv);
    argv[0] = "git";
    argv[1] = "-C";
    argv[2] = repository_path;
    for (args, 0..) |arg, index| argv[index + 3] = arg;

    const result = std.process.Child.run(.{
        .allocator = allocator,
        .argv = argv,
        .max_output_bytes = 64 * 1024,
    }) catch |err| switch (err) {
        error.FileNotFound => return error.GitNotFound,
        else => return err,
    };
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);

    return switch (result.term) {
        .Exited => |code| switch (code) {
            0 => true,
            1 => false,
            else => error.GitFailed,
        },
        else => error.GitFailed,
    };
}

pub fn toplevelAlloc(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const args = [_][]const u8{ "rev-parse", "--show-toplevel" };
    return runGitAlloc(allocator, path, &args);
}

pub fn commonDirAlloc(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const args = [_][]const u8{ "rev-parse", "--git-common-dir" };
    return runGitAlloc(allocator, path, &args);
}

pub fn currentBranchAlloc(allocator: std.mem.Allocator, path: []const u8) !?[]u8 {
    const symbolic_args = [_][]const u8{ "symbolic-ref", "--quiet", "--short", "HEAD" };
    if (runGitAlloc(allocator, path, &symbolic_args)) |branch| return branch else |err| switch (err) {
        error.GitFailed => {},
        else => return err,
    }

    const hash_args = [_][]const u8{ "rev-parse", "--short", "HEAD" };
    if (runGitAlloc(allocator, path, &hash_args)) |hash| return hash else |err| switch (err) {
        error.GitFailed => return null,
        else => return err,
    }
}

pub fn defaultBranchAlloc(allocator: std.mem.Allocator, path: []const u8) !?[]u8 {
    const origin_args = [_][]const u8{ "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD" };
    if (runGitAlloc(allocator, path, &origin_args)) |origin_head| {
        defer allocator.free(origin_head);
        if (std.mem.startsWith(u8, origin_head, "origin/")) {
            return try allocator.dupe(u8, origin_head["origin/".len..]);
        }
        return try allocator.dupe(u8, origin_head);
    } else |err| switch (err) {
        error.GitFailed => {},
        else => return err,
    }

    return currentBranchAlloc(allocator, path);
}

pub fn branchExists(allocator: std.mem.Allocator, repository_path: []const u8, branch: []const u8) !bool {
    const ref = try std.fmt.allocPrint(allocator, "refs/heads/{s}", .{branch});
    defer allocator.free(ref);
    const args = [_][]const u8{ "show-ref", "--verify", "--quiet", ref };
    return runGitCheck(allocator, repository_path, &args);
}

pub fn worktreeAddNewBranch(
    allocator: std.mem.Allocator,
    repository_path: []const u8,
    branch: []const u8,
    worktree_path: []const u8,
    start_point: []const u8,
) !void {
    const args = [_][]const u8{ "worktree", "add", "--no-track", "-b", branch, worktree_path, start_point };
    const out = try runGitAlloc(allocator, repository_path, &args);
    allocator.free(out);
}

pub fn worktreeRemove(
    allocator: std.mem.Allocator,
    repository_path: []const u8,
    worktree_path: []const u8,
    force: bool,
) !void {
    const args_force = [_][]const u8{ "worktree", "remove", "--force", worktree_path };
    const args_clean = [_][]const u8{ "worktree", "remove", worktree_path };
    const out = try runGitAlloc(allocator, repository_path, if (force) &args_force else &args_clean);
    allocator.free(out);
}

pub fn worktreeListAlloc(allocator: std.mem.Allocator, repository_path: []const u8) ![]WorktreeListEntry {
    const args = [_][]const u8{ "worktree", "list", "--porcelain", "-z" };
    const output = try runGitAlloc(allocator, repository_path, &args);
    defer allocator.free(output);
    return parseWorktreeListPorcelainZ(allocator, output);
}

pub fn statusSummaryAlloc(allocator: std.mem.Allocator, path: []const u8) !StatusSummary {
    const args = [_][]const u8{ "status", "--porcelain=v1", "--untracked-files=normal" };
    const output = try runGitAlloc(allocator, path, &args);
    defer allocator.free(output);
    return parseStatus(output);
}

pub fn isDirty(allocator: std.mem.Allocator, path: []const u8) !bool {
    const status = try statusSummaryAlloc(allocator, path);
    return status.changed > 0 or status.staged > 0 or status.untracked > 0;
}

pub fn parseStatus(output: []const u8) StatusSummary {
    var summary: StatusSummary = .{};
    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        if (line.len < 2) continue;
        const index_status = line[0];
        const working_tree_status = line[1];
        if (index_status == '?' and working_tree_status == '?') {
            summary.untracked += 1;
            continue;
        }
        if (index_status != ' ' and index_status != '?') summary.staged += 1;
        if (working_tree_status != ' ') summary.changed += 1;
    }
    return summary;
}

pub fn parseWorktreeListPorcelainZ(allocator: std.mem.Allocator, output: []const u8) ![]WorktreeListEntry {
    var entries: std.ArrayList(WorktreeListEntry) = .empty;
    errdefer {
        for (entries.items) |*entry| entry.deinit(allocator);
        entries.deinit(allocator);
    }

    var current: MutableWorktreeListEntry = .{};
    errdefer current.deinit(allocator);

    var fields = std.mem.splitScalar(u8, output, 0);
    while (fields.next()) |field| {
        if (field.len == 0) continue;

        if (std.mem.startsWith(u8, field, "worktree ")) {
            if (current.finish()) |entry_value| {
                var entry = entry_value;
                errdefer entry.deinit(allocator);
                try entries.append(allocator, entry);
            }
            current.path = try allocator.dupe(u8, field["worktree ".len..]);
            assert(current.path.?.len > 0);
            continue;
        }
        if (current.path == null) continue;

        if (std.mem.startsWith(u8, field, "HEAD ")) {
            if (current.head) |old| allocator.free(old);
            current.head = try allocator.dupe(u8, field["HEAD ".len..]);
            continue;
        }
        if (std.mem.startsWith(u8, field, "branch ")) {
            if (current.branch) |old| allocator.free(old);
            const raw = field["branch ".len..];
            const branch = if (std.mem.startsWith(u8, raw, "refs/heads/")) raw["refs/heads/".len..] else raw;
            current.branch = try allocator.dupe(u8, branch);
            continue;
        }
        if (std.mem.eql(u8, field, "detached")) current.detached = true;
        if (std.mem.eql(u8, field, "bare")) current.bare = true;
        if (std.mem.startsWith(u8, field, "prunable")) current.prunable = true;
    }

    if (current.finish()) |entry_value| {
        var entry = entry_value;
        errdefer entry.deinit(allocator);
        try entries.append(allocator, entry);
    }
    const owned = try entries.toOwnedSlice(allocator);
    for (owned) |entry| assert(entry.path.len > 0);
    return owned;
}

fn trimTrailingNewlines(value: []const u8) []const u8 {
    var end = value.len;
    while (end > 0 and (value[end - 1] == '\n' or value[end - 1] == '\r')) end -= 1;
    return value[0..end];
}

test "parses git status porcelain" {
    const summary = parseStatus(
        \\ M changed.txt
        \\A  staged.txt
        \\?? new.txt
        \\
    );
    try std.testing.expectEqual(@as(u32, 1), summary.changed);
    try std.testing.expectEqual(@as(u32, 1), summary.staged);
    try std.testing.expectEqual(@as(u32, 1), summary.untracked);
}

test "parses worktree porcelain z output" {
    const sample = "worktree /repo\x00HEAD abc123\x00branch refs/heads/main\x00\x00worktree /tmp/wt\x00HEAD def456\x00branch refs/heads/luminous-galileo-a13f\x00\x00";
    const entries = try parseWorktreeListPorcelainZ(std.testing.allocator, sample);
    defer {
        for (entries) |*entry| entry.deinit(std.testing.allocator);
        std.testing.allocator.free(entries);
    }
    try std.testing.expectEqual(@as(usize, 2), entries.len);
    try std.testing.expectEqualStrings("/repo", entries[0].path);
    try std.testing.expectEqualStrings("main", entries[0].branch.?);
    try std.testing.expectEqualStrings("/tmp/wt", entries[1].path);
    try std.testing.expectEqualStrings("luminous-galileo-a13f", entries[1].branch.?);
}

fn parseWorktreeListPorcelainZForAllocationFailure(allocator: std.mem.Allocator) !void {
    const sample = "worktree /repo\x00HEAD abc123\x00branch refs/heads/main\x00\x00worktree /tmp/wt\x00HEAD def456\x00branch refs/heads/luminous-galileo-a13f\x00detached\x00\x00";
    const entries = try parseWorktreeListPorcelainZ(allocator, sample);
    defer {
        for (entries) |*entry| entry.deinit(allocator);
        allocator.free(entries);
    }
    try std.testing.expectEqual(@as(usize, 2), entries.len);
    try std.testing.expectEqualStrings("/repo", entries[0].path);
    try std.testing.expectEqualStrings("luminous-galileo-a13f", entries[1].branch.?);
    try std.testing.expect(entries[1].detached);
}

test "worktree porcelain parser cleans up on OOM" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        parseWorktreeListPorcelainZForAllocationFailure,
        .{},
    );
}
