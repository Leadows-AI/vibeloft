// All of Vibeloft's data: a single JSON file (studio.json) in the user's app-data folder.
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex};

static CACHE: Mutex<Option<Value>> = Mutex::new(None);

fn empty() -> Value {
    json!({
        "version": 1, "customers": [], "projects": [], "workItems": [], "milestones": [],
        "chats": {}, "timeEntries": [], "links": [],
        "settings": { "theme": "light", "model": "claude-opus-5-5", "projectsRoot": null }
    })
}

/// Vibeloft's data folder: %APPDATA%\Vibeloft on Windows,
/// ~/Library/Application Support/Vibeloft on macOS. VIBE_USER_DATA overrides it (tests).
pub fn user_data_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_default();
    let dir = std::env::var_os("VIBE_USER_DATA").map(PathBuf::from).unwrap_or_else(|| base.join("Vibeloft"));
    let _ = fs::create_dir_all(&dir);
    dir
}

fn data_file() -> PathBuf {
    user_data_dir().join("studio.json")
}

pub fn save(db: Value) -> Value {
    let file = data_file();
    let tmp = file.with_extension("json.tmp");
    // Atomic replace, so a crash never leaves half a file.
    if fs::write(&tmp, serde_json::to_string_pretty(&db).unwrap_or_default()).is_ok() {
        let _ = fs::rename(&tmp, &file);
    }
    *CACHE.lock().unwrap() = Some(db.clone());
    db
}

/// One change at a time: IPC calls run in parallel.
static WRITE: Mutex<()> = Mutex::new(());

pub fn mutate(f: impl FnOnce(&mut Value)) -> Value {
    let _one_at_a_time = WRITE.lock().unwrap();
    let mut db = load();
    f(&mut db);
    save(db)
}

pub fn load() -> Value {
    let mut cache = CACHE.lock().unwrap();
    if let Some(db) = cache.as_ref() {
        return db.clone();
    }
    let file = data_file();
    let mut db = empty();
    if let Ok(text) = fs::read_to_string(&file) {
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(saved)) => {
                for (k, v) in saved {
                    db[k] = v;
                }
            }
            // Keep the unreadable file for recovery and start fresh.
            _ => {
                let _ = fs::copy(&file, file.with_extension(format!("json.corrupt-{}", uuid::Uuid::new_v4())));
            }
        }
    }
    *cache = Some(db.clone());
    db
}

/// A project's local folder, if it has one that exists.
pub fn project_path(project_id: &str) -> Result<PathBuf, String> {
    load()["projects"]
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p["id"] == project_id))
        .and_then(|p| p["localPath"].as_str())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .ok_or_else(|| "This project has no local folder.".to_string())
}
