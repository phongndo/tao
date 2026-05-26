pub struct ReviewApp;

impl ReviewApp {
    pub fn new() -> Self {
        Self
    }
}

pub fn print_scaffold() {
    let _app = ReviewApp::new();

    println!(
        "Tao review scaffold\n\nPlanned flow:\n  - load diff data from taod workspace.diff\n  - group hunks by file\n  - support stage/unstage/revert actions through taod"
    );
}
