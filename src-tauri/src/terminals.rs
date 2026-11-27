// Real terminals (ConPTY on Windows, a
// pseudo-terminal on macOS) in each project's folder. They keep running while
// you switch views; the UI re-attaches using the recent output kept here.
use crate::{
    hooks, store,
    util::{self, Args, Res},
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock, Mutex,
    },
    thread,
    time::Duration,
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "term:create" => create(&a.s(0), a.v(1)),
        "term:claudeTask" => start_claude_task(&a.s(0), a.v(1)),
        "term:scripts" => Ok(project_scripts(&a.s(0))),
        "term:list" => Ok(list(&a.s(0))),
        "term:backlog" => Ok(json!(backlog(&a.s(0)))),
        "term:write" => Ok(write(&a.s(0), &a.s(1))),
        "term:resize" => Ok(resize(&a.s(0), a.n(1) as u16, a.n(2) as u16)),
        "term:rename" => Ok(rename(&a.s(0), &a.s(1))),
        "term:setSession" => Ok(set_session(&a.s(0), &a.s(1), &a.s(2))),
        "term:kill" => Ok(kill(&a.s(0))),
        "claude:forgetOpen" => Ok(forget_open(&a.s(0))),
        _ => return None,
    })
}

const MAX_BACKLOG: usize = 400_000; // bytes of recent output kept for re-attaching

struct Term {
    info: Value,
    writer: Box<dyn Write + Send>,
    /// None once the program ended (closing it lets the reader finish on Windows).
    master: Option<Box<dyn MasterPty + Send>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    backlog: String,
}

static TERMS: LazyLock<Mutex<HashMap<String, Term>>> = LazyLock::new(Default::default);

fn shell() -> CommandBuilder {
    if cfg!(windows) {
        let mut c = CommandBuilder::new("powershell.exe");
        c.arg("-NoLogo");
        c
    } else {
        // A login shell picks up the user's PATH (Homebrew, nvm, the claude CLI…).
        let mut c = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
        c.arg("-l");
        c
    }
}

/// A Claude Code conversation (or terminal) id as Claude Code writes them.
pub fn is_session_id(s: &str) -> bool {
    (8..=80).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_claude(cmd: &str) -> bool {
    cmd.strip_prefix("claude").is_some_and(|r| r.is_empty() || r.starts_with(char::is_whitespace))
}

/// Single quotes for the terminal's shell (PowerShell on Windows, sh elsewhere).
fn quote(s: &str) -> String {
    if cfg!(windows) {
        format!("'{}'", s.replace('\'', "''"))
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Claude Code started from Vibeloft uses the model chosen in Settings, unless the command names one.
fn with_model(cmd: &str, model: &str) -> String {
    let safe = !model.is_empty() && model.chars().all(|c| c.is_ascii_alphanumeric() || "_.[]-".contains(c));
    if !is_claude(cmd) || cmd.contains(" --model") || !safe {
        return cmd.into();
    }
    format!("claude --model {model}{}", &cmd[6..])
}

/// Decode what's complete; keep a character split across two reads for the next one.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let s = s.to_owned();
            pending.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let s = String::from_utf8_lossy(&pending[..e.valid_up_to()]).into_owned();
            pending.drain(..e.valid_up_to());
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            s
        }
    }
}

static RESUME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"--resume\s+([A-Za-z0-9_-]{8,80})").unwrap());

