pub fn run(args: impl IntoIterator<Item = String>) -> std::process::ExitCode {
    let args: Vec<String> = args.into_iter().collect();
    let Some(command) = args.first().map(String::as_str) else {
        crate::tui::print_scaffold();
        return std::process::ExitCode::SUCCESS;
    };

    match command {
        "tui" => {
            crate::tui::print_scaffold();
            std::process::ExitCode::SUCCESS
        }
        "review" => {
            crate::review::print_scaffold();
            std::process::ExitCode::SUCCESS
        }
        "new" | "cd" | "local" | "handoff" | "ls" | "path" | "rm" | "prune" => {
            crate::worktree::run(args)
        }
        "init" => run_shell_init(&args[1..]),
        "completion" | "completions" => run_completion(&args[1..]),
        "__complete" => run_hidden_completion(&args[1..]),
        "__shell-cd" => run_shell_cd(&args[1..]),
        "help" | "--help" | "-h" => {
            print_help();
            std::process::ExitCode::SUCCESS
        }
        command => {
            eprintln!("tao: unknown command: {command}");
            print_help();
            std::process::ExitCode::FAILURE
        }
    }
}

fn run_hidden_completion(args: &[String]) -> std::process::ExitCode {
    match args.first().map(String::as_str) {
        Some("wt-names") => {
            // Completion must stay cheap and non-mutating: do not start taod and do not
            // auto-add the current directory as a workspace just because the user hit Tab.
            crate::worktree::print_worktree_names_for_completion();
            std::process::ExitCode::SUCCESS
        }
        _ => std::process::ExitCode::SUCCESS,
    }
}

fn run_shell_init(args: &[String]) -> std::process::ExitCode {
    let mut shell = None;
    let mut install = false;
    for arg in args {
        match arg.as_str() {
            "--install" => install = true,
            "help" | "--help" | "-h" => {
                let _ = crate::shell::print_init("help");
                return std::process::ExitCode::SUCCESS;
            }
            value if value.starts_with('-') => {
                eprintln!("tao init: unknown option: {value}");
                return std::process::ExitCode::FAILURE;
            }
            value => {
                if shell.is_some() {
                    eprintln!("tao init: accepts at most one shell");
                    return std::process::ExitCode::FAILURE;
                }
                shell = Some(value);
            }
        }
    }

    let shell = shell.unwrap_or("help");
    let result = if install {
        crate::shell::install_init(shell)
    } else {
        crate::shell::print_init(shell)
    };

    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("tao init: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run_completion(args: &[String]) -> std::process::ExitCode {
    let shell = args.first().map(String::as_str).unwrap_or("help");
    match crate::shell::print_completion(shell) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("tao completion: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run_shell_cd(args: &[String]) -> std::process::ExitCode {
    let Some(scope) = args.first().map(String::as_str) else {
        eprintln!("tao: internal shell-cd command requires a worktree command");
        return std::process::ExitCode::FAILURE;
    };

    match scope {
        "new" | "cd" | "local" | "handoff" => crate::worktree::run_for_shell_cd(args.to_vec()),
        command => {
            eprintln!("tao: internal shell-cd does not support {command}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn print_help() {
    println!(
        "tao CLI\n\nUSAGE:\n  tao                             Open the TUI\n  tao review                      Review-diff workflow placeholder\n  tao new [branch]                Create a git worktree and branch\n  tao cd [branch]                 CD to worktree by branch name\n  tao local                       CD to the local workspace checkout\n  tao handoff                     Move branch between worktree and local checkout\n  tao ls                          List git worktrees\n  tao path [branch]               Print a worktree path\n  tao rm [branch]                 Remove a git worktree\n  tao prune                       Prune stale worktree metadata\n  tao init <zsh|bash|fish>        Print auto-cd and completion setup\n  tao init <shell> --install      Add setup to the shell rc file\n  tao completion <zsh|bash|fish>  Print completion only\n\nRun `tao help` for details."
    );
}
