use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::io::ErrorKind;
#[cfg(unix)]
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct TaodBridge {
    socket_path: PathBuf,
}

#[derive(Debug, Clone)]
pub enum TaodBridgeError {
    Connect {
        socket_path: PathBuf,
        kind: ErrorKind,
        message: String,
    },
    Io {
        operation: &'static str,
        message: String,
    },
    Encode(String),
    Decode(String),
    Closed,
    ResponseTooLarge,
    UnsupportedPlatform,
}

impl fmt::Display for TaodBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect {
                socket_path,
                message,
                ..
            } => write!(
                formatter,
                "failed to connect to taod at {}: {message}",
                socket_path.display()
            ),
            Self::Io { operation, message } => {
                write!(formatter, "failed to {operation}: {message}")
            }
            Self::Encode(message) => write!(formatter, "failed to encode taod request: {message}"),
            Self::Decode(message) => write!(formatter, "failed to decode taod response: {message}"),
            Self::Closed => write!(formatter, "taod closed the socket before responding"),
            Self::ResponseTooLarge => write!(formatter, "taod control response too large"),
            Self::UnsupportedPlatform => write!(
                formatter,
                "taod unix socket control is only supported on unix platforms"
            ),
        }
    }
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
        self.request_value_typed(request)
            .map_err(|error| error.to_string())
    }

    pub fn request_value_typed<T: Serialize>(&self, request: &T) -> Result<Value, TaodBridgeError> {
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
fn request_value<T: Serialize>(socket_path: &Path, request: &T) -> Result<Value, TaodBridgeError> {
    use std::os::unix::net::UnixStream;

    const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
    let mut stream =
        UnixStream::connect(socket_path).map_err(|error| TaodBridgeError::Connect {
            socket_path: socket_path.to_path_buf(),
            kind: error.kind(),
            message: error.to_string(),
        })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| TaodBridgeError::Io {
            operation: "set taod read timeout",
            message: error.to_string(),
        })?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| TaodBridgeError::Io {
            operation: "set taod write timeout",
            message: error.to_string(),
        })?;

    let mut payload =
        serde_json::to_vec(request).map_err(|error| TaodBridgeError::Encode(error.to_string()))?;
    payload.push(b'\n');
    stream
        .write_all(&payload)
        .map_err(|error| TaodBridgeError::Io {
            operation: "write taod request",
            message: error.to_string(),
        })?;

    let mut response = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| TaodBridgeError::Io {
                operation: "read taod response",
                message: error.to_string(),
            })?;
        if read == 0 {
            return Err(TaodBridgeError::Closed);
        }
        response.extend_from_slice(&buffer[..read]);
        if response.len() > MAX_RESPONSE_BYTES {
            return Err(TaodBridgeError::ResponseTooLarge);
        }
        if let Some(newline) = response.iter().position(|byte| *byte == b'\n') {
            response.truncate(newline);
            break;
        }
    }

    serde_json::from_slice(&response).map_err(|error| TaodBridgeError::Decode(error.to_string()))
}

#[cfg(not(unix))]
fn request_value<T: Serialize>(
    _socket_path: &Path,
    _request: &T,
) -> Result<Value, TaodBridgeError> {
    Err(TaodBridgeError::UnsupportedPlatform)
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
    fn request_value_typed_reports_connect_kind() {
        use super::TaodBridgeError;

        let bridge = TaodBridge::new("/tmp/tao-missing-taod.sock");
        let error = bridge
            .request_value_typed(&serde_json::json!({ "type": "ping" }))
            .expect_err("missing socket fails");

        match error {
            TaodBridgeError::Connect { kind, .. } => assert_eq!(kind, std::io::ErrorKind::NotFound),
            other => panic!("unexpected error: {other:?}"),
        }
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
