/// BitFun CLI
/// 
/// Command-line interface version, supports:
/// - Interactive TUI
/// - Single command execution
/// - Batch task processing

mod config;
#[allow(dead_code)]
mod chat_state;
mod commands;
mod ui;
mod modes;
mod agent;
mod prompts;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU8, Ordering};

use config::CliConfig;
use modes::chat::ChatMode;
use modes::exec::ExecMode;

// ======================== Global MCP Service ========================

static MCP_SERVICE: OnceLock<std::sync::Arc<bitfun_core::service::mcp::MCPService>> =
    OnceLock::new();

/// MCP initialization status: 0=not started, 1=in progress, 2=completed, 3=failed
static MCP_INIT_STATUS: OnceLock<AtomicU8> = OnceLock::new();

/// Get the MCP init status atomic
fn get_mcp_init_status() -> &'static AtomicU8 {
    MCP_INIT_STATUS.get_or_init(|| AtomicU8::new(0))
}

/// Get MCP status text for UI display
pub fn get_mcp_status_text() -> String {
    let status = get_mcp_init_status().load(Ordering::Relaxed);
    match status {
        0 => "MCP: Pending".to_string(),
        1 => "MCP: Connecting...".to_string(),
        2 => "MCP: Ready".to_string(),
        3 => "MCP: Failed".to_string(),
        _ => "MCP: Unknown".to_string(),
    }
}

/// Get the global MCP service instance (if initialized)
pub fn get_mcp_service() -> Option<&'static std::sync::Arc<bitfun_core::service::mcp::MCPService>> {
    MCP_SERVICE.get()
}

#[derive(Parser)]
#[command(name = "bitfun")]
#[command(about = "BitFun CLI - AI agent-driven command-line programming assistant", long_about = None)]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
    
    /// Workspace path (project directory), defaults to current directory
    project: Option<String>,
    
    /// Enable verbose logging
    #[arg(short, long, global = true)]
    verbose: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Start interactive chat (TUI)
    Chat {
        /// Agent type
        #[arg(short, long, default_value = "agentic")]
        agent: String,
        
        /// Workspace path
        #[arg(short, long)]
        workspace: Option<String>,
    },
    
    /// Execute single command
    Exec {
        /// User message
        message: String,
        
        /// Agent type
        #[arg(short, long, default_value = "agentic")]
        agent: String,
        
        /// Workspace path
        #[arg(short, long)]
        workspace: Option<String>,
        
        /// Output in JSON format (script-friendly)
        #[arg(long)]
        json: bool,
        
        /// Output git diff patch after execution (for SWE-bench evaluation)
        /// Without path outputs to terminal, with path saves to file
        /// Example: --output-patch or --output-patch ./result.patch
        #[arg(long, num_args = 0..=1, default_missing_value = "-")]
        output_patch: Option<String>,
        
        /// Tool execution requires confirmation (default: no confirmation to avoid blocking non-interactive mode)
        #[arg(long)]
        confirm: bool,
    },
    
    /// Execute batch tasks
    Batch {
        /// Task configuration file path
        #[arg(short, long)]
        tasks: String,
    },
    
    /// Session management
    Sessions {
        #[command(subcommand)]
        action: SessionAction,
    },
    
    /// Configuration management
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    
    /// Invoke tool directly
    Tool {
        /// Tool name
        name: String,
        
        /// Tool parameters (JSON)
        #[arg(short, long)]
        params: Option<String>,
    },
    
    /// Health check
    Health,

    /// Start Agent Client Protocol (ACP) server over stdio
    Acp {
        /// Working directory for the ACP session
        #[arg(short, long)]
        workspace: Option<String>,
    },
}

