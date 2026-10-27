//! v1 input facts and bounded pending input. No identity, grant, OS mapping or IO.
//! A host must validate the bound PC, current control lease and GUI reservation
//! at admission AND immediately before native submission, even after dequeue.
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::VecDeque;

pub const MAX_INPUT_BYTES: usize = 32 * 1024;
pub const MAX_TEXT_BYTES: usize = 4096;
pub const MAX_PENDING_INPUTS: usize = 128;
pub const MAX_PENDING_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_WHEEL_DELTA: f64 = 65_536.0;

/// Provider-supplied, display-oriented seat bounds and corresponding pixel
/// dimensions. This carries geometry, not authorization. Rotation/origin/DPI
/// changes require a new bound source; the native provider validates identity.
#[derive(Clone, Copy, PartialEq)]
pub struct SourceGeometry {
    origin: (f64, f64),
    size: (f64, f64),
    pixels: (u32, u32),
}
impl SourceGeometry {
    pub fn new(
        origin: (f64, f64),
        size: (f64, f64),
        pixels: (u32, u32),
    ) -> Result<Self, InputError> {
        if ![origin.0, origin.1, size.0, size.1]
            .into_iter()
            .all(f64::is_finite)
            || size.0 <= 0.0
            || size.1 <= 0.0
            || pixels.0 < 2
            || pixels.1 < 2
            || !(origin.0 + size.0).is_finite()
            || !(origin.1 + size.1).is_finite()
        {
            return Err(InputError::InvalidInput);
        }
        Ok(Self {
            origin,
            size,
            pixels,
        })
    }

    pub fn project(self, x: f64, y: f64) -> Result<(f64, f64), InputError> {
        if !normalized_point(x, y) {
            return Err(InputError::InvalidInput);
        }
        // The far edge is the last source pixel, not the adjacent display.
        Ok((
            self.origin.0 + x * (self.size.0 - self.size.0 / f64::from(self.pixels.0)),
            self.origin.1 + y * (self.size.1 - self.size.1 / f64::from(self.pixels.1)),
        ))
    }
}

fn normalized_point(x: f64, y: f64) -> bool {
    x.is_finite() && y.is_finite() && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)
}

/// Public wire generation, issued by the host. This is not an authority token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlGeneration(u64);
impl ControlGeneration {
    pub fn new(value: u64) -> Result<Self, InputError> {
        if value == 0 {
            Err(InputError::InvalidInput)
        } else {
            Ok(Self(value))
        }
    }
}
impl Serialize for ControlGeneration {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for ControlGeneration {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let value = text
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0 && value.to_string() == text)
            .ok_or_else(|| serde::de::Error::custom("invalid control generation"))?;
        Ok(Self(value))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerButton {
    Left,
    Right,
    Middle,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "body", rename_all = "snake_case")]
pub enum InputAction {
    PointerMove {
        x: f64,
        y: f64,
    },
    PointerButton {
        button: PointerButton,
        down: bool,
        x: f64,
        y: f64,
    },
    /// Pixel scroll deltas at a normalized source anchor. Modifier transitions
    /// are explicit Key events, hence they form coalescing barriers.
    Wheel {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
    /// Keyboard/Keypad usage page 0x07. A provider must reject unsupported or
    /// reserved mappings explicitly; wire validity is not native key support.
    Key {
        usage: u16,
        down: bool,
    },
    TextCommit {
        text: String,
    },
}
impl InputAction {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::PointerMove { .. } => "pointer_move",
            Self::PointerButton { .. } => "pointer_button",
            Self::Wheel { .. } => "wheel",
            Self::Key { .. } => "key",
            Self::TextCommit { .. } => "text_commit",
        }
    }
    pub fn validate(&self, text_supported: bool) -> Result<(), InputError> {
        let valid = match self {
            Self::PointerMove { x, y } | Self::PointerButton { x, y, .. } => {
                normalized_point(*x, *y)
            }
            Self::Wheel { x, y, dx, dy } => {
                normalized_point(*x, *y)
                    && dx.is_finite()
                    && dy.is_finite()
                    && dx.abs() <= MAX_WHEEL_DELTA
                    && dy.abs() <= MAX_WHEEL_DELTA
                    && (*dx != 0.0 || *dy != 0.0)
            }
            // 0 is no key; 1..3 describe keyboard report errors, not key input.
            Self::Key { usage, .. } => *usage >= 4,
            Self::TextCommit { text } => {
                if !text_supported {
                    return Err(InputError::TextUnsupported);
                }
                !text.is_empty() && text.len() <= MAX_TEXT_BYTES && !text.contains('\0')
            }
        };
        if valid {
            Ok(())
        } else {
            Err(InputError::InvalidInput)
        }
    }
}
// Never include text, keys, positions or buttons in diagnostic formatting.
impl std::fmt::Debug for InputAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InputAction")
            .field("kind", &self.kind())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct InputMessage {
    control_generation: ControlGeneration,
    #[serde(flatten)]
    action: InputAction,
}
impl InputMessage {
    /// Stamp at intent creation, never when a delayed intent is finally sent.
    pub fn new(control_generation: ControlGeneration, action: InputAction) -> Self {
        Self {
            control_generation,
            action,
        }
    }
    pub fn generation(&self) -> ControlGeneration {
        self.control_generation
    }
    pub fn action(&self) -> &InputAction {
        &self.action
    }
    /// Merge only adjacent, valid intents of the same generation. This grants
    /// no authority; callers preserve all intervening input/control boundaries.
    pub fn coalesced_with(&self, next: &Self) -> Option<Self> {
        if self.control_generation != next.control_generation {
            return None;
        }
        self.action.validate(true).ok()?;
        next.action.validate(true).ok()?;
        merge(&self.action, &next.action).map(|action| Self::new(self.control_generation, action))
    }
    pub fn parse(bytes: &[u8], text_supported: bool) -> Result<Self, InputError> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(InputError::InvalidInput);
        }
        let message: Self = serde_json::from_slice(bytes).map_err(|_| InputError::InvalidInput)?;
        message.action.validate(text_supported)?;
        Ok(message)
    }
    fn wire_bytes(&self) -> Result<usize, InputError> {
        serde_json::to_vec(self)
            .map(|bytes| bytes.len())
            .map_err(|_| InputError::InvalidInput)
    }
}
impl std::fmt::Debug for InputMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InputMessage")
            .field("control_generation", &self.control_generation)
            .field("kind", &self.action.kind())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputError {
    InvalidInput,
    TextUnsupported,
    StaleGeneration,
    Suspended,
    Backpressure,
}

