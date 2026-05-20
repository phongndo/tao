const std = @import("std");

const assert = std.debug.assert;

pub const PtyError = error{
    InvalidSize,
    EmptyArgv,
    SpawnFailed,
    ResizeFailed,
    WriteFailed,
    ReadFailed,
    WaitFailed,
    KillFailed,
    OutOfMemory,
};

extern "c" fn forkpty(
    amaster: *std.c.fd_t,
    name: ?[*]u8,
    termp: ?*const std.c.termios,
    winp: ?*const std.c.winsize,
) std.c.pid_t;

extern "c" fn execvp(file: [*:0]const u8, argv: [*:null]const ?[*:0]const u8) c_int;
extern "c" fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;

pub const EnvPair = struct {
    name: []const u8,
    value: []const u8,
};

pub const Child = struct {
    pid: std.c.pid_t,
    master_fd: std.c.fd_t,
    cols: u16,
    rows: u16,

    pub fn assertInvariants(self: *const Child) void {
        assert(self.cols > 0);
        assert(self.rows > 0);
        assert(self.pid >= 0);
        assert(self.master_fd >= -1);
    }

    pub fn close(self: *Child) void {
        self.assertInvariants();
        if (self.master_fd >= 0) {
            _ = std.c.close(self.master_fd);
            self.master_fd = -1;
        }
        self.assertInvariants();
    }
};

pub const ExitStatus = struct {
    exit_code: i32,
    signal: i32,
};

pub const SpawnOptions = struct {
    argv: []const []const u8,
    env: []const EnvPair = &.{},
    cwd: ?[]const u8 = null,
    cols: u16,
    rows: u16,
};

