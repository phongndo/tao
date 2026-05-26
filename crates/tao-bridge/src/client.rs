use std::path::{Path, PathBuf};

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

    pub fn socket_path(&self) -> &Path {
        self.socket_path.as_path()
    }
}

#[cfg(test)]
mod tests {
    use super::TaodBridge;

    #[test]
    fn stores_socket_path() {
        let bridge = TaodBridge::new("/tmp/taod.sock");

        assert_eq!(bridge.socket_path().to_string_lossy(), "/tmp/taod.sock");
    }
}