#[derive(Subcommand)]
enum SessionAction {
    /// List all sessions
    List,
    /// Show session details
    Show {
        /// Session ID (or "last" for the most recent)
        id: String,
    },
    /// Delete session
    Delete {
        /// Session ID
        id: String,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Show configuration
    Show,
    /// Edit configuration
    Edit,
    /// Reset to default configuration
    Reset,
}

// ======================== System Initialization ========================

/// Set the workspace path and return the resolved absolute path
fn setup_workspace(ws: &str) -> Option<String> {
    use std::path::PathBuf;

    let workspace_path = if ws == "." {
        std::env::current_dir().ok()
    } else {
        Some(PathBuf::from(ws))
    };

    tracing::info!("Workspace path set: {:?}", workspace_path);

    workspace_path.map(|p| p.to_string_lossy().to_string())
}

/// Initialize all core services (config, AI client, agentic system).
/// Returns (agentic_system, original_skip_confirmation).
async fn initialize_core_services(
    skip_tool_confirmation: bool,
) -> Result<(agent::agentic_system::AgenticSystem, bool)> {
    use bitfun_core::infrastructure::ai::AIClientFactory;

    bitfun_core::service::config::initialize_global_config()
        .await
        .expect("Failed to initialize global config service");
    tracing::info!("Global config service initialized");

    // Save and override tool confirmation setting
    let config_service = bitfun_core::service::config::get_global_config_service()
        .await
        .ok();
    let original_skip_confirmation = if let Some(ref svc) = config_service {
        let ai_config: bitfun_core::service::config::types::AIConfig =
            svc.get_config(Some("ai")).await.unwrap_or_default();
        ai_config.skip_tool_confirmation
    } else {
        false
    };
    if let Some(ref svc) = config_service {
        let _ = svc
            .set_config("ai.skip_tool_confirmation", skip_tool_confirmation)
            .await;
    }

    AIClientFactory::initialize_global()
        .await
        .expect("Failed to initialize global AIClientFactory");
    tracing::info!("Global AI client factory initialized");

    let agentic_system = agent::agentic_system::init_agentic_system()
        .await
        .expect("Failed to initialize agentic system");
    tracing::info!("Agentic system initialized");

    // Initialize MCP service in background (non-blocking)
    if let Some(ref cfg_svc) = config_service {
        match bitfun_core::service::mcp::MCPService::new(cfg_svc.clone()) {
            Ok(mcp_service) => {
                let mcp_service = std::sync::Arc::new(mcp_service);
                MCP_SERVICE.set(mcp_service.clone()).ok();
                
                // Mark as in progress
                get_mcp_init_status().store(1, Ordering::Relaxed);
                
                // Background async initialization
                tokio::spawn(async move {
                    let result = mcp_service.server_manager().initialize_all().await;
                    match result {
                        Ok(_) => {
                            tracing::info!("MCP servers initialized successfully");
                            get_mcp_init_status().store(2, Ordering::Relaxed);
                        }
                        Err(e) => {
                            tracing::warn!("Failed to initialize MCP servers: {}", e);
                            get_mcp_init_status().store(3, Ordering::Relaxed);
                        }
                    }
                });
            }
            Err(e) => {
                tracing::warn!("Failed to create MCP service: {}", e);
                get_mcp_init_status().store(3, Ordering::Relaxed);
            }
        }
    }

    Ok((agentic_system, original_skip_confirmation))
}

/// Restore original tool confirmation setting
async fn restore_tool_confirmation(original: bool) {
    if let Ok(svc) = bitfun_core::service::config::get_global_config_service().await {
        let _ = svc
            .set_config("ai.skip_tool_confirmation", original)
            .await;
    }
}

/// Shutdown MCP servers gracefully
async fn shutdown_mcp_servers() {
    if let Some(mcp_service) = get_mcp_service() {
        if let Err(e) = mcp_service.server_manager().shutdown().await {
            tracing::warn!("Failed to shutdown MCP servers: {}", e);
        } else {
            tracing::info!("MCP servers shut down successfully");
        }
    }
}

// ======================== Interactive TUI Flow ========================

/// Run the full interactive TUI flow: loading screen → startup page → chat
async fn run_interactive(
    config: CliConfig,
    default_agent: String,
    workspace_str: String,
) -> Result<()> {
    use ui::startup::{StartupPage, StartupResult};

    // 1. Initialize terminal and show loading screen
    let mut terminal = ui::init_terminal()?;
    ui::render_loading(&mut terminal, "Initializing system, please wait...")?;

    // 2. Set workspace path
    let workspace = setup_workspace(&workspace_str);

    // 3. Initialize core services
    let (agentic_system, original_skip_confirmation) =
        initialize_core_services(true).await?;

    // 4. Show startup page (with full command support)
    let mut startup_page = StartupPage::new(
        agentic_system.coordinator.clone(),
        default_agent,
        workspace.clone(),
    );
    let startup_result = startup_page.run(&mut terminal)?;

    match startup_result {
        StartupResult::Exit => {
            shutdown_mcp_servers().await;
            restore_tool_confirmation(original_skip_confirmation).await;
            ui::restore_terminal(terminal)?;
            println!("Goodbye!");
            return Ok(());
        }
        _ => {}
    }

    // 5. Parse startup result and enter chat
    let (restore_session_id, initial_prompt) = match &startup_result {
        StartupResult::NewSession { prompt } => (None, prompt.clone()),
        StartupResult::ContinueSession(id) => (Some(id.clone()), None),
        StartupResult::Exit => unreachable!(),
    };

    let agent_type = startup_page.agent_type().to_string();
    // Use workspace from startup page (may have been changed via /workspace command)
    let workspace = startup_page.workspace();
    let mut chat_mode = ChatMode::new(config, agent_type, workspace, &agentic_system);
    if let Some(session_id) = restore_session_id {
        chat_mode = chat_mode.with_restore_session(session_id);
    }
    if let Some(prompt) = initial_prompt {
        chat_mode = chat_mode.with_initial_prompt(prompt);
    }
    let _exit_reason = chat_mode.run(Some(terminal))?;

    // 6. Cleanup
    shutdown_mcp_servers().await;
    restore_tool_confirmation(original_skip_confirmation).await;
    println!("Goodbye!");

    Ok(())
}

// ======================== Main ========================

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    
    let log_level = if cli.verbose {
        tracing::Level::DEBUG
    } else {
        tracing::Level::INFO
    };
    
