//! NetworkKit C API (API 11+). HAPs cannot rely on Linux netlink enumeration.
use anyhow::{bail, Result};
use std::net::IpAddr;

// Layouts from network/netmanager/net_connection_type.h in the public SDK.
#[repr(C)]
struct NetHandle {
    id: i32,
}
#[repr(C)]
struct NetHandles {
    handles: [NetHandle; 32],
    count: i32,
}
#[repr(C)]
struct NetAddr {
    family: u8,
    prefix: u8,
    port: u8,
    address: [u8; 256],
}
#[repr(C)]
struct Route {
    interface: [u8; 256],
    destination: NetAddr,
    gateway: NetAddr,
    has_gateway: i32,
    is_default: i32,
}
#[repr(C)]
struct Proxy {
    host: [u8; 256],
    exclusions: [[u8; 256]; 256],
    count: i32,
    port: u16,
}
#[repr(C)]
struct Properties {
    interface: [u8; 256],
    domain: [u8; 256],
    tcp_buffers: [u8; 256],
    mtu: u16,
    addresses: [NetAddr; 32],
    address_count: i32,
    dns: [NetAddr; 32],
    dns_count: i32,
    routes: [Route; 64],
    route_count: i32,
    proxy: Proxy,
}

// ABI checked against the public ARM64 SDK with clang record layouts.
const _: () = {
    assert!(std::mem::size_of::<Properties>() == 133336);
    assert!(std::mem::offset_of!(Properties, addresses) == 770);
    assert!(std::mem::offset_of!(Properties, address_count) == 9060);
    assert!(std::mem::size_of::<NetHandles>() == 132);
};

#[link(name = "net_connection")]
extern "C" {
    fn OH_NetConn_GetAllNets(handles: *mut NetHandles) -> i32;
    fn OH_NetConn_GetConnectionProperties(
        handle: *mut NetHandle,
        properties: *mut Properties,
    ) -> i32;
}

fn text(bytes: &[u8]) -> Result<&str> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| anyhow::anyhow!("NetworkKit returned an unterminated string"))?;
    Ok(std::str::from_utf8(&bytes[..end])?)
}

pub(super) fn list_afinet_netifas() -> Result<Vec<(String, IpAddr)>> {
    // Both SDK output structures contain only integer fields and fixed arrays.
    let mut handles: NetHandles = unsafe { std::mem::zeroed() };
    let result = unsafe { OH_NetConn_GetAllNets(&mut handles) };
    if result != 0 {
        bail!("NetworkKit network enumeration failed: {result}");
    }
    if !(0..=32).contains(&handles.count) {
        bail!("NetworkKit returned an invalid network count");
    }
    let mut entries = Vec::new();
    for handle in &mut handles.handles[..handles.count as usize] {
        let mut properties = Box::<Properties>::new_uninit();
        // Initialize out storage without placing the large SDK record on the stack.
        unsafe {
            properties.as_mut_ptr().write_bytes(0, 1);
        }
        let result = unsafe { OH_NetConn_GetConnectionProperties(handle, properties.as_mut_ptr()) };
        if result != 0 {
            bail!("NetworkKit connection properties failed: {result}");
        }
        let properties = unsafe { properties.assume_init() };
        if !(0..=32).contains(&properties.address_count) {
            bail!("NetworkKit returned an invalid address count");
        }
        let name = text(&properties.interface)?.to_owned();
        for address in &properties.addresses[..properties.address_count as usize] {
            let ip: IpAddr = text(&address.address)?.parse()?;
            if !entries.contains(&(name.clone(), ip)) {
                entries.push((name.clone(), ip));
            }
        }
    }
    Ok(entries)
}