struct PendingInput {
    message: InputMessage,
    bytes: usize,
}
/// Pending input for one logical attachment. No replay or sequence numbers; SCTP ordering is external.
/// Activating a newer generation consumes an already granted lease and clears old work;
/// this queue never grants authority, predicts source health or renews a lease.
#[derive(Default)]
pub struct InputQueue {
    generation: Option<ControlGeneration>,
    latest_generation: Option<ControlGeneration>,
    pending: VecDeque<PendingInput>,
    bytes: usize,
}
impl InputQueue {
    pub fn activate(&mut self, generation: ControlGeneration) -> Result<(), InputError> {
        if self
            .latest_generation
            .is_some_and(|latest| generation.0 <= latest.0)
        {
            return if self.generation == Some(generation) {
                Ok(())
            } else {
                Err(InputError::StaleGeneration)
            };
        }
        self.suspend();
        self.latest_generation = Some(generation);
        self.generation = Some(generation);
        Ok(())
    }
    pub fn suspend(&mut self) {
        self.generation = None;
        self.pending.clear();
        self.bytes = 0;
    }
    pub fn active(&self) -> bool {
        self.generation.is_some()
    }
    pub fn len(&self) -> usize {
        self.pending.len()
    }
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
    pub fn queued_bytes(&self) -> usize {
        self.bytes
    }
    pub fn push(&mut self, message: InputMessage, text_supported: bool) -> Result<(), InputError> {
        let current = self.generation.ok_or(InputError::Suspended)?;
        if message.control_generation != current {
            return Err(InputError::StaleGeneration);
        }
        message.action.validate(text_supported)?;
        let merged = self
            .pending
            .back()
            .and_then(|tail| tail.message.coalesced_with(&message));
        let coalesced = merged.is_some();
        let replaced_bytes = if coalesced {
            self.pending.back().map_or(0, |tail| tail.bytes)
        } else {
            0
        };
        let candidate = merged.unwrap_or(message);
        let bytes = candidate.wire_bytes()?;
        let next_bytes = self.bytes - replaced_bytes + bytes;
        if bytes > MAX_INPUT_BYTES
            || next_bytes > MAX_PENDING_INPUT_BYTES
            || (!coalesced && self.pending.len() >= MAX_PENDING_INPUTS)
        {
            self.suspend();
            return Err(InputError::Backpressure);
        }
        if coalesced {
            self.pending.pop_back();
        }
        self.pending.push_back(PendingInput {
            message: candidate,
            bytes,
        });
        self.bytes = next_bytes;
        Ok(())
    }
    pub fn pop(&mut self) -> Option<InputMessage> {
        let pending = self.pending.pop_front()?;
        self.bytes -= pending.bytes;
        Some(pending.message)
    }
}
fn merge(previous: &InputAction, next: &InputAction) -> Option<InputAction> {
    match (previous, next) {
        (InputAction::PointerMove { .. }, InputAction::PointerMove { x, y }) => {
            Some(InputAction::PointerMove { x: *x, y: *y })
        }
        (
            InputAction::Wheel {
                x: ax,
                y: ay,
                dx: adx,
                dy: ady,
            },
            InputAction::Wheel { x, y, dx, dy },
        ) if ax == x && ay == y && same_direction(*adx, *dx) && same_direction(*ady, *dy) => {
            let total_x = adx + dx;
            let total_y = ady + dy;
            (total_x.abs() <= MAX_WHEEL_DELTA && total_y.abs() <= MAX_WHEEL_DELTA).then_some(
                InputAction::Wheel {
                    x: *x,
                    y: *y,
                    dx: total_x,
                    dy: total_y,
                },
            )
        }
        _ => None,
    }
}
fn same_direction(a: f64, b: f64) -> bool {
    a == 0.0 || b == 0.0 || a.signum() == b.signum()
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