pub fn create(project_id: &str, opts: Value) -> Res {
    let db = store::load();
    if !db["projects"].as_array().is_some_and(|ps| ps.iter().any(|p| p["id"] == project_id)) {
        return Err("Project not found".into());
    }
    let cwd = store::project_path(project_id).ok().or_else(dirs::home_dir).unwrap_or_default();

    let id = util::uid();
    let original = opts["command"].as_str().filter(|c| !c.is_empty());
    // Claude Code reports "prompt sent", "needs you" and "finished" back through hooks
    // in a per-terminal settings file (see hooks.rs).
    let mut command = original.map(str::to_owned);
    if let Some(c) = original.filter(|c| is_claude(c)) {
        // Linked projects' folders go in the same settings file rather than as
        // --add-dir: with --add-dir, Claude Code asks about each folder at the
        // start of every session with "No, exit" as the default answer, so
        // pressing Enter quits Claude and your message lands in the shell.
        let (rest, dirs) = take_add_dirs(c);
        if let Some(settings) = hooks::hook_settings_for(&id, &dirs) {
            command = Some(format!("claude --settings {}{}", quote(&settings), &rest[6..]));
        }
    }

    let dim = |k: &str, d: u16| opts[k].as_f64().map_or(d, |n| n as u16);
    let pair = native_pty_system()
        .openpty(PtySize { rows: dim("rows", 30), cols: dim("cols", 100), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = shell();
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Vibeloft");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let title = opts["title"].as_str().filter(|t| !t.is_empty()).map(str::to_owned).unwrap_or_else(|| {
        original.and_then(|c| c.split(' ').next()).unwrap_or("Shell").to_owned()
    });
    let mut info = json!({ "id": id, "projectId": project_id, "title": title, "command": original, "exited": false });
    if let Some(m) = original.and_then(|c| RESUME.captures(c)) {
        info["sessionId"] = json!(m[1]);
    }

    // Type the command into the shell, so you stay in the shell when it ends.
    if let Some(c) = &command {
        let model = db["settings"]["model"].as_str().unwrap_or_default();
        let _ = writer.write_all(format!("{}\r", with_model(c, model)).as_bytes());
    }

    let killer = child.clone_killer();
    TERMS.lock().unwrap().insert(
        id.clone(),
        Term { info: info.clone(), writer, master: Some(pair.master), killer, backlog: String::new() },
    );

    let rid = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        let mut pending = Vec::new();
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            pending.extend_from_slice(&buf[..n]);
            let data = take_utf8(&mut pending);
            if data.is_empty() {
                continue;
            }
            if let Some(t) = TERMS.lock().unwrap().get_mut(&rid) {
                t.backlog.push_str(&data);
                if t.backlog.len() > MAX_BACKLOG {
                    let cut = (t.backlog.len() - MAX_BACKLOG..).find(|&i| t.backlog.is_char_boundary(i)).unwrap();
                    t.backlog.drain(..cut);
                }
            }
            util::emit("term:data", json!({ "id": rid, "data": data }));
        }
    });

    thread::spawn(move || {
        let code = child.wait().map_or(1, |s| s.exit_code());
        // Closing a ConPTY can wait for its output to be read, and the reader needs
        // the lock, so the master is dropped after the lock is released.
        // ponytail: closing right away can drop the last few bytes on Windows; delay it if that shows up.
        let master = TERMS.lock().unwrap().get_mut(&id).and_then(|t| {
            t.info["exited"] = json!(true);
            t.master.take()
        });
        drop(master);
        util::emit("term:exit", json!({ "id": id, "code": code }));
    });

    Ok(info)
}

pub fn list(project_id: &str) -> Value {
    let terms = TERMS.lock().unwrap();
    Value::Array(terms.values().filter(|t| t.info["projectId"] == project_id).map(|t| t.info.clone()).collect())
}

pub fn backlog(id: &str) -> String {
    TERMS.lock().unwrap().get(id).map(|t| t.backlog.clone()).unwrap_or_default()
}

