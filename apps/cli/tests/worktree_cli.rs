#![cfg(unix)]

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[test]
fn wt_new_uses_taod_control_api() {
    let bin = std::env::var("CARGO_BIN_EXE_tao").expect("cargo exposes tao binary path");
    let tmp = unique_temp_dir("tao-cli-wt-new");
    let home = tmp.join("home");
    let repo = tmp.join("repo");
    let run = home.join(".tao").join("run");
    std::fs::create_dir_all(&run).expect("create taod run dir");
    std::fs::create_dir_all(&repo).expect("create repo dir");
    let socket = run.join("taod.sock");
    let worktree_path = home
        .join(".tao")
        .join("worktrees")
        .join("repo")
        .join("generated-folder");

    let seen = Arc::new(Mutex::new(Vec::new()));
    let server = spawn_fake_taod(
        socket.clone(),
        repo.clone(),
        worktree_path.clone(),
        seen.clone(),
    );

    let deadline = Instant::now() + Duration::from_secs(2);
    while !socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        socket.exists(),
        "fake taod socket should exist before invoking tao"
    );

    let output = Command::new(bin)
        .arg("wt")
        .arg("new")
        .arg("feature/test")
        .arg("--from")
        .arg("main")
        .arg("--json")
        .current_dir(&repo)
        .env("HOME", &home)
        .output()
        .expect("run tao wt new");

    assert!(
        output.status.success(),
        "stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout is utf8");
    let created: Value = serde_json::from_str(&stdout).expect("stdout is worktree json");
    assert_eq!(created["branch"].as_str(), Some("feature/test"));
    assert_eq!(
        created["path"].as_str(),
        Some(worktree_path.to_string_lossy().as_ref())
    );

    server.join().expect("fake taod joins");
    assert_eq!(
        seen.lock().expect("seen lock").as_slice(),
        &["ping", "workspace.list", "workspace.add", "worktree.create"]
    );
    let _ = std::fs::remove_dir_all(tmp);
}

fn spawn_fake_taod(
    socket: PathBuf,
    repo: PathBuf,
    worktree_path: PathBuf,
    seen: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = UnixListener::bind(socket).expect("bind fake taod socket");
        listener
            .set_nonblocking(true)
            .expect("set listener nonblocking");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut handled = 0;
        while handled < 4 && Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => panic!("accept fake taod request: {error}"),
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set read timeout");
            while handled < 4 {
                let Some(request) = read_json_line(&mut stream) else {
                    break;
                };
                let request_type = request["type"].as_str().expect("request type");
                seen.lock()
                    .expect("seen lock")
                    .push(request_type.to_string());
                let response = match request_type {
                    "ping" => json!({ "ok": true, "status": "ok" }),
                    "workspace.list" => json!({ "ok": true, "workspaces": [] }),
                    "workspace.add" => json!({
                        "ok": true,
                        "workspace": {
                            "id": "workspace-1",
                            "root_path": repo.to_string_lossy(),
                            "worktrees": []
                        }
                    }),
                    "worktree.create" => {
                        assert_eq!(request["workspaceId"].as_str(), Some("workspace-1"));
                        assert_eq!(request["branch"].as_str(), Some("feature/test"));
                        assert_eq!(request["title"].as_str(), Some("feature/test"));
                        assert_eq!(request["baseBranch"].as_str(), Some("main"));
                        assert_eq!(request["targetBranch"].as_str(), Some("feature/test"));
                        assert_eq!(request["startPoint"].as_str(), Some("main"));
                        assert!(request.get("folderName").is_none());
                        json!({
                            "ok": true,
                            "worktree": {
                                "id": "worktree-1",
                                "folder_name": "generated-folder",
                                "path": worktree_path.to_string_lossy(),
                                "branch": "feature/test",
                                "state": "active"
                            }
                        })
                    }
                    other => panic!("unexpected fake taod request: {other}"),
                };
                writeln!(stream, "{response}").expect("write fake taod response");
                handled += 1;
            }
        }
        assert_eq!(handled, 4, "fake taod handled all expected requests");
    })
}

fn read_json_line(stream: &mut impl Read) -> Option<Value> {
    let mut line = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        match stream.read(&mut byte) {
            Ok(0) if line.is_empty() => return None,
            Ok(0) => panic!("fake taod request ended before newline"),
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return None;
            }
            Err(error) => panic!("read request byte: {error}"),
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    Some(serde_json::from_slice(&line).expect("request is json"))
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let path =
        PathBuf::from("/tmp").join(format!("{prefix}-{}-{}", std::process::id(), unique_id()));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn unique_id() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_nanos()
}