    let is_tui_mode = matches!(cli.command, None | Some(Commands::Chat { .. }));
    let is_acp_mode = matches!(cli.command, Some(Commands::Acp { .. }));
    
    if is_tui_mode {
        use std::fs::OpenOptions;
        
        let log_dir = CliConfig::config_dir().ok()
            .map(|d| d.join("logs"))
            .unwrap_or_else(|| std::env::temp_dir().join("bitfun-cli"));
        
        std::fs::create_dir_all(&log_dir).ok();
        let log_file = log_dir.join("bitfun-cli.log");
        
        if let Ok(file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_file) 
        {
            tracing_subscriber::fmt()
                .with_max_level(log_level)
                .with_writer(move || file.try_clone().unwrap())
                .with_ansi(false)
                .with_target(false)
                .init();
        } else {
            tracing_subscriber::fmt()
                .with_max_level(log_level)
                .with_target(false)
                .init();
        }
    } else if is_acp_mode {
        tracing_subscriber::fmt()
            .with_max_level(log_level)
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .with_target(false)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_max_level(log_level)
            .with_target(false)
            .init();
    }
    
    let config = CliConfig::load().unwrap_or_else(|e| {
        if !is_tui_mode {
            eprintln!("Warning: Failed to load config: {}", e);
            eprintln!("Using default configuration");
        }
        CliConfig::default()
    });
    
