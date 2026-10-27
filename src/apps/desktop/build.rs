fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=src/computer_use/pointer_motion.h");
        println!("cargo:rerun-if-changed=src/computer_use/pointer_motion.c");
        cc::Build::new()
            .file("src/computer_use/pointer_motion.c")
            .std("c11")
            .compile("computer_use_pointer_motion");
    }
    #[cfg(feature = "remote-desktop-media")]
    verify_remote_desktop_media_artifact();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/computer_use/macos_capture.m");
        println!("cargo:rerun-if-changed=src/computer_use/pointer_motion.h");
        cc::Build::new()
            .file("src/computer_use/macos_capture.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("computer_use_capture");
        if std::env::var_os("CARGO_FEATURE_REMOTE_DESKTOP_MEDIA").is_some() {
            // webrtc-sys's own link arg does not propagate to final consumers.
            // Keep SDK ObjC categories (e.g. NSString+StdString) in every host/test.
            println!("cargo:rustc-link-arg=-ObjC");
            println!("cargo:rerun-if-changed=src/remote_desktop/macos_display_capture.m");
            cc::Build::new()
                .file("src/remote_desktop/macos_display_capture.m")
                .flag("-fobjc-arc")
                .flag("-fblocks")
                .compile("remote_desktop_display_capture");
        }
        // Older macOS installs must reach the runtime unsupported-version guard.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
        for framework in [
            "CoreMedia",
            "CoreVideo",
            "CoreImage",
            "AppKit",
            "ApplicationServices",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    println!("cargo:rerun-if-env-changed=OPENBITFUN_RELEASE_CHANNEL");
    println!("cargo:rerun-if-env-changed=OPENBITFUN_DESKTOP_BINARY_NAME");
    println!("cargo:rerun-if-env-changed=OPENBITFUN_UPDATER_PRIMARY_ENDPOINT");
    println!("cargo:rerun-if-env-changed=OPENBITFUN_UPDATER_FALLBACK_ENDPOINT");
    // The Windows primary thread keeps the Tauri event loop and native window
    // creation stack. Reserve the same headroom as the Tokio workers so a
    // large debug invoke dispatcher cannot exhaust the default 1 MiB stack.
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg-bins=/STACK:8388608");
    println!("cargo:rerun-if-changed=windows-app.manifest");
    let windows =
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-app.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to build desktop platform resources");
}

#[cfg(feature = "remote-desktop-media")]
fn verify_remote_desktop_media_artifact() {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    println!("cargo:rerun-if-changed=remote-desktop-media-artifact.json");
    println!("cargo:rerun-if-env-changed=LK_CUSTOM_WEBRTC");
    println!("cargo:rerun-if-env-changed=LK_DEBUG_WEBRTC");
    let pin: serde_json::Value =
        serde_json::from_str(include_str!("remote-desktop-media-artifact.json"))
            .expect("Invalid remote desktop media artifact pin");
    assert_eq!(
        pin["tag"].as_str(),
        Some(webrtc_sys_build::WEBRTC_TAG),
        "Unexpected media artifact tag"
    );
    let triple = webrtc_sys_build::webrtc_triple();
    let artifact = &pin["artifacts"][&triple];
    let expected = artifact["sha256"]
        .as_str()
        .expect("No reviewed media artifact pin for this target/profile");
    webrtc_sys_build::download_webrtc().expect("Cannot resolve native media artifact");
    let library = webrtc_sys_build::webrtc_dir()
        .join("lib")
        .join(artifact["library"].as_str().unwrap());
    println!("cargo:rerun-if-changed={}", library.display());
    let mut file = std::fs::File::open(library).expect("Cannot read native media artifact");
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .expect("Cannot hash native media artifact");
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    assert_eq!(
        format!("{:x}", hash.finalize()),
        expected,
        "Native media artifact hash mismatch"
    );
}
