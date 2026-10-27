//! USB page 0x07 physical mappings, independent of the controller keyboard layout.
pub(in crate::remote_desktop) fn evdev_key(usage: u16) -> Option<u16> {
    Some(match usage {
        4..=29 => [
            30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47,
            17, 45, 21, 44,
        ][usize::from(usage - 4)],
        30..=38 => usage - 28,
        39 => 11,
        40 => 28,
        41 => 1,
        42 => 14,
        43 => 15,
        44 => 57,
        45 => 12,
        46 => 13,
        47 => 26,
        48 => 27,
        49 | 50 => 43,
        51 => 39,
        52 => 40,
        53 => 41,
        54 => 51,
        55 => 52,
        56 => 53,
        57 => 58,
        58..=67 => usage + 1,
        68 => 87,
        69 => 88,
        70 => 99,
        71 => 70,
        73 => 110,
        74 => 102,
        75 => 104,
        76 => 111,
        77 => 107,
        78 => 109,
        79 => 106,
        80 => 105,
        81 => 108,
        82 => 103,
        83 => 69,
        84 => 98,
        85 => 55,
        86 => 74,
        87 => 78,
        88 => 96,
        89 => 79,
        90 => 80,
        91 => 81,
        92 => 75,
        93 => 76,
        94 => 77,
        95 => 71,
        96 => 72,
        97 => 73,
        98 => 82,
        99 => 83,
        100 => 86,
        101 => 127,
        224 => 29,
        225 => 42,
        226 => 56,
        227 => 125,
        228 => 97,
        229 => 54,
        230 => 100,
        231 => 126,
        _ => return None,
    })
}
pub(in crate::remote_desktop) fn windows_scan(usage: u16) -> Option<u16> {
    let key = evdev_key(usage)?;
    Some(match key {
        1..=88 => key,
        96 => 0xe01c,
        97 => 0xe01d,
        98 => 0xe035,
        99 => 0xe037,
        100 => 0xe038,
        102 => 0xe047,
        103 => 0xe048,
        104 => 0xe049,
        105 => 0xe04b,
        106 => 0xe04d,
        107 => 0xe04f,
        108 => 0xe050,
        109 => 0xe051,
        110 => 0xe052,
        111 => 0xe053,
        125 => 0xe05b,
        126 => 0xe05c,
        127 => 0xe05d,
        _ => return None,
    })
}
// An indivisible Unicode scalar; no text content enters Debug or serialized state.
pub(in crate::remote_desktop) struct TextChunk(pub(in crate::remote_desktop) char);
pub(in crate::remote_desktop) fn plan_text(text: &str) -> Result<Vec<TextChunk>, ()> {
    if text.is_empty() || text.len() > 4096 || text.contains('\0') {
        return Err(());
    }
    Ok(text.chars().map(TextChunk).collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_keys_preserve_sided_modifiers_and_reject_unmapped_usages() {
        assert_eq!(windows_scan(4), Some(30));
        assert_eq!(evdev_key(4), Some(30));
        assert_eq!(windows_scan(224), Some(0x1d));
        assert_eq!(windows_scan(228), Some(0xe01d));
        for usage in [0, 1, 3, 72, 65535] {
            assert!(evdev_key(usage).is_none());
        }
        assert_eq!(
            plan_text("中🙂e\u{301}")
                .unwrap()
                .into_iter()
                .map(|c| c.0)
                .collect::<String>(),
            "中🙂e\u{301}"
        );
        assert!(plan_text("\0").is_err());
    }
}
