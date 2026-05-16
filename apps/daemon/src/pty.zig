const std = @import("std");

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

pub const Child = struct {
    pid: std.c.pid_t,
    master_fd: std.c.fd_t,
    cols: u16,
    rows: u16,

    pub fn close(self: *Child) void {
        if (self.master_fd >= 0) {
            _ = std.c.close(self.master_fd);
            self.master_fd = -1;
        }
    }
};

pub const ExitStatus = struct {
    exit_code: i32,
    signal: i32,
};

pub const SpawnOptions = struct {
    argv: []const []const u8,
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
        defer {
            for (argv_storage) |arg| self.allocator.free(arg);
            self.allocator.free(argv_storage);
        }

        var argv_c = try self.allocator.alloc(?[*:0]const u8, options.argv.len + 1);
        defer self.allocator.free(argv_c);

        for (options.argv, 0..) |arg, index| {
            if (arg.len == 0) return error.EmptyArgv;
            argv_storage[index] = try self.allocator.dupeZ(u8, arg);
            argv_c[index] = argv_storage[index].ptr;
        }
        argv_c[options.argv.len] = null;

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
            _ = execvp(argv_c[0].?, @ptrCast(argv_c.ptr));
            std.c._exit(127);
        }

        return .{
            .pid = pid,
            .master_fd = master_fd,
            .cols = options.cols,
            .rows = options.rows,
        };
    }

    pub fn resize(_: *Driver, child: *Child, cols: u16, rows: u16) PtyError!void {
        try validateSize(cols, rows);

        var winsize: std.c.winsize = .{
            .row = rows,
            .col = cols,
            .xpixel = 0,
            .ypixel = 0,
        };
        if (std.c.ioctl(child.master_fd, tiocswinszRequest(), &winsize) != 0) return error.ResizeFailed;

        child.cols = cols;
        child.rows = rows;
    }

    pub fn writeAll(_: *Driver, child: *Child, data: []const u8) PtyError!void {
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
        if (child.pid > 0 and std.c.kill(child.pid, std.c.SIG.TERM) != 0) return error.KillFailed;
        child.close();
    }

    pub fn tryWait(_: *Driver, child: *Child) PtyError!?ExitStatus {
        if (child.pid <= 0) return null;

        var status: c_int = 0;
        const waited = std.c.waitpid(child.pid, &status, std.c.W.NOHANG);
        if (waited < 0) return error.WaitFailed;
        if (waited == 0) return null;

        const raw_status: u32 = @bitCast(status);
        child.pid = 0;
        if (std.c.W.IFEXITED(raw_status)) {
            return .{ .exit_code = @intCast(std.c.W.EXITSTATUS(raw_status)), .signal = 0 };
        }
        if (std.c.W.IFSIGNALED(raw_status)) {
            return .{ .exit_code = -1, .signal = @intCast(std.c.W.TERMSIG(raw_status)) };
        }

        return .{ .exit_code = -1, .signal = 0 };
    }
};

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
