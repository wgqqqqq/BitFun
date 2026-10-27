//! Native streaming frames from the explicitly selected X11 monitor or the
//! consented Portal FD. GStreamer never opens an unrestricted PipeWire remote.
use super::{portal, x11};
use crate::remote_desktop::raw_frame::RawFrame;
use gstreamer::{self as gst, prelude::*};
use gstreamer_video::{VideoFrameExt, VideoFrameRef, VideoInfo};
use std::{
    os::fd::AsRawFd,
    sync::{atomic::Ordering, Arc},
};
enum Target {
    Portal(Arc<portal::Session>),
    X11(x11::Display),
}
pub(in crate::remote_desktop) struct Source {
    target: Target,
    pipeline: gst::Pipeline,
    sink: gstreamer_app::AppSink,
    size: Option<(u32, u32)>,
    closed: bool,
}
impl Source {
    pub(in crate::remote_desktop) fn open(id: &str) -> Result<Self, String> {
        gst::init().map_err(|_| "media_backend_unavailable")?;
        let (target, source) = if super::wayland() {
            let session = portal::current()
                .filter(|session| session.id == id)
                .ok_or("permission_required")?;
            let source = gst::ElementFactory::make("pipewiresrc")
                .property("fd", session.fd.as_raw_fd())
                .property("do-timestamp", true)
                .build()
                .map_err(|_| "media_backend_unavailable")?;
            if let Some(serial) = session.serial {
                if source.find_property("target-object").is_none() {
                    return Err("pipewire_upgrade_required".into());
                }
                source.set_property("target-object", serial.to_string());
            } else {
                source.set_property("path", session.stream.to_string());
            }
            (Target::Portal(session), source)
        } else {
            if !x11::session_available() {
                return Err("host_locked".into());
            }
            let display = x11::resolve(id)?;
            let source = gst::ElementFactory::make("ximagesrc")
                .property("use-damage", false)
                .property("show-pointer", true)
                .property(
                    "startx",
                    u32::try_from(display.x).map_err(|_| "target_lost")?,
                )
                .property(
                    "starty",
                    u32::try_from(display.y).map_err(|_| "target_lost")?,
                )
                .property("endx", display.x as u32 + u32::from(display.width) - 1)
                .property("endy", display.y as u32 + u32::from(display.height) - 1)
                .build()
                .map_err(|_| "media_backend_unavailable")?;
            (Target::X11(display), source)
        };
        let convert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|_| "media_backend_unavailable")?;
        let sink = gstreamer_app::AppSink::builder()
            .caps(
                &gst::Caps::builder("video/x-raw")
                    .field("format", "BGRA")
                    .build(),
            )
            .max_buffers(1)
            .drop(true)
            .sync(false)
            .build();
        let pipeline = gst::Pipeline::new();
        pipeline
            .add_many([&source, &convert, sink.upcast_ref()])
            .map_err(|_| "media_backend_unavailable")?;
        gst::Element::link_many([&source, &convert, sink.upcast_ref()])
            .map_err(|_| "media_backend_unavailable")?;
        let mut source = Self {
            target,
            pipeline,
            sink,
            size: None,
            closed: false,
        };
        if source.pipeline.set_state(gst::State::Playing).is_err() {
            while !source.close() {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            return Err("media_backend_unavailable".into());
        }
        Ok(source)
    }
    fn current(&self) -> Result<(), String> {
        if !super::session_unlocked() {
            return Err("host_locked".into());
        }
        match &self.target {
            Target::Portal(session) if session.active.load(Ordering::Acquire) => Ok(()),
            Target::Portal(_) => Err("permission_required".into()),
            Target::X11(display) => {
                if !x11::session_available() {
                    return Err("host_locked".into());
                }
                if x11::resolve(&display.id)? != *display {
                    return Err("target_lost".into());
                }
                Ok(())
            }
        }
    }
    pub(in crate::remote_desktop) fn next(&mut self) -> Result<Option<RawFrame>, String> {
        self.current()?;
        if self
            .pipeline
            .bus()
            .and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error, gst::MessageType::Eos]))
            .is_some()
        {
            return Err("media_unreachable".into());
        }
        let Some(sample) = self.sink.try_pull_sample(gst::ClockTime::from_mseconds(80)) else {
            return Ok(None);
        };
        let caps = sample.caps().ok_or("invalid_frame")?;
        let info = VideoInfo::from_caps(caps).map_err(|_| "invalid_frame")?;
        let buffer = sample.buffer().ok_or("invalid_frame")?;
        let frame =
            VideoFrameRef::from_buffer_ref_readable(buffer, &info).map_err(|_| "invalid_frame")?;
        let size = (info.width(), info.height());
        if self.size.is_some_and(|previous| previous != size) {
            return Err("target_lost".into());
        }
        self.size = Some(size);
        let stride = u32::try_from(frame.plane_stride()[0]).map_err(|_| "invalid_frame")?;
        let data = frame.plane_data(0).map_err(|_| "invalid_frame")?;
        let length = stride.checked_mul(size.1).ok_or("invalid_frame")? as usize;
        if length > 256 * 1024 * 1024 || length > data.len() {
            return Err("invalid_frame".into());
        }
        let pixels = data[..length].to_vec();
        self.current()?;
        Ok(Some(RawFrame {
            pixels,
            width: size.0,
            height: size.1,
            stride,
        }))
    }
    pub(in crate::remote_desktop) fn close(&mut self) -> bool {
        if self.closed {
            return true;
        }
        if self.pipeline.set_state(gst::State::Null).is_err() {
            return false;
        }
        let (result, state, _) = self.pipeline.state(gst::ClockTime::from_seconds(2));
        self.closed = result.is_ok() && state == gst::State::Null;
        self.closed
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
