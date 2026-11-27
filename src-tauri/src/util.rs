// Helpers every module shares: call arguments, running programs, events to
// the UI, and the small store helpers (now/uid/upsert) the TS code used.
use serde_json::Value;
use std::{
    ffi::OsStr,
    io::Write,
    path::Path,
    process::{Command, Stdio},
    sync::OnceLock,
};
use tauri::{AppHandle, Emitter};

pub type Res = Result<Value, String>;

/// The arguments of one UI call, in the order the TS API passes them.
pub struct Args(pub Vec<Value>);

impl Args {
    pub fn v(&self, i: usize) -> Value {
        self.0.get(i).cloned().unwrap_or(Value::Null)
    }
    /// A string argument ("" if missing or not a string).
    pub fn s(&self, i: usize) -> String {
        self.0.get(i).and_then(Value::as_str).unwrap_or_default().to_string()
    }
    pub fn opt_s(&self, i: usize) -> Option<String> {
        self.0.get(i).and_then(Value::as_str).map(str::to_string)
    }
    pub fn n(&self, i: usize) -> f64 {
        self.0.get(i).and_then(Value::as_f64).unwrap_or(0.0)
    }
    pub fn b(&self, i: usize) -> bool {
        self.0.get(i).and_then(Value::as_bool).unwrap_or(false)
    }
    /// A string-array argument (non-strings skipped).
    pub fn strs(&self, i: usize) -> Vec<String> {
        self.0.get(i).and_then(Value::as_array).map_or(vec![], |a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
    }
}

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn app() -> &'static AppHandle {
    APP.get().expect("the app has not started")
}

/// Send an event to the UI (the TS `onXxx` listeners in src/shared/channels.ts EVENTS).
pub fn emit(channel: &str, payload: Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit(channel, payload);
    }
}

/// A Command that never flashes a console window on Windows (Node's windowsHide).
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// Run a program to completion and return its stdout, like git.ts `run`: on failure
/// the error is its stderr (or the spawn error), trimmed.
pub fn run<S: AsRef<OsStr>>(program: &str, args: &[S], cwd: Option<&Path>, input: Option<&str>) -> Result<String, String> {
    let mut c = command(program);
    c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    c.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    let mut child = c.spawn().map_err(|e| format!("{program}: {e}"))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(text.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("{program} exited with {}", out.status) } else { err })
    }
}

/// The current time as JS `new Date().toISOString()` writes it.
pub fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Replace the item with the same "id" in a JSON array, or append it.
pub fn upsert(list: &mut Value, item: Value) {
    if !list.is_array() {
        *list = Value::Array(vec![]);
    }
    let arr = list.as_array_mut().unwrap();
    match arr.iter().position(|x| x["id"] == item["id"]) {
        Some(i) => arr[i] = item,
        None => arr.push(item),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn upsert_replaces_or_appends() {
        let mut l = json!([{ "id": "a", "v": 1 }]);
        upsert(&mut l, json!({ "id": "a", "v": 2 }));
        upsert(&mut l, json!({ "id": "b" }));
        assert_eq!(l, json!([{ "id": "a", "v": 2 }, { "id": "b" }]));
    }
    #[test]
    fn now_looks_like_js_iso() {
        let n = now();
        assert_eq!(n.len(), 24);
        assert!(n.ends_with('Z') && n.as_bytes()[10] == b'T');
    }
}
