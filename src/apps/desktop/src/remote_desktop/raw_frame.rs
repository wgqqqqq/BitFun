//! Bounded CPU frames for GDI and PipeWire/X11. No pixels cross signaling.
use libwebrtc::{native::yuv_helper, video_frame::I420Buffer};

pub(super) struct RawFrame {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
}
impl RawFrame {
    pub(super) fn into_i420(self, width: u32, height: u32) -> Result<I420Buffer, String> {
        let row = self.width.checked_mul(4).ok_or("invalid_frame")?;
        let length = self
            .stride
            .checked_mul(self.height)
            .ok_or("invalid_frame")? as usize;
        if self.width < 2
            || self.height < 2
            || self.width > 16384
            || self.height > 16384
            || self.stride < row
            || self.pixels.len() != length
            || length > 256 * 1024 * 1024
            || width < 2
            || height < 2
            || width.max(height) > 3840
            || width.min(height) > 2160
            || width % 2 != 0
            || height % 2 != 0
        {
            return Err("invalid_frame".into());
        }
        let mut buffer = I420Buffer::new(self.width, self.height);
        let (sy, su, sv) = buffer.strides();
        let (y, u, v) = buffer.data_mut();
        // libyuv ARGB denotes packed BGRA bytes on little-endian desktop hosts.
        yuv_helper::argb_to_i420(
            &self.pixels,
            self.stride,
            y,
            sy,
            u,
            su,
            v,
            sv,
            self.width as i32,
            self.height as i32,
        );
        Ok(if (self.width, self.height) == (width, height) {
            buffer
        } else {
            buffer.scale(width as i32, height as i32)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_frames_validate_pitch_and_convert_padded_bgra_before_scaling() {
        let frame = RawFrame {
            pixels: [vec![0, 0, 255, 255, 0, 0, 255, 255], vec![0; 4]]
                .concat()
                .repeat(2),
            width: 2,
            height: 2,
            stride: 12,
        };
        let buffer = frame.into_i420(4, 2).unwrap();
        assert_eq!(buffer.data().0.len(), 8);
        assert!(buffer.data().0.iter().all(|v| (80..=84).contains(v)));
        assert!(RawFrame {
            pixels: vec![0; 16],
            width: 2,
            height: 2,
            stride: 7
        }
        .into_i420(2, 2)
        .is_err());
    }
}
