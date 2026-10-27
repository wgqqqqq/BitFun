//! Borrowed raw display frames. Source handles remain Desktop-owned; callbacks
//! never carry account credentials, transport handles or pixel copies into UI.
use std::{
    ffi::{c_void, CString},
    marker::PhantomData,
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc,
    },
};

/// A non-null borrowed sample with a nonnegative, strictly advancing timestamp
/// within this capture. Native callbacks run on its serial source queue.
pub(super) struct NativeFrame<'a> {
    pub(super) buffer: *mut c_void,
    pub(super) timestamp_us: i64,
    _borrow: PhantomData<&'a ()>,
}

struct Context {
    closed: Arc<AtomicBool>,
    last_sample: AtomicI64,
    frame: Box<dyn for<'a> Fn(NativeFrame<'a>) + Send + Sync>,
    state: Box<dyn Fn(i32) + Send + Sync>,
}

extern "C" {
    fn obf_rd_display_availability() -> i32;
    fn obf_rd_display_open(
        display: u32,
        uuid: *const std::ffi::c_char,
        width: u32,
        height: u32,
        fps: u32,
        context: *mut c_void,
        frame: unsafe extern "C" fn(*mut c_void, *mut c_void, i64),
        state: unsafe extern "C" fn(*mut c_void, i32),
    ) -> *mut c_void;
    fn obf_rd_display_destroy(handle: *mut c_void) -> bool;
}

pub(super) fn availability() -> &'static str {
    match unsafe { obf_rd_display_availability() } {
        2 => "ready",
        1 => "permission_required",
        3 => "host_locked",
        _ => "unsupported",
    }
}

unsafe extern "C" fn frame(context: *mut c_void, buffer: *mut c_void, timestamp_us: i64) {
    let context = unsafe { &*context.cast::<Context>() };
    if context.closed.load(Ordering::Acquire) {
        return;
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Reject an unusable or replayed sample before any consumer retains
        // its buffer or sends pixels to the encoder. It is never an idle frame.
        if buffer.is_null()
            || timestamp_us < 0
            || timestamp_us == i64::MAX
            || timestamp_us
                <= context
                    .last_sample
                    .fetch_max(timestamp_us, Ordering::Relaxed)
        {
            (context.state)(3);
            return;
        }
        (context.frame)(NativeFrame {
            buffer,
            timestamp_us,
            _borrow: PhantomData,
        });
    }));
    if result.is_err() {
        fail_callback(context);
    }
}
unsafe extern "C" fn state(context: *mut c_void, code: i32) {
    let context = unsafe { &*context.cast::<Context>() };
    if context.closed.load(Ordering::Acquire) {
        return;
    }
    if code < 0 {
        if context.closed.swap(true, Ordering::AcqRel) {
            return;
        }
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (context.state)(code);
    }));
    if result.is_err() {
        fail_callback(context);
    }
}

fn fail_callback(context: &Context) {
    context.closed.store(true, Ordering::Release);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (context.state)(-1);
    }));
}

pub(super) struct DisplayCapture {
    handle: Option<NonNull<c_void>>,
    context: NonNull<Context>,
    gate: Arc<AtomicBool>,
}
// The owner moves the opaque source only between blocking workers. Native
// callbacks borrow a stable Box; they never access DisplayCapture itself.
unsafe impl Send for DisplayCapture {}

impl DisplayCapture {
    /// Native allocation limits, independent from source/target authorization.
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
            return Err("Invalid native display output geometry".into());
        }
        Ok(())
    }

    /// Call only on a blocking worker. This starts a source after its owner has
    /// authorized/bound the media connection, never while preparing an offer.
    pub(super) fn open(
        display: u32,
        uuid: &str,
        width: u32,
        height: u32,
        fps: u32,
        on_frame: impl for<'a> Fn(NativeFrame<'a>) + Send + Sync + 'static,
        on_state: impl Fn(i32) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        Self::validate_output_geometry(width, height, fps)?;
        let uuid = CString::new(uuid).map_err(|_| "Invalid display identity")?;
        let gate = Arc::new(AtomicBool::new(false));
        let context = Box::into_raw(Box::new(Context {
            closed: gate.clone(),
            last_sample: AtomicI64::new(-1),
            frame: Box::new(on_frame),
            state: Box::new(on_state),
        }));
        let handle = unsafe {
            obf_rd_display_open(
                display,
                uuid.as_ptr(),
                width,
                height,
                fps,
                context.cast(),
                frame,
                state,
            )
        };
        let Some(handle) = NonNull::new(handle) else {
            unsafe {
                drop(Box::from_raw(context));
            }
            return Err("Native display capture unavailable or permission denied".into());
        };
        Ok(Self {
            handle: Some(handle),
            context: NonNull::new(context).unwrap(),
            gate,
        })
    }

    pub(super) fn cancel(&self) {
        self.gate.store(true, Ordering::Release);
    }

    /// Close on a blocking worker. A false return quarantines the handle and
    /// context; the host must keep its cleanup barrier and retry/disable sharing.
    pub(super) fn close(&mut self) -> bool {
        self.cancel();
        let Some(handle) = self.handle else {
            return true;
        };
        if unsafe { obf_rd_display_destroy(handle.as_ptr()) } {
            self.handle = None;
            unsafe {
                drop(Box::from_raw(self.context.as_ptr()));
            }
            true
        } else {
            false
        }
    }
}
impl Drop for DisplayCapture {
    fn drop(&mut self) {
        self.cancel();
        if self.handle.is_some() && !self.close() {
            // Do not free a context that ScreenCaptureKit may still call.
            log::error!("Native display cleanup failed; source quarantined");
        }
    }
}

#[cfg(test)]
#[path = "macos_capture_tests.rs"]
mod tests;