pub const Driver = struct {
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) Driver {
        return .{ .allocator = allocator };
    }

    /// Spawn `argv` under a real POSIX pseudoterminal. `forkpty` creates the
    /// master/slave pair, starts a session, wires stdio to the slave, and applies
    /// the initial window size before the child execs.
    pub fn spawn(self: *Driver, options: SpawnOptions) PtyError!Child {
        try validateSize(options.cols, options.rows);
        if (options.argv.len == 0) return error.EmptyArgv;

        var argv_storage = try self.allocator.alloc([:0]u8, options.argv.len);
        var argv_count: usize = 0;
        defer {
            for (argv_storage[0..argv_count]) |arg| self.allocator.free(arg);
            self.allocator.free(argv_storage);
        }

        var argv_c = try self.allocator.alloc(?[*:0]const u8, options.argv.len + 1);
        defer self.allocator.free(argv_c);

        var env_name_storage = try self.allocator.alloc([:0]u8, options.env.len);
        var env_name_count: usize = 0;
        defer {
            for (env_name_storage[0..env_name_count]) |name| self.allocator.free(name);
            self.allocator.free(env_name_storage);
        }
        var env_value_storage = try self.allocator.alloc([:0]u8, options.env.len);
        var env_value_count: usize = 0;
        defer {
            for (env_value_storage[0..env_value_count]) |value| self.allocator.free(value);
            self.allocator.free(env_value_storage);
        }

        for (options.argv, 0..) |arg, index| {
            if (arg.len == 0) return error.EmptyArgv;
            argv_storage[index] = try self.allocator.dupeZ(u8, arg);
            argv_count += 1;
            argv_c[index] = argv_storage[index].ptr;
        }
        argv_c[options.argv.len] = null;

        for (options.env, 0..) |pair, index| {
            if (pair.name.len == 0) return error.SpawnFailed;
            env_name_storage[index] = try self.allocator.dupeZ(u8, pair.name);
            env_name_count += 1;
            env_value_storage[index] = try self.allocator.dupeZ(u8, pair.value);
            env_value_count += 1;
        }

        const cwd_z = if (options.cwd) |cwd| try self.allocator.dupeZ(u8, cwd) else null;
        defer if (cwd_z) |cwd| self.allocator.free(cwd);

        var master_fd: std.c.fd_t = -1;
        var winsize: std.c.winsize = .{
            .row = options.rows,
            .col = options.cols,
            .xpixel = 0,
            .ypixel = 0,
        };

        const pid = forkpty(&master_fd, null, null, &winsize);
        if (pid < 0) return error.SpawnFailed;

        if (pid == 0) {
            if (cwd_z) |cwd| {
                if (std.c.chdir(cwd.ptr) != 0) std.c._exit(125);
            }
            for (env_name_storage[0..env_name_count], env_value_storage[0..env_value_count]) |name, value| {
                if (setenv(name.ptr, value.ptr, 1) != 0) std.c._exit(126);
            }
            _ = execvp(argv_c[0].?, @ptrCast(argv_c.ptr));
            std.c._exit(127);
        }

        const child: Child = .{
            .pid = pid,
            .master_fd = master_fd,
            .cols = options.cols,
            .rows = options.rows,
        };
        child.assertInvariants();
        return child;
    }

    pub fn resize(_: *Driver, child: *Child, cols: u16, rows: u16) PtyError!void {
        child.assertInvariants();
        try validateSize(cols, rows);
        if (child.master_fd < 0) return error.ResizeFailed;

        var winsize: std.c.winsize = .{
            .row = rows,
            .col = cols,
            .xpixel = 0,
            .ypixel = 0,
        };
        if (std.c.ioctl(child.master_fd, tiocswinszRequest(), &winsize) != 0) return error.ResizeFailed;

        child.cols = cols;
        child.rows = rows;
        child.assertInvariants();
    }

    pub fn writeAll(_: *Driver, child: *Child, data: []const u8) PtyError!void {
        child.assertInvariants();
        if (child.master_fd < 0) return error.WriteFailed;

        var offset: usize = 0;
        while (offset < data.len) {
            const written = std.c.write(child.master_fd, data[offset..].ptr, data.len - offset);
            if (written < 0) {
                switch (std.posix.errno(written)) {
                    .INTR => continue,
                    else => return error.WriteFailed,
                }
            }
            if (written == 0) return error.WriteFailed;
            offset += @intCast(written);
        }
    }

    pub fn read(_: *Driver, child: *Child, buffer: []u8) PtyError!usize {
        child.assertInvariants();
        if (child.master_fd < 0) return error.ReadFailed;
        if (buffer.len == 0) return 0;

        while (true) {
            const amount = std.c.read(child.master_fd, buffer.ptr, buffer.len);
            if (amount < 0) {
                switch (std.posix.errno(amount)) {
                    .INTR => continue,
                    else => return error.ReadFailed,
                }
            }
            return @intCast(amount);
        }
    }

    pub fn terminate(_: *Driver, child: *Child) PtyError!void {
        child.assertInvariants();
        defer child.close();
        if (child.pid > 0 and std.c.kill(child.pid, std.c.SIG.TERM) != 0) return error.KillFailed;
    }

    pub fn wait(_: *Driver, child: *Child) PtyError!ExitStatus {
        child.assertInvariants();
        if (child.pid <= 0) return error.WaitFailed;

        var status: c_int = 0;
        while (true) {
            const waited = std.c.waitpid(child.pid, &status, 0);
            if (waited < 0) {
                switch (std.posix.errno(waited)) {
                    .INTR => continue,
                    else => return error.WaitFailed,
                }
            }
            if (waited == 0) continue;

            child.pid = 0;
            const decoded = decodeExitStatus(status);
            child.assertInvariants();
            assert(decoded.exit_code >= -1);
            assert(decoded.signal >= 0);
            return decoded;
        }
    }

    pub fn tryWait(_: *Driver, child: *Child) PtyError!?ExitStatus {
        child.assertInvariants();
        if (child.pid <= 0) return null;

        var status: c_int = 0;
        const waited = std.c.waitpid(child.pid, &status, std.c.W.NOHANG);
        if (waited < 0) return error.WaitFailed;
        if (waited == 0) return null;

        child.pid = 0;
        const decoded = decodeExitStatus(status);
        child.assertInvariants();
        assert(decoded.exit_code >= -1);
        assert(decoded.signal >= 0);
        return decoded;
    }
};

