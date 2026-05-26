use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlEnvelope {
    #[serde(rename = "type")]
    pub request_type: String,
}

#[cfg(test)]
mod tests {
    use super::ControlEnvelope;

    #[test]
    fn serializes_control_type_field() {
        let json = serde_json::to_string(&ControlEnvelope {
            request_type: "ping".to_string(),
        })
        .expect("control envelope should serialize");

        assert_eq!(json, r#"{"type":"ping"}"#);
    }
}
