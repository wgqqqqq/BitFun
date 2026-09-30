//! HarmonyOS Asset Store C API (API 11+). Secrets stay in the app-scoped OS store.
//! ABI definitions follow asset/asset_type.h and asset/asset_api.h in the SDK.
use super::StoredMarketCredentials;
use std::ptr;

const ALIAS: &[u8] = b"openbitfun.miniapp-market.v1/github-oauth";
const SECRET: u32 = 0x30000001;
const ALIAS_TAG: u32 = 0x30000002;
const NOT_FOUND: i32 = 24000002;

#[repr(C)]
#[derive(Clone, Copy)]
struct Blob {
    size: u32,
    data: *mut u8,
}
#[repr(C)]
union Value {
    boolean: bool,
    number: u32,
    blob: Blob,
}
#[repr(C)]
struct Attr {
    tag: u32,
    value: Value,
}
#[repr(C)]
struct Asset {
    count: u32,
    attrs: *mut Attr,
}
#[repr(C)]
struct Results {
    count: u32,
    results: *mut Asset,
}

#[link(name = "asset_ndk.z")]
extern "C" {
    fn OH_Asset_Add(attrs: *const Attr, count: u32) -> i32;
    fn OH_Asset_Query(attrs: *const Attr, count: u32, results: *mut Results) -> i32;
    fn OH_Asset_Remove(attrs: *const Attr, count: u32) -> i32;
    fn OH_Asset_ParseAttr(asset: *const Asset, tag: u32) -> *mut Attr;
    fn OH_Asset_FreeResultSet(results: *mut Results);
}

fn bytes(tag: u32, data: &[u8]) -> Attr {
    Attr {
        tag,
        value: Value {
            blob: Blob {
                size: data.len() as u32,
                data: data.as_ptr().cast_mut(),
            },
        },
    }
}
fn number(tag: u32, value: u32) -> Attr {
    Attr {
        tag,
        value: Value { number: value },
    }
}
fn check(code: i32) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!(
            "HarmonyOS Asset Store operation failed (code {code})"
        ))
    }
}

impl Drop for Results {
    fn drop(&mut self) {
        // The SDK owns the returned allocation, including nested attributes.
        unsafe { OH_Asset_FreeResultSet(self) };
    }
}

pub async fn load() -> Result<Option<StoredMarketCredentials>, String> {
    tokio::task::spawn_blocking(|| {
        let query = [bytes(ALIAS_TAG, ALIAS), number(0x20000040, 0)]; // RETURN_ALL
        let mut results = Results {
            count: 0,
            results: ptr::null_mut(),
        };
        // Input buffers live across the synchronous call; output is SDK-owned.
        let code = unsafe { OH_Asset_Query(query.as_ptr(), query.len() as u32, &mut results) };
        if code == NOT_FOUND {
            return Ok(None);
        }
        check(code)?;
        if results.count != 1 || results.results.is_null() {
            return Err("HarmonyOS credential query returned an invalid result set".into());
        }
        let attribute = unsafe { OH_Asset_ParseAttr(results.results, SECRET) };
        if attribute.is_null() {
            return Err("HarmonyOS credential secret is missing".into());
        }
        let blob = unsafe { (*attribute).value.blob };
        if blob.data.is_null() || blob.size == 0 || blob.size > 1024 {
            return Err("HarmonyOS credential secret has an invalid length".into());
        }
        let secret = unsafe { std::slice::from_raw_parts(blob.data, blob.size as usize) };
        // Never clear malformed credentials or include their contents in errors.
        serde_json::from_slice(secret)
            .map(Some)
            .map_err(|_| "Stored HarmonyOS account credentials are unreadable".into())
    })
    .await
    .map_err(|_| "HarmonyOS credential read worker failed".to_string())?
}

pub async fn save(credentials: StoredMarketCredentials) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let secret = serde_json::to_vec(&credentials)
            .map_err(|_| "Could not encode account credentials".to_string())?;
        if secret.len() > 1024 {
            return Err(
                "Account credentials exceed HarmonyOS Asset Store's 1024-byte entry limit".into(),
            );
        }
        let attrs = [
            bytes(ALIAS_TAG, ALIAS),
            bytes(SECRET, &secret),
            number(0x20000003, 1), // DEVICE_FIRST_UNLOCKED: background refresh after unlock.
            number(0x20000044, 0),
        ]; // CONFLICT_OVERWRITE: atomic refresh, no delete/recreate.
        check(unsafe { OH_Asset_Add(attrs.as_ptr(), attrs.len() as u32) })
    })
    .await
    .map_err(|_| "HarmonyOS credential write worker failed".to_string())?
}

pub async fn clear() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        let query = [bytes(ALIAS_TAG, ALIAS)];
        let code = unsafe { OH_Asset_Remove(query.as_ptr(), query.len() as u32) };
        if code == NOT_FOUND {
            Ok(())
        } else {
            check(code)
        }
    })
    .await
    .map_err(|_| "HarmonyOS credential removal worker failed".to_string())?
}
