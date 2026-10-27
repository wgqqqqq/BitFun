//! Small native Unicode pairs. The owner schedules each chunk separately under
//! its GUI/native guard; never hold that guard across a whole multi-second text.
use super::*;

// An adapter/probe bound, not a documented Quartz maximum. Keep each Unicode
// scalar intact and verify actual target delivery rather than trusting the setter.
const CHUNK_UNITS: usize = 8;

/// No Debug/Serialize: a prepared chunk is private input, not a diagnostic DTO.
#[allow(dead_code)] // Prepared adapter; no shipping text capability yet.
pub(in crate::remote_desktop) struct TextChunk(Vec<u16>);

pub(super) fn unicode_event(
    source: &CGEventSource,
    units: &[u16],
    down: bool,
) -> Result<CGEvent, ()> {
    let event = CGEvent::new_keyboard_event(source.clone(), 0, down)?;
    event.set_string_from_utf16_unchecked(units);
    event.set_flags(CGEventFlags::CGEventFlagNull);
    Ok(event)
}

#[allow(dead_code)] // The eventual input owner schedules each native pair.
impl MacInput {
    pub(in crate::remote_desktop) fn plan_text(
        text: &str,
    ) -> Result<Vec<TextChunk>, NativeInputError> {
        InputAction::TextCommit { text: text.into() }
            .validate(true)
            .map_err(|_| NativeInputError::InvalidInput)?;
        let mut result = Vec::new();
        let mut chunk = Vec::new();
        for scalar in text.chars() {
            let mut buffer = [0; 2];
            let encoded = scalar.encode_utf16(&mut buffer);
            if chunk.len() + encoded.len() > CHUNK_UNITS {
                result.push(TextChunk(std::mem::take(&mut chunk)));
            }
            chunk.extend_from_slice(encoded);
        }
        if !chunk.is_empty() {
            result.push(TextChunk(chunk));
        }
        Ok(result)
    }

    /// Hold the owner's guard through this one pair. A posted key-down always
    /// needs its key-up, even if authority expires between them. If the OS no
    /// longer permits release, keep the ledger and require owner-side drainage.
    pub(in crate::remote_desktop) fn submit_text_chunk(
        &mut self,
        chunk: &TextChunk,
        permit: impl FnOnce() -> bool,
    ) -> Result<(), NativeInputError> {
        if self.held.text.is_some() {
            return Err(NativeInputError::InputSuspended);
        }
        if !self.held.keys.is_empty() || self.held.buttons.iter().any(|held| *held) {
            return Err(NativeInputError::InvalidInput);
        }
        let down = unicode_event(&self.source, &chunk.0, true)
            .map_err(|_| NativeInputError::NativeUnavailable)?;
        let up = unicode_event(&self.source, &chunk.0, false)
            .map_err(|_| NativeInputError::NativeUnavailable)?;
        let pending = chunk.0.clone(); // Allocate before posting any input.
        if !permission() {
            return Err(NativeInputError::PermissionRequired);
        }
        if !session_available() {
            return Err(NativeInputError::SessionUnavailable);
        }
        if !self.display.current() {
            return Err(NativeInputError::TargetChanged);
        }
        if !permit() {
            return Err(NativeInputError::InputSuspended);
        }
        down.post(CGEventTapLocation::HID);
        self.held.text = Some(pending);
        // Release is cleanup, not a fresh action. Never gate it on the lease or
        // display remaining present; permissions/session still apply.
        if !permission() {
            return Err(NativeInputError::PermissionRequired);
        }
        if !session_available() {
            return Err(NativeInputError::SessionUnavailable);
        }
        up.post(CGEventTapLocation::HID);
        self.held.text = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunks_preserve_utf16_scalars_and_validate_the_wire_text_budget() {
        let text = "abcdefg\u{1f642}\u{4e2d}\u{6587}e\u{301}\u{1f469}\u{200d}\u{1f4bb}";
        let chunks = MacInput::plan_text(text).unwrap();
        assert!(chunks.iter().all(|chunk| !chunk.0.is_empty()
            && chunk.0.len() <= CHUNK_UNITS
            && String::from_utf16(&chunk.0).is_ok()));
        assert_eq!(
            chunks
                .iter()
                .flat_map(|chunk| chunk.0.iter().copied())
                .collect::<Vec<_>>(),
            text.encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(chunks[0].0.len(), 7); // Never cut the next surrogate pair.
        assert_eq!(MacInput::plan_text(&"a".repeat(4096)).unwrap().len(), 512);
        for text in ["", "a\0b", &"a".repeat(4097)] {
            assert!(MacInput::plan_text(text).is_err());
        }
    }

    #[test]
    fn unicode_pair_contains_exact_text_and_cleanup_keeps_pending_release() {
        let source = CGEventSource::new(CGEventSourceStateID::Private).unwrap();
        let units = "\u{4e2d}\u{1f642}".encode_utf16().collect::<Vec<_>>();
        for down in [true, false] {
            let event = unicode_event(&source, &units, down).unwrap();
            assert_eq!(
                event.get_type() as u32,
                if down {
                    CGEventType::KeyDown
                } else {
                    CGEventType::KeyUp
                } as u32
            );
            assert!(event.get_flags().is_empty());
            let mut actual = [0u16; CHUNK_UNITS];
            let mut length = 0;
            unsafe {
                CGEventKeyboardGetUnicodeString(
                    event.as_ptr().cast(),
                    actual.len(),
                    &mut length,
                    actual.as_mut_ptr(),
                );
            }
            assert_eq!(&actual[..length], units.as_slice());
        }
        let mut held = Held {
            text: Some(units),
            ..Held::default()
        };
        assert_eq!(
            held.drain_with(|_, _, _| Err(NativeInputError::PermissionRequired)),
            Err(NativeInputError::PermissionRequired)
        );
        assert!(held.text.is_some());
        let mut releases = 0;
        held.drain_with(|kind, flags, _| {
            assert!(matches!(kind, Release::Text));
            assert!(flags.is_empty());
            releases += 1;
            Ok(())
        })
        .unwrap();
        held.drain_with(|_, _, _| panic!("Repeated completed text release"))
            .unwrap();
        assert_eq!(releases, 1);
        assert!(held.text.is_none());
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventKeyboardGetUnicodeString(
            event: *mut c_void,
            maximum: usize,
            actual: *mut usize,
            text: *mut u16,
        );
    }
}
