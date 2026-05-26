use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct TaodBridge {
    socket_path: PathBuf,
}

impl TaodBridge {
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
        }
    }

    pub fn from_default_socket() -> Result<Self, String> {
        Ok(Self::new(default_socket_path()?))
    }

    pub fn socket_path(&self) -> &Path {
        self.socket_path.as_path()
    }

    pub fn request_value<T: Serialize>(&self, request: &T) -> Result<Value, String> {
        request_value(self.socket_path(), request)
    }
}

pub fn default_socket_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".tao")
        .join("run")
        .join("taod.sock"))
}

#[cfg(unix)]
fn request_value<T: Serialize>(socket_path: &Path, request: &T) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;

    const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
    let mut stream = UnixStream::connect(socket_path).map_err(|error| {
        format!(
            "failed to connect to taod at {}: {error}",
            socket_path.display()
        )
    })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| format!("failed to set taod read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("failed to set taod write timeout: {error}"))?;

    let mut payload = serde_json::to_vec(request)
        .map_err(|error| format!("failed to encode taod request: {error}"))?;
    payload.push(b'\n');
    stream
        .write_all(&payload)
        .map_err(|error| format!("failed to write taod request: {error}"))?;

    let mut response = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| format!("failed to read taod response: {error}"))?;
        if read == 0 {
            return Err("taod closed the socket before responding".to_string());
        }
        response.extend_from_slice(&buffer[..read]);
        if response.len() > MAX_RESPONSE_BYTES {
            return Err("taod control response too large".to_string());
        }
        if let Some(newline) = response.iter().position(|byte| *byte == b'\n') {
            response.truncate(newline);
            break;
        }
    }

    serde_json::from_slice(&response)
        .map_err(|error| format!("failed to decode taod response: {error}"))
}

#[cfg(not(unix))]
fn request_value<T: Serialize>(_socket_path: &Path, _request: &T) -> Result<Value, String> {
    Err("taod unix socket control is only supported on unix platforms".to_string())
}

#[cfg(test)]
mod tests {
    use super::TaodBridge;

    #[test]
    fn stores_socket_path() {
        let bridge = TaodBridge::new("/tmp/taod.sock");

        assert_eq!(bridge.socket_path().to_string_lossy(), "/tmp/taod.sock");
    }

    #[cfg(all(unix, not(miri)))]
    #[test]
    fn request_value_round_trips_one_ndjson_response() {
        use serde_json::json;
        use std::io::{Read, Write};
        use std::os::unix::net::UnixListener;
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT_SOCKET_ID: AtomicU64 = AtomicU64::new(0);

        let socket_path = std::env::temp_dir().join(format!(
            "tao-bridge-test-{}-{}.sock",
            std::process::id(),
            NEXT_SOCKET_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind test socket");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = Vec::new();
            loop {
                let mut byte = [0_u8; 1];
                stream.read_exact(&mut byte).expect("read request byte");
                request.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
            }
            assert_eq!(
                request,
                br#"{"type":"ping"}
"#
            );
            stream
                .write_all(
                    br#"{"ok":true,"answer":42}
{"ignored":true}
"#,
                )
                .expect("write response");
        });

        let bridge = TaodBridge::new(&socket_path);
        let response = bridge
            .request_value(&json!({ "type": "ping" }))
            .expect("request succeeds");
        assert_eq!(response["ok"].as_bool(), Some(true));
        assert_eq!(response["answer"].as_i64(), Some(42));

        server.join().expect("server joins");
        let _ = std::fs::remove_file(socket_path);
    }
}
