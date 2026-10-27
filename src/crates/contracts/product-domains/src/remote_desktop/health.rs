//! Per-PC media observations and bounded application round trips. No permission,
//! timers or IO. A positive candidate is never a device grant or input lease.
use serde::{Deserialize, Serialize};

// Initial diagnostic budgets. Platform freeze/network probes must validate
// them before a host advertises control; they are not a performance guarantee.
pub const PROBE_INTERVAL_MS: u64 = 2_000;
pub const PROBE_BUDGET_MS: u64 = 3_000;
pub const PROGRESS_BUDGET_MS: u64 = 6_000;

#[derive(Clone, Debug, Serialize)]
pub struct HealthProbe {
    pub version: u32,
    pub kind: &'static str,
    #[serde(with = "decimal")]
    pub echo: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceiverHealth {
    pub version: u32,
    pub kind: String,
    #[serde(with = "decimal")]
    pub echo: u64,
    pub first_frame: bool,
    pub visible: bool,
    pub focused: bool,
    pub receiving: bool,
    #[serde(with = "decimal")]
    pub decoded: u64,
    #[serde(with = "decimal")]
    pub presented: u64,
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceActivity {
    #[default]
    Unknown,
    Dynamic,
    Idle,
}

#[derive(Default)]
pub struct MediaHealth {
    source: SourceActivity,
    source_seen: Option<u64>,
    source_frames: u64,
    pending: Option<u64>,
    last_probe: Option<u64>,
    receiver: Option<(ReceiverHealth, u64)>,
    receiver_fresh: bool,
    decoded_progress: Option<u64>,
    presented_progress: Option<u64>,
    decoded_source_frames: u64,
    presented_source_frames: u64,
    counters_broken: bool,
    resumed_at: Option<u64>,
}

fn recent(at: Option<u64>, now: u64, budget: u64) -> bool {
    at.is_some_and(|at| now.checked_sub(at).is_some_and(|age| age < budget))
}

impl MediaHealth {
    /// Only actual monotonically advancing native samples call this, not an
    /// encoder's repeated output or a timer synthesizing source activity.
    pub fn source_frame(&mut self, frames: u64, now_ms: u64) {
        if frames <= self.source_frames {
            self.source_unavailable();
            return;
        }
        // A confirmed idle picture can legitimately have no recent decode or
        // presentation progress. Give its first changed sample the existing
        // transport budget; further samples/idle callbacks cannot extend it.
        if self.resumed_at.is_none() && self.static_observed() && self.candidate(now_ms, true) {
            self.resumed_at = Some(now_ms);
        }
        self.source_frames = frames;
        self.source = SourceActivity::Dynamic;
        self.source_seen = Some(now_ms);
    }
    /// Native provider independently says content did not change. Never infer
    /// this from silence/decoder counters. Idle alone cannot prove a first frame.
    pub fn source_idle(&mut self, now_ms: u64) {
        // After explicit capture loss, unchanged content cannot establish which
        // pixels the receiver has. Require a new valid sample before idle can
        // reuse its observations; silence alone does not set this loss state.
        if self.source == SourceActivity::Unknown {
            return;
        }
        self.source = SourceActivity::Idle;
        self.source_seen = Some(now_ms);
    }
    pub fn source_unavailable(&mut self) {
        self.source = SourceActivity::Unknown;
        self.source_seen = None;
        self.resumed_at = None;
    }

    /// Echo is this owner's monotonic send time, not another lifetime ID or an
    /// authority token. Only one outstanding round trip; consume replies once.
    pub fn probe(&mut self, now_ms: u64) -> Option<HealthProbe> {
        if recent(self.pending, now_ms, PROBE_BUDGET_MS) {
            return None;
        }
        if !self.last_probe.is_none_or(|at| {
            now_ms
                .checked_sub(at)
                .is_some_and(|age| age >= PROBE_INTERVAL_MS)
        }) {
            return None;
        }
        if self.pending.is_some() {
            self.receiver_fresh = false;
        }
        self.pending = Some(now_ms);
        self.last_probe = Some(now_ms);
        Some(HealthProbe {
            version: 1,
            kind: "health_probe",
            echo: now_ms,
        })
    }

    pub fn receive(&mut self, report: ReceiverHealth, now_ms: u64) -> bool {
        if report.version != 1
            || report.kind != "health_reply"
            || self.pending != Some(report.echo)
            || !recent(self.pending, now_ms, PROBE_BUDGET_MS)
        {
            return false;
        }
        self.pending = None;
        self.receiver_fresh = true;
        let previous = self
            .receiver
            .as_ref()
            .map(|(last, _)| (last.decoded, last.presented))
            .unwrap_or((0, 0));
        if report.decoded < previous.0 || report.presented < previous.1 {
            self.counters_broken = true;
        }
        if report.decoded > previous.0 {
            self.decoded_progress = Some(now_ms);
            self.decoded_source_frames = self.source_frames;
        }
        if report.presented > previous.1 {
            self.presented_progress = Some(now_ms);
            self.presented_source_frames = self.source_frames;
        }
        if self.decoded_source_frames == self.source_frames
            && self.presented_source_frames == self.source_frames
        {
            self.resumed_at = None;
        }
        self.receiver = Some((report, now_ms));
        true
    }

    /// Diagnostic conjunction. Concrete native/renderer freeze probes, current
    /// binding, grant, GUI reservation and lease are still required for input.
    pub fn candidate(&self, now_ms: u64, transport_bound: bool) -> bool {
        let Some((receiver, seen)) = &self.receiver else {
            return false;
        };
        if !transport_bound
            || !self.receiver_fresh
            || self.counters_broken
            || self.source_frames == 0
            || self.source == SourceActivity::Unknown
            || !recent(self.source_seen, now_ms, PROGRESS_BUDGET_MS)
            || !recent(Some(*seen), now_ms, PROBE_INTERVAL_MS + PROBE_BUDGET_MS)
            || self
                .pending
                .is_some_and(|at| !recent(Some(at), now_ms, PROBE_BUDGET_MS))
            || !receiver.first_frame
            || !receiver.visible
            || !receiver.focused
            || !receiver.receiving
            || receiver.decoded == 0
            || receiver.presented == 0
        {
            return false;
        }
        // A new source submission invalidates the static exemption until both
        // receiver counters advance. This is not exact RTP/frame alignment.
        self.static_observed()
            || recent(self.resumed_at, now_ms, PROGRESS_BUDGET_MS)
            || (recent(self.decoded_progress, now_ms, PROGRESS_BUDGET_MS)
                && recent(self.presented_progress, now_ms, PROGRESS_BUDGET_MS))
    }

    fn static_observed(&self) -> bool {
        self.source == SourceActivity::Idle
            && self.decoded_source_frames == self.source_frames
            && self.presented_source_frames == self.source_frames
    }

    pub fn source_activity(&self, now_ms: u64) -> SourceActivity {
        if recent(self.source_seen, now_ms, PROGRESS_BUDGET_MS) {
            self.source
        } else {
            SourceActivity::Unknown
        }
    }

    pub fn receiver_observed(&self, now_ms: u64) -> bool {
        self.receiver_fresh
            && self.receiver.as_ref().is_some_and(|(_, seen)| {
                recent(Some(*seen), now_ms, PROBE_INTERVAL_MS + PROBE_BUDGET_MS)
            })
            && self
                .pending
                .is_none_or(|at| recent(Some(at), now_ms, PROBE_BUDGET_MS))
    }
}

mod decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    pub(super) fn serialize<S: Serializer>(value: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&value.to_string())
    }
    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let text = String::deserialize(d)?;
        text.parse::<u64>()
            .ok()
            .filter(|n| n.to_string() == text)
            .ok_or_else(|| serde::de::Error::custom("invalid media counter"))
    }
}

#[cfg(test)]
#[path = "health_tests.rs"]
mod tests;
