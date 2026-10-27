//! Explicit-display native probe. Counts/timestamps only; never copies pixels.
use super::*;
use serde_json::json;
use std::{
    fs::OpenOptions,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[test]
fn capture_output_geometry_keeps_allocation_and_sampling_limits_in_both_orientations() {
    // This validates the same entry gate as open(), without calling the OS,
    // allocating a source handle, or touching capture/input permission.
    for (width, height) in [(3840, 2160), (2160, 3840)] {
        assert!(DisplayCapture::validate_output_geometry(width, height, 60).is_ok());
    }
    for (width, height, fps) in [
        (3842, 2160, 30),
        (2160, 3842, 30),
        (3840, 2162, 30),
        (2162, 3840, 30),
        (3840, 3840, 30),
        (0, 1080, 30),
        (1920, 1, 30),
        (1921, 1080, 30),
        (1080, 1921, 30),
        (1920, 1080, 0),
        (1080, 1920, 61),
        (u32::MAX, u32::MAX, 30),
    ] {
        assert!(DisplayCapture::validate_output_geometry(width, height, fps).is_err());
    }
}

#[test]
#[ignore = "Lists native metadata without requesting permission or capturing"]
fn native_remote_desktop_capture_list_displays() {
    let displays = crate::remote_desktop::displays::list().unwrap();
    println!(
        "RD_CAPTURE_DISPLAYS {}",
        serde_json::to_string(&displays).unwrap()
    );
    println!("RD_CAPTURE_AVAILABILITY {}", availability());
}

#[derive(Default)]
struct Observations {
    frames: u64,
    idle: u64,
    unobservable: u64,
    failures: u64,
    timestamp_regressions: u64,
    last_timestamp: Option<i64>,
    samples: Vec<serde_json::Value>,
}

#[derive(Debug, PartialEq, Eq)]
enum CallbackObservation {
    Frame(i64),
    State(i32),
}

fn callback_context() -> (Box<Context>, Arc<Mutex<Vec<CallbackObservation>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let frames = events.clone();
    let states = events.clone();
    (
        Box::new(Context {
            closed: Arc::new(AtomicBool::new(false)),
            last_sample: AtomicI64::new(-1),
            frame: Box::new(move |frame| {
                frames
                    .lock()
                    .unwrap()
                    .push(CallbackObservation::Frame(frame.timestamp_us));
            }),
            state: Box::new(move |code| {
                states
                    .lock()
                    .unwrap()
                    .push(CallbackObservation::State(code));
            }),
        }),
        events,
    )
}

fn feed_frame(context: &mut Context, timestamp: i64) {
    // Only the injected callback sees this opaque non-null sentinel. It never
    // dereferences/retains pixels, creates an SDK frame, or calls the OS.
    let buffer = NonNull::<u8>::dangling().as_ptr().cast();
    unsafe { frame((context as *mut Context).cast(), buffer, timestamp) };
}

#[test]
fn callbacks_reject_repeated_or_regressing_samples_before_the_consumer() {
    let (mut context, events) = callback_context();
    for timestamp in [0, 0, 10, 9, 10, 11] {
        feed_frame(&mut context, timestamp);
    }
    assert_eq!(
        *events.lock().unwrap(),
        [
            CallbackObservation::Frame(0),
            CallbackObservation::State(3),
            CallbackObservation::Frame(10),
            CallbackObservation::State(3),
            CallbackObservation::State(3),
            CallbackObservation::Frame(11),
        ]
    );
}

#[test]
fn callbacks_reject_missing_buffer_and_invalid_time_without_poisoning_progress() {
    let (mut context, events) = callback_context();
    feed_frame(&mut context, 10);
    unsafe {
        frame(
            (&mut *context as *mut Context).cast(),
            std::ptr::null_mut(),
            50,
        )
    };
    feed_frame(&mut context, -1);
    feed_frame(&mut context, i64::MAX);
    feed_frame(&mut context, 11);
    assert_eq!(
        *events.lock().unwrap(),
        [
            CallbackObservation::Frame(10),
            CallbackObservation::State(3),
            CallbackObservation::State(3),
            CallbackObservation::State(3),
            CallbackObservation::Frame(11),
        ]
    );
}

#[test]
fn callbacks_after_cancellation_or_fatal_status_cannot_refresh_idle_or_submit() {
    for fatal in [false, true] {
        let (mut context, events) = callback_context();
        feed_frame(&mut context, 10);
        if fatal {
            unsafe { state((&mut *context as *mut Context).cast(), -4) };
        } else {
            context.closed.store(true, Ordering::Release);
        }
        feed_frame(&mut context, 11);
        for code in [1, 2, 3, -1, -4] {
            unsafe { state((&mut *context as *mut Context).cast(), code) };
        }
        let expected = if fatal {
            vec![
                CallbackObservation::Frame(10),
                CallbackObservation::State(-4),
            ]
        } else {
            vec![CallbackObservation::Frame(10)]
        };
        assert_eq!(*events.lock().unwrap(), expected);
    }
}

#[test]
fn callbacks_fail_closed_on_a_panicking_frame_or_status_consumer() {
    for frame_panics in [false, true] {
        let (mut context, events) = callback_context();
        if frame_panics {
            context.frame = Box::new(|_| panic!("Injected capture consumer failure"));
            feed_frame(&mut context, 10);
        } else {
            let states = events.clone();
            context.state = Box::new(move |code| {
                if code == 2 {
                    panic!("Injected status consumer failure");
                }
                states
                    .lock()
                    .unwrap()
                    .push(CallbackObservation::State(code));
            });
            unsafe { state((&mut *context as *mut Context).cast(), 2) };
        }
        assert!(context.closed.load(Ordering::Acquire));
        feed_frame(&mut context, 11);
        unsafe { state((&mut *context as *mut Context).cast(), 2) };
        assert_eq!(*events.lock().unwrap(), [CallbackObservation::State(-1)]);
    }
}

#[test]
fn callbacks_invalidate_an_observed_static_source_immediately_on_a_replayed_frame() {
    use openbitfun_product_domains::remote_desktop::health::{
        MediaHealth, ReceiverHealth, SourceActivity,
    };
    let health = Arc::new(Mutex::new(MediaHealth::default()));
    let submitted = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let observed_at = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let count = submitted.clone();
    let clock = observed_at.clone();
    let frames = health.clone();
    let states = health.clone();
    let mut context = Context {
        closed: Arc::new(AtomicBool::new(false)),
        last_sample: AtomicI64::new(-1),
        frame: Box::new(move |_| {
            frames.lock().unwrap().source_frame(
                count.fetch_add(1, Ordering::Relaxed) + 1,
                clock.load(Ordering::Relaxed),
            );
        }),
        state: Box::new(move |code| {
            let mut health = states.lock().unwrap();
            if code == 2 {
                health.source_idle(6000);
            } else {
                health.source_unavailable();
            }
        }),
    };
    feed_frame(&mut context, 10);
    {
        let mut health = health.lock().unwrap();
        for now in [0, 6000] {
            let probe = health.probe(now).unwrap();
            assert!(health.receive(
                ReceiverHealth {
                    version: 1,
                    kind: "health_reply".into(),
                    echo: probe.echo,
                    first_frame: true,
                    visible: true,
                    focused: true,
                    receiving: true,
                    decoded: 1,
                    presented: 1,
                },
                now + 1
            ));
        }
    }
    unsafe { state((&mut context as *mut Context).cast(), 2) };
    assert!(health.lock().unwrap().candidate(6001, true));
    observed_at.store(6001, Ordering::Relaxed);
    feed_frame(&mut context, 10);
    assert_eq!(submitted.load(Ordering::Relaxed), 1);
    let health = health.lock().unwrap();
    assert_eq!(health.source_activity(6001), SourceActivity::Unknown);
    assert!(!health.candidate(6001, true));
}

#[test]
#[ignore = "Requires explicit locally authorized display UUID; captures no default display"]
fn native_remote_desktop_capture_observations_and_drain() {
    assert_eq!(
        std::env::var("OPENBITFUN_RD_CAPTURE_AUTHORIZED").as_deref(),
        Ok("1"),
        "Explicit display-capture authorization is required; never infer it from TCC availability"
    );
    let display =
        std::env::var("OPENBITFUN_RD_CAPTURE_DISPLAY").expect("Select a display UUID explicitly");
    let output = std::env::var("OPENBITFUN_RD_CAPTURE_OBSERVATIONS")
        .expect("Private observation output is required");
    assert_eq!(
        availability(),
        "ready",
        "No permission request or unlock is performed by this probe"
    );
    let target = crate::remote_desktop::displays::resolve(&display).unwrap();
    let observations = Arc::new(Mutex::new(Observations::default()));
    let started = Instant::now();
    let frames = observations.clone();
    let states = observations.clone();
    let mut capture = DisplayCapture::open(
        target.id,
        &target.uuid,
        target.width,
        target.height,
        15,
        move |frame| {
            let mut seen = frames.lock().unwrap();
            // The CVPixelBuffer is borrowed and deliberately not dereferenced,
            // retained, copied, encoded or persisted by the probe.
            seen.frames += 1;
            if seen
                .last_timestamp
                .is_some_and(|old| frame.timestamp_us <= old)
            {
                seen.timestamp_regressions += 1;
            }
            seen.last_timestamp = Some(frame.timestamp_us);
            if seen.samples.len() < 512 {
                seen.samples
                    .push(json!({"kind":"frame","elapsed_ms":started.elapsed().as_millis()}));
            }
        },
        move |code| {
            let mut seen = states.lock().unwrap();
            match code {
                2 => seen.idle += 1,
                3 => seen.unobservable += 1,
                n if n < 0 => seen.failures += 1,
                _ => {}
            }
            if seen.samples.len() < 512 {
                seen.samples.push(
                    json!({"kind":"status","code":code,"elapsed_ms":started.elapsed().as_millis()}),
                );
            }
        },
    )
    .unwrap();
    thread::sleep(Duration::from_secs(10));
    let drained = capture.close();
    let before = {
        let seen = observations.lock().unwrap();
        (seen.frames, seen.idle, seen.unobservable, seen.failures)
    };
    thread::sleep(Duration::from_millis(250));
    let seen = observations.lock().unwrap();
    let after = (seen.frames, seen.idle, seen.unobservable, seen.failures);
    let result = json!({"scope":"macOS selected display, native capture callbacks only; no media, account, input or pixels stored",
        "display_id":display,"output_width":target.width,"output_height":target.height,
        "frames":seen.frames,"idle":seen.idle,"unobservable":seen.unobservable,"failures":seen.failures,
        "timestamp_regressions":seen.timestamp_regressions,"drained":drained,"callbacks_after_close":before!=after,"samples":seen.samples});
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(output)
        .unwrap();
    file.write_all(&serde_json::to_vec_pretty(&result).unwrap())
        .unwrap();
    assert!(
        drained,
        "Native source cleanup failed; this is not a successful capture result"
    );
    assert_eq!(before, after, "Native callbacks survived confirmed close");
    assert!(seen.frames > 0, "No real native frame was observed");
    assert_eq!(seen.failures, 0, "Native source reported a failure");
    assert_eq!(
        seen.timestamp_regressions, 0,
        "Sample time failed to progress monotonically"
    );
    // Idle is observed, not required: real desktop changes must not be labelled
    // static simply to make the probe pass. A static/freeze verdict needs the
    // controlled source fixture and the receiver/network observations as well.
}
