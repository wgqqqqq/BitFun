//! Continuous native GDI display observations. This provider is selected
//! explicitly, never as a fallback from revoked WGC permission or another target.
use super::*;
use crate::remote_desktop::raw_frame::RawFrame;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP,
    HGDIOBJ, SRCCOPY,
};

pub(in crate::remote_desktop) struct Source {
    target: Display,
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut std::ffi::c_void,
    closed: bool,
}
impl Source {
    pub(in crate::remote_desktop) fn open(id: &str) -> Result<Self, String> {
        let _physical = physical_coordinates()?;
        let target = resolve(id)?;
        if !session_available() {
            return Err("host_locked".into());
        }
        if u64::from(target.width) * u64::from(target.height) > 64 * 1024 * 1024 {
            return Err("display_geometry_unavailable".into());
        }
        let screen = unsafe { GetDC(None) };
        if screen.0.is_null() {
            return Err("media_backend_unavailable".into());
        }
        let memory = unsafe { CreateCompatibleDC(Some(screen)) };
        if memory.0.is_null() {
            unsafe {
                ReleaseDC(None, screen);
            };
            return Err("media_backend_unavailable".into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: target.width as i32,
                biHeight: -(target.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = match unsafe {
            CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        } {
            Ok(bitmap) => bitmap,
            Err(_) => {
                unsafe {
                    DeleteDC(memory);
                    ReleaseDC(None, screen);
                };
                return Err("media_backend_unavailable".into());
            }
        };
        let previous = unsafe { SelectObject(memory, HGDIOBJ(bitmap.0)) };
        if bits.is_null() || previous.0.is_null() || previous.0 as isize == -1 {
            unsafe {
                DeleteObject(HGDIOBJ(bitmap.0));
                DeleteDC(memory);
                ReleaseDC(None, screen);
            };
            return Err("media_backend_unavailable".into());
        }
        Ok(Self {
            target,
            screen,
            memory,
            bitmap,
            previous,
            bits,
            closed: false,
        })
    }
    pub(in crate::remote_desktop) fn next(&mut self) -> Result<Option<RawFrame>, String> {
        let _physical = physical_coordinates()?;
        if self.closed || !session_available() {
            return Err("host_locked".into());
        }
        if resolve(&self.target.id)? != self.target {
            return Err("target_lost".into());
        }
        unsafe {
            BitBlt(
                self.memory,
                0,
                0,
                self.target.width as i32,
                self.target.height as i32,
                Some(self.screen),
                self.target.x,
                self.target.y,
                SRCCOPY | CAPTUREBLT,
            )
        }
        .map_err(|_| "media_unreachable")?;
        // GDI operations are queued per thread; flush before reading DIB memory.
        if !unsafe { windows::Win32::Graphics::Gdi::GdiFlush() }.as_bool() {
            return Err("media_unreachable".into());
        }
        self.cursor()?;
        if !unsafe { windows::Win32::Graphics::Gdi::GdiFlush() }.as_bool() {
            return Err("media_unreachable".into());
        }
        if !session_available() {
            return Err("host_locked".into());
        }
        if resolve(&self.target.id)? != self.target {
            return Err("target_lost".into());
        }
        let length = self.target.width as usize * self.target.height as usize * 4;
        let pixels = unsafe { std::slice::from_raw_parts(self.bits.cast::<u8>(), length) }.to_vec();
        Ok(Some(RawFrame {
            pixels,
            width: self.target.width,
            height: self.target.height,
            stride: self.target.width * 4,
        }))
    }
    fn cursor(&self) -> Result<(), String> {
        use windows::Win32::UI::WindowsAndMessaging::HICON;
        use windows::Win32::UI::WindowsAndMessaging::{
            DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, ICONINFO,
        };
        let mut cursor = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        unsafe { GetCursorInfo(&mut cursor) }.map_err(|_| "media_unreachable")?;
        if cursor.flags != CURSOR_SHOWING || cursor.hCursor.0.is_null() {
            return Ok(());
        }
        let mut icon = ICONINFO::default();
        unsafe { GetIconInfo(HICON(cursor.hCursor.0), &mut icon) }
            .map_err(|_| "media_unreachable")?;
        let result = unsafe {
            DrawIconEx(
                self.memory,
                cursor.ptScreenPos.x - self.target.x - icon.xHotspot as i32,
                cursor.ptScreenPos.y - self.target.y - icon.yHotspot as i32,
                HICON(cursor.hCursor.0),
                0,
                0,
                0,
                None,
                DI_NORMAL,
            )
        };
        if !icon.hbmColor.0.is_null() {
            unsafe {
                DeleteObject(HGDIOBJ(icon.hbmColor.0));
            }
        }
        if !icon.hbmMask.0.is_null() {
            unsafe {
                DeleteObject(HGDIOBJ(icon.hbmMask.0));
            }
        }
        result.map_err(|_| "media_unreachable".into())
    }
    pub(in crate::remote_desktop) fn close(&mut self) -> bool {
        if self.closed {
            return true;
        }
        if !self.previous.0.is_null() {
            let restored = unsafe { SelectObject(self.memory, self.previous) };
            if restored.0.is_null() || restored.0 as isize == -1 {
                return false;
            }
            self.previous = HGDIOBJ::default();
        }
        if !self.bitmap.0.is_null() {
            if !unsafe { DeleteObject(HGDIOBJ(self.bitmap.0)) }.as_bool() {
                return false;
            }
            self.bitmap = HBITMAP::default();
        }
        if !self.memory.0.is_null() {
            if !unsafe { DeleteDC(self.memory) }.as_bool() {
                return false;
            }
            self.memory = HDC::default();
        }
        if !self.screen.0.is_null() {
            if unsafe { ReleaseDC(None, self.screen) } == 0 {
                return false;
            }
            self.screen = HDC::default();
        }
        self.closed = true;
        self.closed
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
