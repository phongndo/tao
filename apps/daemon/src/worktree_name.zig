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

pub fn generatedFolderNameAlloc(allocator: std.mem.Allocator) ![]u8 {
    var bytes: [16]u8 = undefined;
    std.crypto.random.bytes(&bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = "0123456789abcdef";
    var out = try allocator.alloc(u8, 36);
    var out_index: usize = 0;
    for (bytes, 0..) |byte, byte_index| {
        if (byte_index == 4 or byte_index == 6 or byte_index == 8 or byte_index == 10) {
            out[out_index] = '-';
            out_index += 1;
        }
        out[out_index] = hex[byte >> 4];
        out[out_index + 1] = hex[byte & 0x0f];
        out_index += 2;
    }
    return out;
}

pub fn generatedBranchNameAlloc(allocator: std.mem.Allocator) ![]u8 {
    var random_seed: u64 = undefined;
    std.crypto.random.bytes(std.mem.asBytes(&random_seed));
    random_seed ^= counter.fetchAdd(1, .monotonic) + 1;

    var prng = std.Random.DefaultPrng.init(random_seed);
    const random = prng.random();

    const adjective = adjectives[random.uintLessThan(usize, adjectives.len)];
    const name = names[random.uintLessThan(usize, names.len)];

    return std.fmt.allocPrint(allocator, "{s}-{s}", .{ adjective, name });
}

pub fn branchForFolderAlloc(allocator: std.mem.Allocator, folder_name: []const u8) ![]u8 {
    if (!isValidFolderName(folder_name)) return error.InvalidName;
    return allocator.dupe(u8, folder_name);
}

pub fn detachedBranchForFolderAlloc(allocator: std.mem.Allocator, folder_name: []const u8) ![]u8 {
    if (!isValidFolderName(folder_name)) return error.InvalidName;
    return std.fmt.allocPrint(allocator, "detached-{s}", .{folder_name});
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

    var component_start: usize = 0;
    for (value, 0..) |ch, index| {
        const ok = (ch >= 'a' and ch <= 'z') or
            (ch >= 'A' and ch <= 'Z') or
            (ch >= '0' and ch <= '9') or
            ch == '/' or ch == '-' or ch == '_' or ch == '.';
        if (!ok) return false;
        if (index == component_start and ch == '.') return false;
        if (ch == '/') {
            const component = value[component_start..index];
            if (std.mem.endsWith(u8, component, ".lock")) return false;
            component_start = index + 1;
        }
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

test "generated folder and branch names are valid" {
    const folder = try generatedFolderNameAlloc(std.testing.allocator);
    defer std.testing.allocator.free(folder);
    try std.testing.expect(isValidFolderName(folder));

    try std.testing.expectEqual(@as(usize, 36), folder.len);
    try std.testing.expectEqual(@as(u8, '-'), folder[8]);
    try std.testing.expectEqual(@as(u8, '-'), folder[13]);
    try std.testing.expectEqual(@as(u8, '-'), folder[18]);
    try std.testing.expectEqual(@as(u8, '-'), folder[23]);
    try std.testing.expectEqual(@as(u8, '4'), folder[14]);

    const branch = try generatedBranchNameAlloc(std.testing.allocator);
    defer std.testing.allocator.free(branch);
    try std.testing.expect(isValidGeneratedBranchName(branch));
    var dash_count: usize = 0;
    for (branch) |ch| {
        if (ch == '-') dash_count += 1;
    }
    try std.testing.expectEqual(@as(usize, 1), dash_count);
    const detached_branch = try detachedBranchForFolderAlloc(std.testing.allocator, folder);
    defer std.testing.allocator.free(detached_branch);
    try std.testing.expect(isSafeBranchName(detached_branch));
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
    try std.testing.expect(!isSafeBranchName(".hidden/topic"));
    try std.testing.expect(!isSafeBranchName("foo.lock/bar"));
    try std.testing.expect(!isSafeBranchName("topic/.dot"));
}

test "workspace slug is lowercase and path safe" {
    const slug = try workspaceSlugAlloc(std.testing.allocator, "/Users/me/Project Tao!");
    defer std.testing.allocator.free(slug);
    try std.testing.expectEqualStrings("project-tao", slug);
}
