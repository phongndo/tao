const std = @import("std");

const VtBackend = enum {
    /// Build with Tao's small fallback VT state. This keeps CI/builds working
    /// while upstream libghostty-vt's Zig package catches up to Tao's Zig
    /// toolchain.
    fallback,

    /// Link against a system-installed libghostty-vt C ABI. Use with:
    /// `zig build -Dvt-backend=libghostty_c`.
    libghostty_c,
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const vt_backend = b.option(
        VtBackend,
        "vt-backend",
        "VT backend to compile into taod: fallback or libghostty_c",
    ) orelse .fallback;

    const options = b.addOptions();
    options.addOption([]const u8, "vt_backend", @tagName(vt_backend));
    options.addOption(bool, "libghostty_vt_c", vt_backend == .libghostty_c);

    const mod = b.addModule("taod", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addOptions("build_options", options);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{.{ .name = "taod", .module = mod }},
    });
    exe_mod.addOptions("build_options", options);
    if (target.result.os.tag == .linux) exe_mod.linkSystemLibrary("util", .{});
    exe_mod.linkSystemLibrary("sqlite3", .{});
    if (vt_backend == .libghostty_c) exe_mod.linkSystemLibrary("ghostty-vt", .{});

    const exe = b.addExecutable(.{
        .name = "taod",
        .root_module = exe_mod,
    });

    b.installArtifact(exe);

    const run_step = b.step("run", "Run taod");
    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);
    run_step.dependOn(&run_cmd.step);

    if (target.result.os.tag == .linux) mod.linkSystemLibrary("util", .{});
    mod.linkSystemLibrary("sqlite3", .{});
    if (vt_backend == .libghostty_c) mod.linkSystemLibrary("ghostty-vt", .{});
    const mod_tests = b.addTest(.{ .root_module = mod });

    const exe_tests = b.addTest(.{ .root_module = exe.root_module });
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&b.addRunArtifact(mod_tests).step);
    test_step.dependOn(&b.addRunArtifact(exe_tests).step);
}