pub fn write(id: &str, data: &str) -> Value {
    if let Some(t) = TERMS.lock().unwrap().get_mut(id) {
        if t.info["exited"] == false {
            let _ = t.writer.write_all(data.as_bytes());
        }
    }
    Value::Null
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Value {
    if let Some(Term { master: Some(m), .. }) = TERMS.lock().unwrap().get(id) {
        if cols > 0 && rows > 0 {
            let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }
    Value::Null
}

pub fn rename(id: &str, title: &str) -> Value {
    let title: String = title.trim().chars().take(60).collect();
    let mut project = None;
    if let Some(t) = TERMS.lock().unwrap().get_mut(id) {
        if !title.is_empty() {
            t.info["title"] = json!(title);
            if t.info["sessionId"].is_string() {
                project = t.info["projectId"].as_str().map(str::to_owned);
            }
        }
    }
    if let Some(p) = project {
        save_open(&p);
    }
    Value::Null
}

/// The Claude Code conversations open in a project's terminals, saved so they
/// can be reopened after Vibeloft restarts.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn save_open(project_id: &str) {
    if QUITTING.load(Ordering::Relaxed) {
        return;
    }
    let open: Vec<Value> = TERMS
        .lock()
        .unwrap()
        .values()
        .filter(|t| t.info["projectId"] == project_id && t.info["exited"] == false && t.info["sessionId"].is_string())
        .map(|t| json!({ "sessionId": t.info["sessionId"], "title": t.info["title"] }))
        .collect();
    store::mutate(|db| {
        if !db["claudeOpen"].is_object() {
            db["claudeOpen"] = json!({});
        }
        db["claudeOpen"][project_id] = Value::Array(open);
    });
}

/// The project a terminal belongs to.
pub fn project_of(id: &str) -> Option<String> {
    TERMS.lock().unwrap().get(id).and_then(|t| t.info["projectId"].as_str().map(str::to_owned))
}

pub fn set_session(id: &str, session_id: &str, title: &str) -> Value {
    let project = {
        let mut terms = TERMS.lock().unwrap();
        let Some(t) = terms.get_mut(id).filter(|_| is_session_id(session_id)) else { return Value::Null };
        if t.info["sessionId"] == session_id && (title.is_empty() || t.info["title"] == title) {
            return Value::Null;
        }
        t.info["sessionId"] = json!(session_id);
        if !title.trim().is_empty() {
            t.info["title"] = json!(title.trim().chars().take(60).collect::<String>());
        }
        t.info["projectId"].as_str().unwrap_or_default().to_owned()
    };
    save_open(&project);
    Value::Null
}

/// Claude Code ended in this terminal; the shell stays. It's no longer an open conversation.
pub fn end_claude(id: &str) {
    let project = TERMS.lock().unwrap().get_mut(id).map(|t| {
        t.info["claudeEnded"] = json!(true);
        if let Some(o) = t.info.as_object_mut() {
            o.remove("sessionId");
        }
        t.info["projectId"].as_str().unwrap_or_default().to_owned()
    });
    if let Some(p) = project {
        save_open(&p);
    }
}

pub fn forget_open(project_id: &str) -> Value {
    store::mutate(|db| {
        if !db["claudeOpen"].is_object() {
            db["claudeOpen"] = json!({});
        }
        db["claudeOpen"][project_id] = json!([]);
    })
}

// Takes the terminal out of the map first and drops it after the lock is released (see the exit thread).
pub fn kill(id: &str) -> Value {
    let t = TERMS.lock().unwrap().remove(id);
    let Some(mut t) = t else { return Value::Null };
    if t.info["exited"] == false {
        let _ = t.killer.kill();
    }
    hooks::remove_hook_settings(id);
    // Closing a tab yourself means you're done with that conversation.
    if t.info["sessionId"].is_string() {
        save_open(t.info["projectId"].as_str().unwrap_or_default());
    }
    Value::Null
}

/// Terminals still running (the close guard asks before closing them).
pub fn running_count() -> usize {
    TERMS.lock().unwrap().values().filter(|t| t.info["exited"] == false).count()
}

/// Close all of a project's terminals (project deleted or archived).
pub fn kill_project(project_id: &str) {
    let ids: Vec<String> =
        TERMS.lock().unwrap().iter().filter(|(_, t)| t.info["projectId"] == project_id).map(|(id, _)| id.clone()).collect();
    for id in ids {
        kill(&id);
    }
}

pub fn kill_all() {
    // Vibeloft is closing: keep the list of open conversations for next time.
    QUITTING.store(true, Ordering::Relaxed);
    let ids: Vec<String> = TERMS.lock().unwrap().keys().cloned().collect();
    for id in ids {
        kill(&id);
    }
}

/// npm scripts from package.json files in the project (root and common sub-folders).
pub fn project_scripts(project_id: &str) -> Value {
    let db = store::load();
    let Some(root) =
        db["projects"].as_array().and_then(|ps| ps.iter().find(|p| p["id"] == project_id)).and_then(|p| p["localPath"].as_str())
    else {
        return json!([]);
    };
    let mut out = vec![];
    for sub in ["", "client", "server", "frontend", "backend", "web", "api", "app", "mobile"] {
        let dir = Path::new(root).join(sub);
        let Ok(text) = fs::read_to_string(dir.join("package.json")) else { continue };
        // Unreadable package.json: skip it.
        let Ok(pkg) = serde_json::from_str::<Value>(&text) else { continue };
        let runner = if dir.join("yarn.lock").exists() {
            "yarn"
        } else if dir.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else {
            "npm run"
        };
        for s in pkg["scripts"].as_object().into_iter().flat_map(|o| o.keys()) {
            let cmd = format!("{runner} {s}");
            out.push(if sub.is_empty() {
                json!({ "label": s, "command": cmd })
            } else {
                json!({ "label": format!("{sub}: {s}"), "command": format!("cd {sub}; {cmd}") })
            });
        }
    }
    Value::Array(out)
}

static ADD_DIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" --add-dir '((?:[^']|''|'\\'')*)'").unwrap());

