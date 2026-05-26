use crossterm::terminal;
use ratatui::{Terminal, backend::CrosstermBackend};
use std::{io::Stdout, marker::PhantomData};

pub struct TuiApp {
    _terminal: PhantomData<TaoTerminal>,
}

pub type TaoTerminal = Terminal<CrosstermBackend<Stdout>>;

impl TuiApp {
    pub fn new() -> Self {
        Self {
            _terminal: PhantomData,
        }
    }
}

pub fn print_scaffold() {
    let _app = TuiApp::new();
    let _raw_mode_fn: fn() -> std::io::Result<()> = terminal::enable_raw_mode;

    println!(
        "Tao TUI scaffold\n\nPlanned panes:\n  - agents: pi/codex/claude sessions from taod\n  - worktrees: headless workflow state from taod\n  - review: hunk-oriented diff view"
    );
}
