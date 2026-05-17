const std = @import("std");
const builtin = @import("builtin");

const required_zig_version = std.SemanticVersion{ .major = 0, .minor = 15, .patch = 2 };

comptime {
    if (builtin.zig_version.order(required_zig_version) != .eq) {
        @compileError(std.fmt.comptimePrint(
            "unsupported zig version: expected {}, found {}",
            .{ required_zig_version, builtin.zig_version },
        ));
    }
}

pub fn build(b: *std.Build) void {
    // Keep build diagnostics useful in CI without affecting the emitted daemon.
    b.reference_trace = 10;

    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const sanitize_thread = b.option(bool, "sanitize-thread", "Build taod tests with ThreadSanitizer") orelse false;
    const fuzz = b.option(bool, "fuzz", "Build taod tests with Zig fuzz instrumentation") orelse false;

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
        .sanitize_thread = sanitize_thread,
        .fuzz = fuzz,
    });
    mod.addOptions("build_options", options);
    mod.addImport("sqlite", sqlite_module);
    mod.addImport("ghostty-vt", ghostty_vt_module);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .sanitize_thread = sanitize_thread,
        .fuzz = fuzz,
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

    const fmt_check = b.addFmt(.{
        .paths = &.{ "build.zig", "build.zig.zon", "src" },
        .check = true,
    });
    const fmt_step = b.step("test:fmt", "Check Zig formatting");
    fmt_step.dependOn(&fmt_check.step);

    const fuzz_step = b.step("test:fuzz", "Run deterministic parser fault tests with fuzz instrumentation; pass -Dfuzz=true");
    fuzz_step.dependOn(&mod_test_run.step);

    const sanitizer_step = b.step("test:sanitize-thread", "Run tests with ThreadSanitizer; pass -Dsanitize-thread=true");
    sanitizer_step.dependOn(&mod_test_run.step);

    const check_step = b.step("check", "Compile and format-check taod without running tests");
    check_step.dependOn(&exe.step);
    check_step.dependOn(&mod_tests.step);
    check_step.dependOn(&exe_tests.step);
    check_step.dependOn(&fmt_check.step);
}
