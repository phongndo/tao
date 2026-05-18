const std = @import("std");

const adjectives = [_][]const u8{
    "axiomatic",
    "algebraic",
    "algorithmic",
    "binary",
    "boolean",
    "celestial",
    "categorical",
    "classical",
    "computable",
    "cosmic",
    "curious",
    "differential",
    "discrete",
    "elliptic",
    "elegant",
    "empirical",
    "functional",
    "geometric",
    "harmonic",
    "heliocentric",
    "lambda",
    "lexical",
    "logical",
    "luminous",
    "lunar",
    "modular",
    "orbital",
    "parabolic",
    "prime",
    "quantum",
    "radial",
    "recursive",
    "rigorous",
    "solar",
    "stellar",
    "synthetic",
    "theorematic",
    "topological",
    "vectorial",
};

const names = [_][]const u8{
    "ada",
    "alpha",
    "algorithm",
    "automata",
    "archimedes",
    "aristotle",
    "axiom",
    "beta",
    "cache",
    "calculus",
    "compiler",
    "copernicus",
    "corollary",
    "curie",
    "daemon",
    "delta",
    "derivative",
    "eigenvalue",
    "epsilon",
    "euclid",
    "faraday",
    "feynman",
    "fiber",
    "galileo",
    "gamma",
    "gauss",
    "gradient",
    "graph",
    "hash",
    "hypatia",
    "integral",
    "iota",
    "kernel",
    "kepler",
    "kappa",
    "lambda",
    "lemma",
    "lovelace",
    "manifold",
    "matrix",
    "maxwell",
    "monad",
    "newton",
    "noether",
    "omega",
    "parser",
    "phi",
    "plato",
    "protocol",
    "psi",
    "queue",
    "riemann",
    "sigma",
    "syntax",
    "tensor",
    "theta",
    "tesla",
    "theorem",
    "turing",
    "vector",
    "zeta",
};

var counter = std.atomic.Value(u64).init(0);

pub fn generatedFolderNameAlloc(allocator: std.mem.Allocator, suffix_hex_len: usize) ![]u8 {
    const suffix_len = @max(@as(usize, 4), suffix_hex_len);
    var random_seed: u64 = undefined;
    std.crypto.random.bytes(std.mem.asBytes(&random_seed));
    random_seed ^= counter.fetchAdd(1, .monotonic) + 1;

    var prng = std.Random.DefaultPrng.init(random_seed);
    const random = prng.random();

    const adjective = adjectives[random.uintLessThan(usize, adjectives.len)];
    const name = names[random.uintLessThan(usize, names.len)];
    const suffix = try allocator.alloc(u8, suffix_len);
    defer allocator.free(suffix);
    for (suffix) |*ch| {
        ch.* = "0123456789abcdef"[random.uintLessThan(usize, 16)];
    }

    return std.fmt.allocPrint(allocator, "{s}-{s}-{s}", .{ adjective, name, suffix });
}

pub fn branchForFolderAlloc(allocator: std.mem.Allocator, folder_name: []const u8) ![]u8 {
    if (!isValidFolderName(folder_name)) return error.InvalidName;
    return allocator.dupe(u8, folder_name);
}

pub fn isValidFolderName(value: []const u8) bool {
    if (value.len == 0 or value.len > 96) return false;
    if (value[0] == '-' or value[value.len - 1] == '-') return false;
    var previous_dash = false;
    for (value) |ch| {
        const ok = (ch >= 'a' and ch <= 'z') or (ch >= '0' and ch <= '9') or ch == '-';
        if (!ok) return false;
        if (ch == '-' and previous_dash) return false;
        previous_dash = ch == '-';
    }
    return true;
}

pub fn isValidGeneratedBranchName(value: []const u8) bool {
    return isValidFolderName(value);
}

/// Conservative local-branch allowlist for user-supplied first-slice branches.
/// It intentionally rejects ref traversal, whitespace, and special ref syntax.
pub fn isSafeBranchName(value: []const u8) bool {
    if (value.len == 0 or value.len > 200) return false;
    if (value[0] == '/' or value[value.len - 1] == '/' or value[value.len - 1] == '.') return false;
    if (std.mem.indexOf(u8, value, "..") != null) return false;
    if (std.mem.indexOf(u8, value, "//") != null) return false;
    if (std.mem.startsWith(u8, value, "-") or std.mem.endsWith(u8, value, ".lock")) return false;

    for (value) |ch| {
        const ok = (ch >= 'a' and ch <= 'z') or
            (ch >= 'A' and ch <= 'Z') or
            (ch >= '0' and ch <= '9') or
            ch == '/' or ch == '-' or ch == '_' or ch == '.';
        if (!ok) return false;
    }

    return true;
}

pub fn workspaceSlugAlloc(allocator: std.mem.Allocator, name_or_path: []const u8) ![]u8 {
    const basename = std.fs.path.basename(name_or_path);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    var previous_dash = false;
    for (basename) |raw| {
        const ch = std.ascii.toLower(raw);
        const mapped: ?u8 = if (ch >= 'a' and ch <= 'z') ch else if (ch >= '0' and ch <= '9') ch else '-';
        if (mapped) |value| {
            if (value == '-') {
                if (previous_dash or out.items.len == 0) continue;
                previous_dash = true;
            } else {
                previous_dash = false;
            }
            if (out.items.len >= 64) break;
            try out.append(allocator, value);
        }
    }
    while (out.items.len > 0 and out.items[out.items.len - 1] == '-') _ = out.pop();
    if (out.items.len == 0) try out.appendSlice(allocator, "workspace");
    return out.toOwnedSlice(allocator);
}

test "generated folder names are branch safe" {
    const folder = try generatedFolderNameAlloc(std.testing.allocator, 4);
    defer std.testing.allocator.free(folder);
    try std.testing.expect(isValidFolderName(folder));
    const branch = try branchForFolderAlloc(std.testing.allocator, folder);
    defer std.testing.allocator.free(branch);
    try std.testing.expect(isValidGeneratedBranchName(branch));
}

test "folder and branch validators reject unsafe names" {
    try std.testing.expect(isValidFolderName("luminous-galileo-a13f"));
    try std.testing.expect(!isValidFolderName("../escape"));
    try std.testing.expect(!isValidFolderName("Tao-Name"));
    try std.testing.expect(!isValidFolderName("double--dash"));
    try std.testing.expect(isSafeBranchName("fix-login-redirect-loop"));
    try std.testing.expect(!isSafeBranchName("../main"));
    try std.testing.expect(!isSafeBranchName("bad branch"));
    try std.testing.expect(!isSafeBranchName("topic.lock"));
}

test "workspace slug is lowercase and path safe" {
    const slug = try workspaceSlugAlloc(std.testing.allocator, "/Users/me/Project Tao!");
    defer std.testing.allocator.free(slug);
    try std.testing.expectEqualStrings("project-tao", slug);
}