/// Pull the `--add-dir '<folder>'` parts out of a claude command (quoted as add_dir_args writes them).
pub fn take_add_dirs(command: &str) -> (String, Vec<String>) {
    let mut dirs = vec![];
    let rest = ADD_DIR
        .replace_all(command, |c: &regex::Captures| {
            dirs.push(c[1].replace("'\\''", "'").replace("''", "'"));
            ""
        })
        .into_owned();
    (rest, dirs.into_iter().filter(|d| !d.is_empty() && Path::new(d).exists()).collect())
}

/// `--add-dir` options so Claude can also read (and, with your OK, edit) other folders.
pub fn add_dir_args(dirs: &[String]) -> String {
    dirs.iter().filter(|d| !d.is_empty() && Path::new(d).exists()).map(|d| format!(" --add-dir {}", quote(d))).collect()
}

/// Start Claude Code in a new terminal with a task as its first prompt.
/// The task goes through a temp file so multi-line text survives the shell.
pub fn start_claude_task(project_id: &str, opts: Value) -> Res {
    let file = std::env::temp_dir().join(format!("vibe-task-{}.md", util::uid()));
    let mut prompt = opts["prompt"].as_str().unwrap_or_default().to_owned();
    // Windows PowerShell 5.1 drops embedded double quotes when calling programs.
    if cfg!(windows) {
        prompt = prompt.replace('"', "'");
    }
    fs::write(&file, prompt).map_err(|e| e.to_string())?;
    let add: Vec<String> =
        opts["addDirs"].as_array().map_or(vec![], |a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect());
    let plan = if opts["plan"].as_bool().unwrap_or(false) { " --permission-mode plan" } else { "" };
    let mode = format!("{plan}{}", add_dir_args(&add));
    let path = file.to_string_lossy().into_owned();
    let command = if cfg!(windows) {
        format!("claude{mode} (Get-Content -Raw -Encoding UTF8 {})", quote(&path))
    } else {
        format!("claude{mode} \"$(cat {})\"", quote(&path))
    };
    // The shell reads the file as soon as the command starts.
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(60));
        let _ = fs::remove_file(file);
    });
    create(project_id, json!({ "title": opts["title"], "command": command }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_split_across_reads() {
        let bytes = "é✓".as_bytes(); // 2 + 3 bytes
        let mut p = bytes[..3].to_vec();
        assert_eq!(take_utf8(&mut p), "é");
        assert_eq!(p.len(), 1);
        p.extend_from_slice(&bytes[3..]);
        assert_eq!(take_utf8(&mut p), "✓");
        assert!(p.is_empty());
    }
    #[test]
    fn model_added_only_to_plain_claude() {
        assert_eq!(with_model("claude", "claude-opus-5-5"), "claude --model claude-opus-5-5");
        assert_eq!(with_model("claude --resume x", "m"), "claude --model m --resume x");
        assert_eq!(with_model("claude --model a", "m"), "claude --model a");
        assert_eq!(with_model("claudex", "m"), "claudex");
        assert_eq!(with_model("claude", "m; rm -rf /"), "claude");
    }
    #[test]
    fn add_dirs_round_trip() {
        let dir = std::env::temp_dir().join("vibe it's");
        fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().into_owned();
        let args = add_dir_args(&[d.clone(), "/no/such/folder".into()]);
        assert_eq!(args.matches("--add-dir").count(), 1);
        let (rest, dirs) = take_add_dirs(&format!("claude --permission-mode plan{args} --add-dir '/gone' x"));
        assert_eq!(rest, "claude --permission-mode plan x");
        assert_eq!(dirs, vec![d]);
    }
}
