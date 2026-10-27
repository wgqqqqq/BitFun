//! Negotiated attachment preferences and bounded video policy. No media or OS IO.
use super::*;

pub const QUALITY_PRESETS_V1: &str = "quality_presets_v1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualityPreset {
    #[default]
    DataSaver,
    Balanced,
    Clear,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QualitySettings {
    pub long_edge: u32,
    pub short_edge: u32,
    pub max_fps: u32,
    pub start_bitrate_bps: u32,
    pub max_bitrate_bps: u32,
}

impl QualityPreset {
    pub fn settings(self) -> QualitySettings {
        match self {
            Self::DataSaver => QualitySettings {
                long_edge: 1280,
                short_edge: 1080,
                max_fps: 15,
                start_bitrate_bps: 800_000,
                max_bitrate_bps: 1_200_000,
            },
            Self::Balanced => QualitySettings {
                long_edge: 1920,
                short_edge: 1080,
                max_fps: 30,
                start_bitrate_bps: 2_000_000,
                max_bitrate_bps: 4_000_000,
            },
            Self::Clear => QualitySettings {
                long_edge: 2560,
                short_edge: 1440,
                max_fps: 30,
                start_bitrate_bps: 4_000_000,
                max_bitrate_bps: 8_000_000,
            },
        }
    }

    /// No upscaling. Preserve orientation/aspect within even-pixel rounding;
    /// u128 intermediates keep untrusted metadata from overflowing arithmetic.
    pub fn capture_size(self, width: u64, height: u64) -> Option<(u32, u32)> {
        if width < 2 || height < 2 {
            return None;
        }
        let settings = self.settings();
        let (max_width, max_height) = if width >= height {
            (settings.long_edge, settings.short_edge)
        } else {
            (settings.short_edge, settings.long_edge)
        };
        let (w, h) = (u128::from(width), u128::from(height));
        let (mw, mh) = (u128::from(max_width), u128::from(max_height));
        let (numerator, denominator) = if w <= mw && h <= mh {
            (1, 1)
        } else if w * mh >= h * mw {
            (mw, w)
        } else {
            (mh, h)
        };
        Some((
            ((w * numerator / denominator) as u32 / 2 * 2).max(2),
            ((h * numerator / denominator) as u32 / 2 * 2).max(2),
        ))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetQualityRequest {
    pub attach_id: String,
    pub expected_state_revision: String,
    pub quality: QualityPreset,
}

impl ReadOnlyHost {
    /// Change only a fully drained source. Old input/geometry cannot survive
    /// into this preference; explicit resume creates a fresh binding afterward.
    pub fn set_quality(
        &mut self,
        source: &ControllerIdentity,
        request: &SetQualityRequest,
    ) -> Result<(), ReadOnlyError> {
        let current = self.source_attachment(source, &request.attach_id)?;
        if current.snapshot.phase != ViewPhase::Suspended {
            return Err(ReadOnlyError::InvalidRequest);
        }
        if self.retiring_connection.is_some() {
            return Err(ReadOnlyError::CleanupPending);
        }
        if current.snapshot.quality == request.quality {
            return Ok(());
        }
        if request.expected_state_revision != self.revision() {
            return Err(ReadOnlyError::StaleRevision);
        }
        self.advance()?;
        self.attachment.as_mut().unwrap().snapshot.quality = request.quality;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
