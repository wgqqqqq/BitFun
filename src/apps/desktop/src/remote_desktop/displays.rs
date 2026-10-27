//! Display metadata only. Never captures pixels or substitutes a window source.
use anyhow::Result;
use serde::Serialize;

#[derive(Clone, Serialize)]
pub(super) struct Display {
    pub display_id: String,
    pub width: u64,
    pub height: u64,
}

#[cfg(target_os = "macos")]
fn list_native() -> Result<Vec<(u32, Display)>> {
    use core_foundation::{
        base::TCFType,
        string::CFString,
        uuid::{CFUUIDCreateString, CFUUIDRef, CFUUID},
    };
    use core_graphics::display::CGDisplay;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> CFUUIDRef;
    }
    let ids = CGDisplay::active_displays()
        .map_err(|code| anyhow::anyhow!("Display enumeration failed: {code}"))?;
    ids.into_iter()
        .map(|id| {
            // CGDirectDisplayID can be reused after hotplug/reboot. Grants pin the
            // OS display UUID instead, and unavailable UUIDs fail closed.
            let uuid = unsafe { CGDisplayCreateUUIDFromDisplayID(id) };
            if uuid.is_null() {
                anyhow::bail!("Display identity is unavailable");
            }
            let uuid: CFUUID = unsafe { TCFType::wrap_under_create_rule(uuid) };
            let string =
                unsafe { CFUUIDCreateString(std::ptr::null(), uuid.as_concrete_TypeRef()) };
            if string.is_null() {
                anyhow::bail!("Display identity is unavailable");
            }
            let string: CFString = unsafe { TCFType::wrap_under_create_rule(string) };
            let display = CGDisplay::new(id);
            // Quartz display/input dimensions can be points on a HiDPI mode.
            // Capture limits must use the rendered pixel grid instead.
            let mode = display
                .display_mode()
                .ok_or_else(|| anyhow::anyhow!("Display pixel mode is unavailable"))?;
            let (width, height) = (mode.pixel_width(), mode.pixel_height());
            if width < 2 || height < 2 {
                anyhow::bail!("Display pixel geometry is invalid");
            }
            Ok((
                id,
                Display {
                    display_id: format!("macos:{}", string.to_string().to_lowercase()),
                    width,
                    height,
                },
            ))
        })
        .collect()
}

#[cfg(target_os = "macos")]
pub(super) fn list() -> Result<Vec<Display>> {
    Ok(list_native()?
        .into_iter()
        .map(|(_, display)| display)
        .collect())
}

#[cfg(feature = "remote-desktop-media")]
pub(super) struct CaptureTarget {
    pub(super) id: u32,
    pub(super) uuid: String,
    pub(super) width: u32,
    pub(super) height: u32,
}
#[cfg(feature = "remote-desktop-media")]
pub(super) fn resolve(display_id: &str) -> Result<CaptureTarget> {
    resolve_with_quality(display_id, Default::default())
}

#[cfg(feature = "remote-desktop-media")]
pub(super) fn resolve_with_quality(
    display_id: &str,
    quality: openbitfun_product_domains::remote_desktop::QualityPreset,
) -> Result<CaptureTarget> {
    #[cfg(target_os = "macos")]
    let native = list_native()?;
    #[cfg(not(target_os = "macos"))]
    let native: Vec<_> = list()?.into_iter().map(|display| (0, display)).collect();
    let (id, display) = native
        .into_iter()
        .find(|(_, display)| display.display_id == display_id)
        .ok_or_else(|| anyhow::anyhow!("Selected display is unavailable"))?;
    if display.width < 2 || display.height < 2 {
        anyhow::bail!("Selected display geometry is invalid");
    }
    let (width, height) = quality
        .capture_size(display.width, display.height)
        .ok_or_else(|| anyhow::anyhow!("Selected display geometry is invalid"))?;
    Ok(CaptureTarget {
        id,
        uuid: display
            .display_id
            .strip_prefix("macos:")
            .unwrap_or(&display.display_id)
            .into(),
        width,
        height,
    })
}

#[cfg(target_os = "windows")]
pub(super) fn list() -> Result<Vec<Display>> {
    super::windows::list()
        .map(|displays| {
            displays
                .into_iter()
                .map(|d| Display {
                    display_id: d.id,
                    width: d.width.into(),
                    height: d.height.into(),
                })
                .collect()
        })
        .map_err(anyhow::Error::msg)
}
#[cfg(all(target_os = "linux", feature = "remote-desktop-media"))]
pub(super) fn list() -> Result<Vec<Display>> {
    super::linux::list().map_err(anyhow::Error::msg)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn remote_desktop_native_display_metadata_has_stable_scoped_ids() {
        if std::env::var("OPENBITFUN_TEST_MACOS_DISPLAY_METADATA").as_deref() != Ok("1") {
            return;
        }
        let first = super::list().unwrap();
        let second = super::list().unwrap();
        assert!(
            !first.is_empty(),
            "The opt-in fixture requires an active GUI display"
        );
        let first_ids: Vec<_> = first
            .iter()
            .map(|display| display.display_id.as_str())
            .collect();
        let second_ids: Vec<_> = second
            .iter()
            .map(|display| display.display_id.as_str())
            .collect();
        assert_eq!(first_ids, second_ids);
        let distinct: std::collections::HashSet<_> = first_ids.iter().collect();
        assert_eq!(distinct.len(), first.len());
        for display in first {
            assert!(display.display_id.starts_with("macos:"));
            assert!(display.width > 0 && display.height > 0);
        }
        for (id, display) in super::list_native().unwrap() {
            let mode = core_graphics::display::CGDisplay::new(id)
                .display_mode()
                .unwrap();
            assert_eq!(
                (display.width, display.height),
                (mode.pixel_width(), mode.pixel_height()),
                "Capture metadata must use HiDPI pixels, not Quartz input points"
            );
            #[cfg(feature = "remote-desktop-media")]
            for quality in [
                openbitfun_product_domains::remote_desktop::QualityPreset::DataSaver,
                openbitfun_product_domains::remote_desktop::QualityPreset::Balanced,
                openbitfun_product_domains::remote_desktop::QualityPreset::Clear,
            ] {
                let target = super::resolve_with_quality(&display.display_id, quality).unwrap();
                assert_eq!(
                    (target.width, target.height),
                    quality
                        .capture_size(mode.pixel_width(), mode.pixel_height())
                        .unwrap()
                );
            }
        }
        // Metadata enumeration does not prove capture permission or frame delivery.
    }
}

#[cfg(all(target_os = "linux", not(feature = "remote-desktop-media")))]
pub(super) fn list() -> Result<Vec<Display>> {
    anyhow::bail!("Native remote desktop is unavailable in this build")
}
