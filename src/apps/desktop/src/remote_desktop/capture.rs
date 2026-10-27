//! One native source worker, with bounded frames and confirmed teardown.
#[cfg(target_os = "linux")]
pub(super) use super::linux::availability;
#[cfg(target_os = "linux")]
use super::linux::Source;
#[cfg(target_os = "windows")]
pub(super) use super::windows::availability;
#[cfg(target_os = "windows")]
use super::windows::Source;
use libwebrtc::video_frame::I420Buffer;
use std::{
    marker::PhantomData,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

pub(super) struct NativeFrame<'a> {
    pub buffer: I420Buffer,
    pub timestamp_us: i64,
    _lifetime: PhantomData<&'a ()>,
}
pub(super) struct DisplayCapture {
    cancel: Arc<AtomicBool>,
    done: mpsc::Receiver<bool>,
    closed: bool,
}
impl DisplayCapture {
    pub(super) fn open(
        _: u32,
        id: &str,
        width: u32,
        height: u32,
        fps: u32,
        on_frame: impl for<'a> Fn(NativeFrame<'a>) + Send + Sync + 'static,
        on_state: impl Fn(i32) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        Self::validate_output_geometry(width, height, fps)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let stopped = cancel.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (done_tx, done) = mpsc::sync_channel(1);
        let id = id.to_owned();
        let on_state = Arc::new(on_state);
        let report = on_state.clone();
        std::thread::Builder::new()
            .name("remote-display-source".into())
            .spawn(move || {
                let mut source = match Source::open(&id) {
                    Ok(source) => source,
                    Err(code) => {
                        let _ = ready_tx.send(Err(code));
                        let _ = done_tx.send(true);
                        return;
                    }
                };
                if ready_tx.send(Ok(())).is_err() {
                    stopped.store(true, Ordering::Release);
                }
                let start = Instant::now();
                let pace = Duration::from_secs_f64(1.0 / f64::from(fps));
                if !stopped.load(Ordering::Acquire) {
                    on_state(1);
                }
                while !stopped.load(Ordering::Acquire) {
                    let tick = Instant::now();
                    match source.next() {
                        Ok(Some(raw)) => match raw.into_i420(width, height) {
                            Ok(buffer) => {
                                if !stopped.load(Ordering::Acquire) {
                                    on_frame(NativeFrame {
                                        buffer,
                                        timestamp_us: start
                                            .elapsed()
                                            .as_micros()
                                            .min(i64::MAX as u128 - 1)
                                            as i64,
                                        _lifetime: PhantomData,
                                    });
                                }
                            }
                            Err(_) => {
                                on_state(-1);
                                break;
                            }
                        },
                        // An empty pull is not evidence of native source idleness.
                        Ok(None) => on_state(3),
                        Err(code) => {
                            on_state(if code == "host_locked" {
                                -4
                            } else if code == "target_lost" {
                                -2
                            } else {
                                -1
                            });
                            break;
                        }
                    }
                    std::thread::sleep(pace.saturating_sub(tick.elapsed()));
                }
                stopped.store(true, Ordering::Release);
                // Keep native handles on their owning thread and keep the caller's
                // cleanup barrier until both pipeline and callbacks are closed.
                while !source.close() {
                    std::thread::sleep(Duration::from_millis(250));
                }
                let _ = done_tx.send(true);
            })
            .map_err(|_| "capture_worker_unavailable")?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                cancel,
                done,
                closed: false,
            }),
            Ok(Err(code)) => {
                cancel.store(true, Ordering::Release);
                Err(code)
            }
            Err(_) => {
                cancel.store(true, Ordering::Release);
                report(-1);
                // Keep the pending native worker owned until it has drained.
                // Returning an unowned startup error would release the global
                // source slot while an OS call could still finish late.
                Ok(Self {
                    cancel,
                    done,
                    closed: false,
                })
            }
        }
    }
    pub(super) fn validate_output_geometry(
        width: u32,
        height: u32,
        fps: u32,
    ) -> Result<(), String> {
        if width < 2
            || height < 2
            || width.max(height) > 3840
            || width.min(height) > 2160
            || width % 2 != 0
            || height % 2 != 0
            || !(1..=60).contains(&fps)
        {
            Err("invalid_capture_geometry".into())
        } else {
            Ok(())
        }
    }
    pub(super) fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
    pub(super) fn close(&mut self) -> bool {
        self.cancel();
        if !self.closed {
            self.closed = matches!(self.done.recv_timeout(Duration::from_secs(2)), Ok(true));
        }
        self.closed
    }
}
impl Drop for DisplayCapture {
    fn drop(&mut self) {
        self.cancel();
        if !self.closed && !self.close() {
            log::error!("Remote display cleanup remains pending");
        }
    }
}
