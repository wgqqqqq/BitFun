//! Ordered DataChannel control requests. Correlation IDs are not replay keys.
use super::{
    input::{ControlGeneration, InputMessage, MAX_INPUT_BYTES},
    valid_id,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct ControlRequest {
    pub version: u32,
    pub request_id: String,
    #[serde(flatten)]
    pub action: ControlAction,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ControlAction {
    AcquireControl {
        expected_state_revision: String,
    },
    RenewControl {
        control_generation: ControlGeneration,
    },
    ReleaseControl {
        control_generation: ControlGeneration,
    },
}

#[derive(Clone)]
pub enum ControlMessage {
    Request(ControlRequest),
    Input(InputMessage),
}
impl ControlMessage {
    pub fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err("invalid_control_message");
        }
        if let Ok(request) = serde_json::from_slice::<ControlRequest>(bytes) {
            if request.version != 1 || !valid_id(&request.request_id) {
                return Err("invalid_control_request");
            }
            if let ControlAction::AcquireControl {
                expected_state_revision,
            } = &request.action
            {
                if !valid_id(expected_state_revision) {
                    return Err("invalid_control_request");
                }
            }
            return Ok(Self::Request(request));
        }
        InputMessage::parse(bytes, true)
            .map(Self::Input)
            .map_err(|_| "invalid_control_message")
    }
}
// No diagnostic formatting for requests or input bodies.

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_control_and_input_without_accepting_legacy_or_bad_generations() {
        assert!(matches!(ControlMessage::parse(br#"{"version":1,"request_id":"r1","kind":"acquire_control","body":{"expected_state_revision":"boot:1"}}"#), Ok(ControlMessage::Request(_))));
        assert!(matches!(
            ControlMessage::parse(
                br#"{"control_generation":"1","kind":"pointer_move","body":{"x":0.2,"y":0.3}}"#
            ),
            Ok(ControlMessage::Input(_))
        ));
        for bytes in [
            br#"{"version":2,"request_id":"r1","kind":"acquire_control","body":{"expected_state_revision":"boot:1"}}"#.as_slice(),
            br#"{"version":1,"request_id":"r1","kind":"renew_control","body":{"control_generation":1}}"#,
            br#"{"version":1,"request_id":"","kind":"release_control","body":{"control_generation":"1"}}"#,
            br#"{"version":1,"request_id":"r1","kind":"acquire_control","body":{"expected_state_revision":""}}"#,
            br#"{"version":1,"request_id":"r1","kind":"renew_control","body":{"control_generation":"01"}}"#,
        ] { assert!(ControlMessage::parse(bytes).is_err()); }
        assert!(ControlMessage::parse(&vec![b' '; MAX_INPUT_BYTES + 1]).is_err());
    }
}