pub fn reapInBackground(child: *Child) std.Thread.SpawnError!void {
    child.assertInvariants();
    child.close();
    assert(child.master_fd == -1);
    if (child.pid <= 0) return;

    const child_for_reaper = child.*;
    const thread = try std.Thread.spawn(.{}, reapDetachedChildThread, .{child_for_reaper});
    thread.detach();
    child.pid = 0;
    child.assertInvariants();
}

fn reapDetachedChildThread(child: Child) void {
    var owned_child = child;
    var driver = Driver.init(std.heap.smp_allocator);
    _ = driver.wait(&owned_child) catch |err| {
        std.log.warn("failed to reap detached PTY child {d}: {t}", .{ owned_child.pid, err });
    };
    owned_child.close();
}

fn decodeExitStatus(status: c_int) ExitStatus {
    const raw_status: u32 = @bitCast(status);
    if (std.c.W.IFEXITED(raw_status)) {
        const decoded: ExitStatus = .{ .exit_code = @intCast(std.c.W.EXITSTATUS(raw_status)), .signal = 0 };
        assert(decoded.exit_code >= 0);
        return decoded;
    }
    if (std.c.W.IFSIGNALED(raw_status)) {
        const decoded: ExitStatus = .{ .exit_code = -1, .signal = @intCast(std.c.W.TERMSIG(raw_status)) };
        assert(decoded.signal > 0);
        return decoded;
    }

    return .{ .exit_code = -1, .signal = 0 };
}

fn tiocswinszRequest() c_int {
    const raw: u32 = if (@hasDecl(std.c.T, "IOCSWINSZ"))
        @intCast(std.c.T.IOCSWINSZ)
    else
        0x80087467; // Darwin TIOCSWINSZ
    return @bitCast(raw);
}

pub fn validateSize(cols: u16, rows: u16) PtyError!void {
    if (cols == 0 or rows == 0) return error.InvalidSize;
}

test "pty driver validates terminal sizes" {
    try validateSize(80, 24);
    try std.testing.expectError(error.InvalidSize, validateSize(0, 24));
}

test "pty driver rejects empty argv before spawning" {
    var driver = Driver.init(std.testing.allocator);
    try std.testing.expectError(error.EmptyArgv, driver.spawn(.{
        .argv = &.{},
        .cols = 80,
        .rows = 24,
    }));
}

test "pty driver wait reaps exited child" {
    if (!absolutePathExists("/bin/sh")) return;

    var driver = Driver.init(std.testing.allocator);
    var child = try driver.spawn(.{
        .argv = &.{ "/bin/sh", "-c", "exit 7" },
        .cols = 80,
        .rows = 24,
    });
    defer child.close();
    const pid = child.pid;

    const status = try driver.wait(&child);
    try std.testing.expectEqual(@as(i32, 7), status.exit_code);
    try std.testing.expectEqual(@as(i32, 0), status.signal);
    try std.testing.expectEqual(@as(std.c.pid_t, 0), child.pid);
    try expectProcessGone(pid);
}

test "pty detached reaper reaps terminated child" {
    if (!absolutePathExists("/bin/sh")) return;

    var driver = Driver.init(std.testing.allocator);
    var child = try driver.spawn(.{
        .argv = &.{ "/bin/sh", "-c", "sleep 10" },
        .cols = 80,
        .rows = 24,
    });
    const pid = child.pid;

    try driver.terminate(&child);
    try reapInBackground(&child);
    try std.testing.expectEqual(@as(std.c.pid_t, 0), child.pid);
    try std.testing.expectEqual(@as(std.c.fd_t, -1), child.master_fd);
    try expectProcessGone(pid);
}

fn absolutePathExists(path: []const u8) bool {
    std.fs.accessAbsolute(path, .{}) catch return false;
    return true;
}

fn expectProcessGone(pid: std.c.pid_t) !void {
    var attempt: usize = 0;
    while (attempt < 200) : (attempt += 1) {
        if (std.c.kill(pid, 0) != 0) {
            switch (std.posix.errno(-1)) {
                .SRCH => return,
                else => return error.UnexpectedErrno,
            }
        }
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    return error.ProcessStillExists;
}
