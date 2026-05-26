pub fn run(args: impl IntoIterator<Item = String>) {
    match args.into_iter().next().as_deref() {
        Some("tui") | None => crate::tui::print_scaffold(),
        Some("review") => crate::review::print_scaffold(),
        Some("help" | "--help" | "-h") => print_help(),
        Some(command) => {
            eprintln!("tao: command scaffolded but not implemented yet: {command}");
            print_help();
        }
    }
}

fn print_help() {
    println!(
        "tao CLI scaffold\n\nUSAGE:\n  tao tui              TUI shell for agent/worktree/review workflows\n  tao review           Review-diff workflow placeholder\n\nPLANNED HEADLESS COMMANDS:\n  tao agent ...        List/attach/manage AI CLI sessions\n  tao workspace ...    Workspace metadata through taod\n  tao worktree ...     Worktree create/list/remove through taod\n  tao diff ...         Hunk-oriented review diff"
    );
}
