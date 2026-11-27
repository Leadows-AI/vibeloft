// Updates on Tauri's updater. Each GitHub release of Leadows-AI/vibeloft carries
// a latest.json manifest (version, installer URL, signature); the endpoint in tauri.conf.json reads the newest release's copy.
// The app checks it, downloads the installer and
// verifies its signature, then offers "Restart to update"; if ignored, it
// installs the next time Vibeloft closes. Automatic checks (shortly after start
// and every 4 hours) can be turned off in Settings; "Check now" always works.
// Development runs never update.
use crate::{
    store,
    util::{self, now, Args, Res},
};
use serde_json::{json, Value};
use std::{
    sync::{LazyLock, Mutex},
    thread,
    time::Duration,
};
use tauri::async_runtime::block_on;
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);
const DEV: bool = cfg!(debug_assertions);

static STATUS: LazyLock<Mutex<Value>> =
    LazyLock::new(|| Mutex::new(json!({ "state": if DEV { "dev" } else { "idle" }, "current": env!("CARGO_PKG_VERSION") })));
/// The downloaded update, waiting to be installed.
static READY: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);

pub fn handle(ch: &str, _a: &Args) -> Option<Res> {
    Some(match ch {
        "update:status" => Ok(STATUS.lock().unwrap().clone()),
        "update:check" => {
            check();
            Ok(Value::Null)
        }
        "update:install" => {
            install();
            Ok(Value::Null)
        }
        _ => return None,
    })
}

fn set(next: Value) {
    let mut s = STATUS.lock().unwrap();
    for (k, v) in next.as_object().into_iter().flatten() {
        s[k] = v.clone();
    }
    util::emit("update:status", s.clone());
}

fn state() -> String {
    STATUS.lock().unwrap()["state"].as_str().unwrap_or_default().to_string()
}

fn friendly(e: impl ToString) -> String {
    let msg = e.to_string();
    if msg.contains("dns") || msg.contains("connect") || msg.contains("timed out") {
        return "Could not reach the update server (offline?).".into();
    }
    msg.lines().next().unwrap_or_default().chars().take(200).collect()
}

/// Start automatic checks (main.rs calls this once the app is up).
pub fn init() {
    if DEV {
        return;
    }
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(8));
        loop {
            // The setting is read on every tick, so turning it on or off needs no restart.
            if store::load()["settings"]["autoUpdate"] != false {
                check();
            }
            thread::sleep(CHECK_EVERY);
        }
    });
}

pub fn check() {
    let st = state();
    if DEV || st == "checking" || st == "downloading" || st == "ready" {
        return;
    }
    set(json!({ "state": "checking", "message": null }));
    let found = util::app().updater().and_then(|u| block_on(u.check()));
    let update = match found {
        Ok(Some(u)) => u,
        // The newest release has no latest.json (e.g. it came before this version): nothing newer to install.
        // Being offline is a different error and still shows as one.
        Ok(None) | Err(tauri_plugin_updater::Error::ReleaseNotFound) => return set(json!({ "state": "latest", "checkedAt": now() })),
        Err(e) => return set(json!({ "state": "error", "message": friendly(e), "checkedAt": now() })),
    };
    set(json!({ "state": "downloading", "available": update.version, "percent": 0 }));
    let mut got = 0usize;
    let mut last = 0u64;
    let bytes = block_on(update.download(
        |chunk, total| {
            got += chunk;
            if let Some(t) = total.filter(|t| *t > 0) {
                let pct = (got as u64 * 100 / t).min(100);
                if pct != last {
                    last = pct;
                    set(json!({ "percent": pct }));
                }
            }
        },
        || {},
    ));
    match bytes {
        Ok(b) => {
            set(json!({ "state": "ready", "available": update.version, "percent": 100 }));
            *READY.lock().unwrap() = Some((update, b));
        }
        Err(e) => set(json!({ "state": "error", "message": friendly(e), "checkedAt": now() })),
    }
}

/// Close Vibeloft, install the downloaded update and start it again.
pub fn install() {
    let ready = READY.lock().unwrap().take();
    if let Some((update, bytes)) = ready {
        // On Windows the installer takes over and Vibeloft exits; it starts again when done.
        match update.install(bytes) {
            Ok(()) => util::app().restart(),
            Err(e) => set(json!({ "state": "error", "message": friendly(e) })),
        }
    }
}
