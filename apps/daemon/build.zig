const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const options = b.addOptions();
    options.addOption([]const u8, "vt_backend", "ghostty_native");

    const zig_sqlite = b.dependency("sqlite", .{
        .target = target,
        .optimize = optimize,
        .fts5 = true,
    });
    const sqlite_module = zig_sqlite.module("sqlite");

    const ghostty = b.dependency("ghostty", .{
        .target = target,
        .optimize = optimize,

        // Keep the daemon build self-contained and avoid linking Ghostty's
        // vendored SIMD C++ objects into taod. This still uses the upstream
        // libghostty-vt parser/state machine; only the SIMD fast paths are off.
        .simd = false,
    });
    const ghostty_vt_module = ghostty.module("ghostty-vt");

    const mod = b.addModule("taod", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addOptions("build_options", options);
    mod.addImport("sqlite", sqlite_module);
    mod.addImport("ghostty-vt", ghostty_vt_module);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{.{ .name = "taod", .module = mod }},
    });
    exe_mod.addOptions("build_options", options);
    if (target.result.os.tag == .linux) exe_mod.linkSystemLibrary("util", .{});

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
    const mod_tests = b.addTest(.{ .root_module = mod });

    const exe_tests = b.addTest(.{ .root_module = exe.root_module });
    const test_step = b.step("test", "Run unit tests");
    const mod_test_run = b.addRunArtifact(mod_tests);
    const exe_test_run = b.addRunArtifact(exe_tests);

    const workspace_node_bin = b.pathFromRoot("../../node_modules/.bin");
    mod_test_run.addPathDir(workspace_node_bin);
    exe_test_run.addPathDir(workspace_node_bin);

    test_step.dependOn(&mod_test_run.step);
    test_step.dependOn(&exe_test_run.step);
}