    match cli.command {
        Some(Commands::Chat { agent, workspace }) => {
            if let Some(ws) = workspace {
                // Direct chat mode: workspace provided, skip startup page
                let workspace = setup_workspace(&ws);

                let (agentic_system, original_skip_confirmation) =
                    initialize_core_services(true).await?;

                println!("System initialized, starting chat interface...\n");
                std::thread::sleep(std::time::Duration::from_millis(500));

                let mut chat_mode = ChatMode::new(config, agent, workspace, &agentic_system);
                let _exit_reason = chat_mode.run(None)?;

                shutdown_mcp_servers().await;
                restore_tool_confirmation(original_skip_confirmation).await;
            } else {
                // Interactive mode with startup page
                run_interactive(config, agent, ".".to_string()).await?;
            }
        }
        
        Some(Commands::Exec { message, agent, workspace, json: _, output_patch, confirm }) => {
            let workspace_path_resolved = if let Some(ref ws) = workspace {
                use std::path::PathBuf;
                if ws == "." {
                    std::env::current_dir().ok()
                } else {
                    Some(PathBuf::from(ws))
                }
            } else {
                std::env::current_dir().ok()
            };
            
            if let Some(ref ws_path) = workspace_path_resolved {
                tracing::info!("Workspace path set: {:?}", ws_path);
            }
            
            let skip_confirmation = !confirm;
            let (agentic_system, original_skip_confirmation) =
                initialize_core_services(skip_confirmation).await?;
            
            let mut exec_mode = ExecMode::new(
                config, 
                message, 
                agent, 
                &agentic_system,
                workspace_path_resolved,
                output_patch,
            );
            let run_result = exec_mode.run().await;

            shutdown_mcp_servers().await;
            restore_tool_confirmation(original_skip_confirmation).await;

            run_result?;
        }
        
        Some(Commands::Batch { tasks }) => {
            println!("Executing batch tasks...");
            println!("Tasks file: {}", tasks);
            println!("\nWarning: Batch execution feature coming soon");
        }
        
        Some(Commands::Sessions { action }) => {
            handle_session_action(action).await?;
        }
        
        Some(Commands::Config { action }) => {
            handle_config_action(action, &config)?;
        }
        
        Some(Commands::Tool { name, params }) => {
            println!("Invoking tool: {}", name);
            if let Some(p) = params {
                println!("Parameters: {}", p);
            }
            println!("\nWarning: Tool invocation feature coming soon");
        }
        
        Some(Commands::Health) => {
            println!("BitFun CLI is running normally");
            println!("Version: {}", env!("CARGO_PKG_VERSION"));
            println!("Config directory: {:?}", CliConfig::config_dir()?);
        }

        Some(Commands::Acp { workspace }) => {
            let workspace_str = workspace.unwrap_or_else(|| ".".to_string());
            setup_workspace(&workspace_str);

            bitfun_core::service::config::initialize_global_config()
                .await
                .context("Failed to initialize global config service")?;
            tracing::info!("Global config service initialized");

            use bitfun_core::infrastructure::ai::AIClientFactory;
            AIClientFactory::initialize_global()
                .await
                .context("Failed to initialize global AIClientFactory")?;
            tracing::info!("Global AI client factory initialized");

            let agentic_system = agent::agentic_system::init_agentic_system()
                .await
                .context("Failed to initialize agentic system")?;
            tracing::info!("Agentic system initialized");

            bitfun_acp::BitfunAcpRuntime::serve_stdio(agentic_system).await?;
        }
        
        None => {
            // Default: interactive TUI with startup page
            let workspace_str = cli.project
                .map(|p| {
                    if p == "." { p } else {
                        dunce::canonicalize(&p)
                            .map(|abs| abs.to_string_lossy().to_string())
                            .unwrap_or(p)
                    }
                })
                .unwrap_or_else(|| ".".to_string());

            let default_agent = config.behavior.default_agent.clone();
            run_interactive(config, default_agent, workspace_str).await?;
        }
    }
    
    Ok(())
}

