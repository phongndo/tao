mod commands;
mod review;
mod shell;
mod tui;
mod worktree;

use std::process::ExitCode;

fn main() -> ExitCode {
    commands::run(std::env::args().skip(1))
}
