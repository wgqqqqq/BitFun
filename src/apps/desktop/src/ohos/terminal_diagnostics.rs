//! Explicit, one-shot developer validation inside the signed HAP sandbox.
use openbitfun_core::infrastructure::try_get_path_manager_arc;
use openbitfun_core::service::terminal::{spawn_pty, PtyEvent, ShellConfig, ShellType};
use std::time::Duration;

static REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn request(enabled: bool) {
    REQUESTED.store(enabled, std::sync::atomic::Ordering::Release);
}

pub fn run_if_requested() {
    if !REQUESTED.swap(false, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    let Ok(paths) = try_get_path_manager_arc() else {
        return;
    };
    let cwd = paths.temp_dir();
    tauri::async_runtime::spawn(async move {
        log::info!("HarmonyOS terminal diagnostic started in the application sandbox");
        match openbitfun_services_integrations::account_identity::load_market_credentials().await {
            Ok(credentials) => log::info!(
                "HarmonyOS account credential store ready: signed_in={}",
                credentials.is_some()
            ),
            Err(error) => log::warn!("HarmonyOS account credential store failed: {error}"),
        }
        match crate::api::remote_connect_api::remote_connect_get_lan_network_info().await {
            Ok(info) => log::info!(
                "HarmonyOS LAN network discovery ready: interface_count={}",
                info.available_ips.len()
            ),
            Err(error) => log::warn!("HarmonyOS LAN network discovery failed: {error}"),
        }
        match crate::tray::perform("initialize".into()).await {
            Ok(()) => log::info!("HarmonyOS native tray initialized"),
            Err(error) => log::warn!("HarmonyOS native tray initialization failed: {error}"),
        }
        match crate::api::terminal_api::verify_harmony_system_zsh().await {
            Ok(()) => log::info!("HarmonyOS system zsh preflight succeeded"),
            Err(error) => log::warn!("HarmonyOS system zsh preflight failed: {error}"),
        }
        let config = ShellConfig {
            executable: "/system/bin/sh".into(),
            args: vec!["-i".into()],
            cwd: Some(cwd.to_string_lossy().into_owned()),
            env: [("HOME".into(), cwd.to_string_lossy().into_owned())].into(),
            login: false,
        };
        let mut process = match spawn_pty(0, &config, ShellType::Sh, 80, 24) {
            Ok(process) => process,
            Err(error) => {
                log::warn!("HarmonyOS terminal diagnostic PTY/spawn failed: {error}");
                return;
            }
        };
        log::info!(
            "HarmonyOS terminal diagnostic spawned: pid={}",
            process.info.pid
        );
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            process.controller.resize(100, 30).await?;
            process.writer.write(b"printf '\\117BF_PTY_OK\\n'; exit 0\n").await?;
            let mut output = String::new();
            let mut resized = false;
            while let Some(event) = process.events.recv().await {
                match &event {
                    PtyEvent::Data(data) => log::info!("HarmonyOS terminal diagnostic output: {:?}", String::from_utf8_lossy(data)),
                    _ => log::info!("HarmonyOS terminal diagnostic event: {event:?}"),
                }
                match event {
                    PtyEvent::Data(data) => {
                        process.flow_control.acknowledge_data(data.len());
                        output.push_str(&String::from_utf8_lossy(&data));
                    }
                    PtyEvent::ResizeCompleted { cols: 100, rows: 30 } => resized = true,
                    _ => {}
                }
                if resized && output.contains("OBF_PTY_OK") {
                    // This primitive reports child exit when shutdown reaps it.
                    process.controller.shutdown(false).await?;
                    while let Some(event) = process.events.recv().await {
                        if let PtyEvent::Exit { exit_code } = event {
                            log::info!("HarmonyOS terminal diagnostic completed: output_marker=true resized=true exit_code={exit_code:?}");
                            return Ok::<(), openbitfun_core::service::terminal::TerminalError>(());
                        }
                    }
                }
            }
            Err(openbitfun_core::service::terminal::TerminalError::ProcessNotRunning)
        }).await;
        if !matches!(result, Ok(Ok(()))) {
            log::warn!("HarmonyOS terminal diagnostic did not complete: {result:?}");
            match tokio::time::timeout(Duration::from_secs(6), process.controller.shutdown(true))
                .await
            {
                Ok(Ok(())) => {}
                result => log::warn!("HarmonyOS terminal diagnostic cleanup failed: {result:?}"),
            }
        }
        check_product_session(cwd).await;
    });
}

async fn check_product_session(cwd: std::path::PathBuf) {
    use openbitfun_core::service::terminal::{
        CloseSessionRequest, CreateSessionRequest, GetHistoryRequest, SendCommandRequest,
        SessionSource, TerminalApi,
    };
    let api = match tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(api) = TerminalApi::from_singleton() {
                break api;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    {
        Ok(api) => api,
        Err(_) => {
            log::warn!("HarmonyOS terminal session diagnostic: product service not ready");
            return;
        }
    };
    let shells = api.get_available_shells();
    log::info!("HarmonyOS detected terminal shells: {:?}", shells);
    let session = match api
        .create_session(CreateSessionRequest {
            session_id: None,
            name: Some("HarmonyOS terminal diagnostic".into()),
            shell_type: Some(ShellType::Sh),
            shell_id: None,
            working_directory: Some(cwd.to_string_lossy().into_owned()),
            env: Some([("HOME".into(), cwd.to_string_lossy().into_owned())].into()),
            cols: Some(80),
            rows: Some(24),
            remote_connection_id: None,
            source: Some(SessionSource::Agent),
        })
        .await
    {
        Ok(session) => session,
        Err(error) => {
            log::warn!("HarmonyOS product terminal session creation failed: {error}");
            return;
        }
    };
    let mut output = api.subscribe_session_output(&session.id);
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        api.send_command(SendCommandRequest {
            session_id: session.id.clone(),
            command: "printf '\\117BF_SESSION_OK\\n'".into(),
        }).await?;
        let mut captured = String::new();
        while let Some(data) = output.recv().await {
            captured.push_str(&data);
            if captured.contains("OBF_SESSION_OK") {
                let history = api.get_history(GetHistoryRequest { session_id: session.id.clone() }).await?;
                log::info!("HarmonyOS product terminal diagnostic: shell={:?} output_marker=true replay_marker={}", session.shell_type, history.data.contains("OBF_SESSION_OK"));
                return Ok::<(), openbitfun_core::service::terminal::TerminalError>(());
            }
        }
        Err(openbitfun_core::service::terminal::TerminalError::ProcessNotRunning)
    }).await;
    if !matches!(result, Ok(Ok(()))) {
        log::warn!("HarmonyOS product terminal command failed: {result:?}");
    }
    if let Err(error) = api
        .close_session(CloseSessionRequest {
            session_id: session.id,
            immediate: Some(true),
        })
        .await
    {
        log::warn!("HarmonyOS product terminal diagnostic cleanup failed: {error}");
    }
}
