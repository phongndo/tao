pub fn run(args: impl IntoIterator<Item = String>) -> std::process::ExitCode {
    match args.into_iter().next().as_deref() {
        Some("tui") | None => {
            crate::tui::print_scaffold();
            std::process::ExitCode::SUCCESS
        }
        Some("review") => {
            crate::review::print_scaffold();
            std::process::ExitCode::SUCCESS
        }
        Some("help" | "--help" | "-h") => {
            print_help();
            std::process::ExitCode::SUCCESS
        }
        Some(command) => {
            eprintln!("tao: command scaffolded but not implemented yet: {command}");
            print_help();
            std::process::ExitCode::FAILURE
        }
    }
}

fn print_help() {
    println!(
        "tao CLI scaffold\n\nUSAGE:\n  tao tui              TUI shell for agent/worktree/review workflows\n  tao review           Review-diff workflow placeholder\n\nPLANNED HEADLESS COMMANDS:\n  tao agent ...        List/attach/manage AI CLI sessions\n  tao workspace ...    Workspace metadata through taod\n  tao worktree ...     Worktree create/list/remove through taod\n  tao diff ...         Hunk-oriented review diff"
    );
}
