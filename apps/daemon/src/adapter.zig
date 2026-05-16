const std = @import("std");

pub const Provider = enum {
    pi,
    codex,
    claude,
    unknown,

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

test "agent provider detection uses argv executable name" {
    try std.testing.expectEqual(Provider.pi, Provider.detectArgv(&.{"/usr/local/bin/pi"}));
    try std.testing.expectEqual(Provider.unknown, Provider.detectArgv(&.{"bash"}));
}
