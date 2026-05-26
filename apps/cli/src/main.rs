mod commands;
mod review;
mod tui;

use std::process::ExitCode;

fn main() -> ExitCode {
    commands::run(std::env::args().skip(1))
}
