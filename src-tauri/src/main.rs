// Vibeloft's Tauri backend. The UI calls one command, `ipc`, with a channel name
// (see src/shared/channels.ts). Each module answers its own channels in
// `handle`; channels no module answers return an error.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod account;
mod app_shell;
mod checkpoints;
mod claude;
mod claude_sessions;
mod claude_usage;
mod data;
mod files;
mod fonts;
mod git;
mod github;
mod gitops;
mod hooks;
mod links;
mod mobile;
mod reports;
mod setup;
mod store;
mod templates;
mod terminals;
mod updater;
mod util;

use serde_json::Value;
use std::{thread, time::Duration};
use util::{Args, Res};

type Handler = fn(&str, &Args) -> Option<Res>;

const HANDLERS: &[Handler] = &[
    data::handle,
    app_shell::handle,
    files::handle,
    terminals::handle,
    links::handle,
    fonts::handle,
    reports::handle,
    templates::handle,
    updater::handle,
    git::handle,
    gitops::handle,
    checkpoints::handle,
    github::handle,
    hooks::handle,
    claude::handle,
    claude_sessions::handle,
    claude_usage::handle,
    mobile::handle,
    setup::handle,
    account::handle,
];

fn dispatch(channel: &str, args: &Args) -> Res {
    HANDLERS
        .iter()
        .find_map(|h| h(channel, args))
        .unwrap_or_else(|| Err(format!("Not ported to the Rust backend yet: {channel}")))
}

// Calls run on a blocking thread pool: many start programs (git, gh, claude) and
// wait, and a slow call must never freeze the window or other calls.
#[tauri::command]
async fn ipc(channel: String, args: Vec<Value>) -> Res {
    tauri::async_runtime::spawn_blocking(move || dispatch(&channel, &Args(args))).await.map_err(|e| e.to_string())?
}

/// Drop another Claude Code session's markers we may have inherited,
/// so Claude Code started from Vibeloft doesn't think it's a sub-session of that one.
fn remove_claude_session_markers() {
    const EXACT: &[&str] = &[
        "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_EMIT_STARTUP_TIMING",
        "CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
        "CLAUDE_CODE_ENABLE_TASKS", "CLAUDE_PID", "CLAUDE_EFFORT", "MCP_CONNECTION_NONBLOCKING",
    ];
    const PREFIX: &[&str] = &["CLAUDE_CODE_CHILD_", "CLAUDE_CODE_SESSION_", "CLAUDE_CODE_MESSAGING_", "CLAUDE_AGENT_SDK_"];
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy();
        if EXACT.contains(&k.as_ref()) || PREFIX.iter().any(|p| k.starts_with(p)) {
            std::env::remove_var(k.as_ref());
        }
    }
    // Apps launched from the macOS Dock don't get the shell's PATH: add Homebrew's folders (git.ts).
    if cfg!(target_os = "macos") {
        let path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    }
}

fn main() {
    remove_claude_session_markers();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![ipc])
        .setup(|app| {
            util::set_app(app.handle().clone());
            updater::init();
            app_shell::apply_theme(store::load()["settings"]["theme"].as_str().unwrap_or("light"));
            // Keep each project's Claude usage record current, so history survives Claude Code
            // deleting old conversation files (a little after start, then every 30 min).
            thread::spawn(|| {
                thread::sleep(Duration::from_secs(15));
                loop {
                    claude_usage::record_all_projects();
                    thread::sleep(Duration::from_secs(30 * 60));
                }
            });
            Ok(())
        })
        .on_window_event(app_shell::on_window_event)
        .build(tauri::generate_context!())
        .expect("failed to start Vibeloft")
        .run(|_, e| {
            if let tauri::RunEvent::Exit = e {
                terminals::kill_all();
                account::login_cancel();
                setup::cancel_step();
                hooks::stop_server();
                files::unwatch_all();
                // A downloaded update that wasn't installed yet installs now.
                updater::install();
            }
        });
}
