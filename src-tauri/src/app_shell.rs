// Window and OS glue: theme, opening links and
// folders, clipboard, focus/attention, and the "save before closing" guard.
use crate::util::{self, Args, Res};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Mutex,
    },
    thread,
};
use tauri::{Manager, Theme, UserAttentionType, Window, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "open:url" => {
            let url = a.s(0);
            // Web pages and email links only, never local files or programs.
            if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
                if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
                    return Some(Err(e.to_string()));
                }
            }
            Ok(Value::Null)
        }
        // "" when it worked, otherwise the error text.
        "open:folder" => Ok(json!(tauri_plugin_opener::open_path(a.s(0), None::<&str>).err().map(|e| e.to_string()).unwrap_or_default())),
        // Calls run on a worker thread, so waiting for the dialog here doesn't block the window.
        "folder:pick" => Ok(util::app()
            .dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .map_or(Value::Null, |p| json!(p.to_string_lossy()))),
        "clip:text" => Ok(json!(util::app().clipboard().read_text().unwrap_or_default())),
        "clip:hasImage" => Ok(json!(util::app().clipboard().read_image().is_ok())),
        "app:focus" => {
            if let Some(w) = util::app().get_webview_window("main") {
                if w.is_minimized().unwrap_or(false) {
                    let _ = w.unminimize();
                }
                let _ = w.show();
                let _ = w.set_focus();
            }
            Ok(Value::Null)
        }
        // Flashes the taskbar button until the window is focused (bounces the Dock icon on macOS).
        "app:attention" => {
            if let Some(w) = util::app().get_webview_window("main") {
                if cfg!(target_os = "macos") || !w.is_focused().unwrap_or(false) {
                    let _ = w.request_user_attention(Some(UserAttentionType::Informational));
                }
            }
            Ok(Value::Null)
        }
        "app:dirty" => {
            DIRTY.store(a.n(0).max(0.0) as usize, Ordering::Relaxed);
            Ok(Value::Null)
        }
        "app:savedAll" => {
            if let Some(tx) = SAVED.lock().unwrap().take() {
                let _ = tx.send(a.b(0));
            }
            Ok(Value::Null)
        }
        _ => return None,
    })
}

/// Light, dark or follow Windows/macOS. This also drives `prefers-color-scheme` in the page
/// (the editor, scrollbars, form controls) and the title bar.
pub fn apply_theme(theme: &str) {
    if let Some(w) = util::app().get_webview_window("main") {
        let _ = w.set_theme(match theme {
            "dark" => Some(Theme::Dark),
            "light" => Some(Theme::Light),
            _ => None,
        });
    }
}

// ---------- don't lose work when the window closes ----------
static DIRTY: AtomicUsize = AtomicUsize::new(0);
static ALLOW_CLOSE: AtomicBool = AtomicBool::new(false);
/// Waits for the UI's answer to "app:saveAll".
static SAVED: Mutex<Option<mpsc::Sender<bool>>> = Mutex::new(None);

/// Window events (the close guard lives here).
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    if ALLOW_CLOSE.load(Ordering::Relaxed) {
        return;
    }
    let dirty = DIRTY.load(Ordering::Relaxed);
    let running = crate::terminals::running_count();
    if dirty == 0 && running == 0 {
        return;
    }
    api.prevent_close();
    // The dialog waits for an answer: never on the event loop thread.
    let window = window.clone();
    thread::spawn(move || ask_before_close(window, dirty, running));
}

fn ask_before_close(window: Window, dirty: usize, running: usize) {
    let mut lines = vec![];
    if dirty > 0 {
        lines.push(format!("{dirty} file{} unsaved changes.", if dirty == 1 { " has" } else { "s have" }));
    }
    if running > 0 {
        lines.push(format!("{running} terminal{} still running (Claude Code, dev servers…) and will be stopped.", if running == 1 { " is" } else { "s are" }));
    }
    let buttons: &[&str] = if dirty > 0 { &["Save all and close", "Don't save", "Cancel"] } else { &["Close anyway", "Cancel"] };
    let message = if dirty > 0 { "Save your changes before closing?" } else { "Close Vibeloft?" };
    let b = |i: usize| buttons[i].to_string();
    let answer = window
        .dialog()
        .message(format!("{message}\n\n{}", lines.join("\n")))
        .title("Vibeloft")
        .kind(MessageDialogKind::Warning)
        .parent(&window)
        .buttons(if dirty > 0 { MessageDialogButtons::YesNoCancelCustom(b(0), b(1), b(2)) } else { MessageDialogButtons::OkCancelCustom(b(0), b(1)) })
        .blocking_show_with_result();
    let cancel = buttons.len() - 1;
    let choice = match answer {
        MessageDialogResult::Yes | MessageDialogResult::Ok => 0,
        MessageDialogResult::No => 1,
        MessageDialogResult::Custom(label) => buttons.iter().position(|x| *x == label).unwrap_or(cancel),
        MessageDialogResult::Cancel => cancel,
    };
    if choice == cancel {
        return;
    }
    if dirty > 0 && choice == 0 {
        let (tx, rx) = mpsc::channel();
        *SAVED.lock().unwrap() = Some(tx);
        util::emit("app:saveAll", Value::Null);
        if !rx.recv().unwrap_or(false) {
            window
                .dialog()
                .message("Some files could not be saved, so the app stayed open.")
                .kind(MessageDialogKind::Error)
                .parent(&window)
                .blocking_show();
            return;
        }
    }
    ALLOW_CLOSE.store(true, Ordering::Relaxed);
    let _ = window.close();
}