async fn handle_session_action(action: SessionAction) -> Result<()> {
    // Initialize core services for session management
    bitfun_core::service::config::initialize_global_config()
        .await
        .expect("Failed to initialize global config service");

    let agentic_system = agent::agentic_system::init_agentic_system()
        .await
        .expect("Failed to initialize agentic system");

    let coordinator = agentic_system.coordinator.clone();
    let workspace_path = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    match action {
        SessionAction::List => {
            let sessions = coordinator.list_sessions(&workspace_path).await?;

            if sessions.is_empty() {
                println!(
                    "No history sessions for current project: {}",
                    workspace_path.display()
                );
                return Ok(());
            }

            println!(
                "History sessions for current project (total {})",
                sessions.len()
            );
            println!("Project: {}\n", workspace_path.display());

            for (i, info) in sessions.iter().enumerate() {
                let last_updated = {
                    let duration = info.last_activity_at
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default();
                    let secs = duration.as_secs() as i64;
                    chrono::DateTime::from_timestamp(secs, 0)
                        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                };

                println!("{}. {} (ID: {})", i + 1, info.session_name, info.session_id);
                println!(
                    "   Agent: {} | Turns: {} | Updated: {}",
                    info.agent_type, info.turn_count, last_updated
                );
                println!();
            }
        }

        SessionAction::Show { id } => {
            let sessions = coordinator.list_sessions(&workspace_path).await?;

            let session_id = if id == "last" {
                sessions
                    .first()
                    .map(|s| s.session_id.clone())
                    .ok_or_else(|| anyhow::anyhow!("No history sessions"))?
            } else {
                id
            };

            // Restore and show session details
            let session = coordinator
                .restore_session(&workspace_path, &session_id)
                .await?;
            let messages = coordinator.get_messages(&session_id).await?;

            println!("Session Details\n");
            println!("Name: {}", session.session_name);
            println!("ID: {}", session.session_id);
            println!("Agent: {}", session.agent_type);
            println!("State: {:?}", session.state);
            println!("Messages: {}", messages.len());
            println!();

            if !messages.is_empty() {
                println!("Recent messages:");
                let recent: Vec<_> = messages.iter().rev().take(5).collect();
                for msg in recent.iter().rev() {
                    let role = format!("{:?}", msg.role);
                    let content_preview = match &msg.content {
                        bitfun_core::agentic::core::message::MessageContent::Text(text) => {
                            text.lines().next().unwrap_or("").to_string()
                        }
                        bitfun_core::agentic::core::message::MessageContent::Multimodal { text, images } => {
                            if text.is_empty() {
                                format!("[{} images]", images.len())
                            } else {
                                text.lines().next().unwrap_or("").to_string()
                            }
                        }
                        bitfun_core::agentic::core::message::MessageContent::Mixed { text, tool_calls, .. } => {
                            if text.is_empty() {
                                format!("[{} tool calls]", tool_calls.len())
                            } else {
                                text.lines().next().unwrap_or("").to_string()
                            }
                        }
                        bitfun_core::agentic::core::message::MessageContent::ToolResult { tool_name, .. } => {
                            format!("[Tool result: {}]", tool_name)
                        }
                    };
                    let preview = if content_preview.len() > 80 {
                        format!("{}...", &content_preview[..77])
                    } else {
                        content_preview
                    };
                    println!("  [{}] {}", role, preview);
                }
            }
        }

        SessionAction::Delete { id } => {
            coordinator.delete_session(&workspace_path, &id).await?;
            println!("Deleted session from current project: {}", id);
        }
    }

    Ok(())
}

fn handle_config_action(action: ConfigAction, config: &CliConfig) -> Result<()> {
    match action {
        ConfigAction::Show => {
            println!("Current Configuration\n");
            println!("Note: AI model configuration is now managed via GlobalConfig");
            println!("View and manage at: Main Menu -> Settings -> AI Model Configuration");
            println!();
            println!("UI Configuration:");
            println!("  Appearance: {}", config.ui.theme);
            println!("  Theme ID: {}", config.ui.theme_id);
            println!("  Color scheme: {}", config.ui.color_scheme);
            println!("  Show tips: {}", config.ui.show_tips);
            println!("  Animation: {}", config.ui.animation);
            println!();
            println!("Behavior Configuration:");
            println!("  Auto save: {}", config.behavior.auto_save);
            println!("  Confirm dangerous: {}", config.behavior.confirm_dangerous);
            println!("  Default Agent: {}", config.behavior.default_agent);
            println!();
            println!("Config file: {:?}", CliConfig::config_path()?);
        }
        
        ConfigAction::Edit => {
            let config_path = CliConfig::config_path()?;
            println!("Config file location: {:?}", config_path);
            println!();
            println!("Please use a text editor to edit the config file:");
            println!("  vi {:?}", config_path);
            println!("  or");
            println!("  code {:?}", config_path);
        }
        
        ConfigAction::Reset => {
            let default_config = CliConfig::default();
            default_config.save()?;
            println!("Reset to default configuration");
        }
    }
    
    Ok(())
}
