// File access for the Files and Environment tabs. Every path
// the UI sends is relative to the project folder and may never reach outside it.
use crate::{
    store,
    util::{self, Args, Res},
};
use base64::Engine;
use notify::{RecursiveMode, Watcher};
use regex::{NoExpand, Regex};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    sync::{mpsc, LazyLock, Mutex},
    thread,
    time::{Duration, UNIX_EPOCH},
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "files:list" => list_dir(&a.s(0), &a.s(1)),
        "files:read" => read(&a.s(0), &a.s(1)),
        "files:write" => write(&a.s(0), &a.s(1), &a.s(2), a.0.get(3).and_then(Value::as_f64).unwrap_or(-1.0)),
        "files:reveal" => reveal(&a.s(0), &a.s(1)),
        "files:env" => env_files(&a.s(0)),
        "files:find" => find_files(&a.s(0), &a.s(1), 200),
        "files:ignore" => ignore_in_git(&a.s(0), &a.s(1)),
        "files:create" => create_entry(&a.s(0), &a.s(1), &a.s(2)),
        "files:rename" => rename_entry(&a.s(0), &a.s(1), &a.s(2)),
        "files:delete" => delete_entry(&a.s(0), &a.s(1)),
        "files:all" => list_all_files(&a.s(0)),
        "files:search" => search_text(&a.s(0), &a.s(1), &opts(&a.v(2))),
        "files:replace" => replace_text(&a.s(0), &a.strs(1), &a.s(2), &a.s(3), &opts(&a.v(4))),
        "files:prettier" => prettier_config(&a.s(0)),
        "files:watch" => watch_project(&a.s(0)).map(|_| Value::Null),
        "files:unwatch" => Ok(unwatch_project(&a.s(0), false)),
        _ => return None,
    })
}

const HIDDEN: &[&str] = &[".git", ".DS_Store", "Thumbs.db"];
const HEAVY: &[&str] = &[
    "node_modules", "dist", "build", "out", ".next", ".expo", ".turbo", "coverage", "Pods", ".gradle", ".idea", ".vscode",
    "__pycache__", ".venv", "venv",
];
const MAX_TEXT: u64 = 1024 * 1024;
const MAX_IMAGE: u64 = 8 * 1024 * 1024;

/// Join `rel` onto `root`, refusing absolute paths and `..` anywhere.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err("That path is outside the project folder.".into());
    }
    Ok(root.join(rel))
}

fn is_env(name: &str) -> bool {
    name == ".env" || name.starts_with(".env.") || name.ends_with(".env")
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn image_type(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

pub fn list_dir(project_id: &str, rel: &str) -> Res {
    let root = store::project_path(project_id)?;
    let dir = inside(&root, rel)?;
    let mut entries: Vec<(bool, String, Value)> = Vec::new();
    for it in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = it.file_name().to_string_lossy().into_owned();
        if HIDDEN.contains(&name.as_str()) {
            continue;
        }
        let is_dir = it.file_type().is_ok_and(|t| t.is_dir());
        let size = if is_dir { 0 } else { it.metadata().map_or(0, |m| m.len()) };
        let rel_path = it.path().strip_prefix(&root).unwrap_or(&it.path()).to_string_lossy().replace('\\', "/");
        let v = json!({
            "name": name, "rel": rel_path, "type": if is_dir { "dir" } else { "file" }, "size": size,
            "heavy": is_dir && HEAVY.contains(&name.as_str()), "env": !is_dir && is_env(&name)
        });
        entries.push((is_dir, name.to_lowercase(), v));
    }
    // Folders first, then by name, case-insensitive.
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    Ok(Value::Array(entries.into_iter().map(|e| e.2).collect()))
}

pub fn read(project_id: &str, rel: &str) -> Res {
    let full = inside(&store::project_path(project_id)?, rel)?;
    let meta = fs::metadata(&full).map_err(|e| e.to_string())?;
    let size = meta.len();
    if let Some(mime) = image_type(&full) {
        if size > MAX_IMAGE {
            return Ok(json!({ "kind": "too-large", "size": size }));
        }
        let data = fs::read(&full).map_err(|e| e.to_string())?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        return Ok(json!({ "kind": "image", "size": size, "dataUrl": format!("data:{mime};base64,{b64}") }));
    }
    if size > MAX_TEXT {
        return Ok(json!({ "kind": "too-large", "size": size }));
    }
    let buf = fs::read(&full).map_err(|e| e.to_string())?;
    // A NUL byte in the first 8 KB means it's not a text file.
    if buf.iter().take(8192).any(|&b| b == 0) {
        return Ok(json!({ "kind": "binary", "size": size }));
    }
    Ok(json!({ "kind": "text", "size": size, "text": String::from_utf8_lossy(&buf), "modified": mtime_ms(&meta) }))
}

pub fn write(project_id: &str, rel: &str, text: &str, expected_modified: f64) -> Res {
    let full = inside(&store::project_path(project_id)?, rel)?;
    let meta = fs::metadata(&full).map_err(|e| e.to_string())?;
    // Don't overwrite changes Claude or another editor made since the file was opened.
    // expected_modified < 0 means the user chose to overwrite anyway.
    if expected_modified >= 0.0 && (mtime_ms(&meta) - expected_modified).abs() > 1.0 {
        return Err("This file changed on disk since you opened it. Reload it, then make your edit again.".into());
    }
    fs::write(&full, text).map_err(|e| e.to_string())?;
    Ok(json!(mtime_ms(&fs::metadata(&full).map_err(|e| e.to_string())?)))
}

fn rel_of(root: &Path, full: &Path) -> String {
    full.strip_prefix(root).unwrap_or(full).to_string_lossy().replace('\\', "/")
}

fn root(project_id: &str) -> Result<PathBuf, String> {
    store::project_path(project_id)
}

pub fn reveal(project_id: &str, rel: &str) -> Res {
    let full = inside(&root(project_id)?, rel)?;
    tauri_plugin_opener::reveal_item_in_dir(full).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

// ---------- .env files ----------

const ENV_DIRS: &[&str] = &["", "client", "server", "frontend", "backend", "web", "api", "app", "mobile", "apps", "packages"];

static ENV_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$").unwrap());
static INLINE_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+#.*$").unwrap());

fn parse_env(text: &str) -> Vec<Value> {
    let mut out = vec![];
    for (i, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(m) = ENV_LINE.captures(line) else { continue };
        let mut value = m[2].to_string();
        let q = value.chars().next();
        match (q, q.and_then(|q| value.rfind(q))) {
            (Some('"' | '\'' | '`'), Some(l)) if l > 0 => value = value[1..l].to_string(),
            _ => value = INLINE_COMMENT.replace(&value, "").into_owned(), // inline comment
        }
        out.push(json!({ "key": &m[1], "value": value, "line": i + 1 }));
    }
    out
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    util::run("git", args, Some(root), None)
}

/// Some(true) = ignored, Some(false) = not ignored, None = not a git repo / unknown.
fn git_ignored(root: &Path, rel: &str) -> Option<bool> {
    match git(root, &["check-ignore", "-q", rel]) {
        Ok(_) => Some(true),
        // check-ignore exits 1 with no output when the file is NOT ignored.
        Err(e) if e.starts_with("git exited with") => Some(false),
        Err(_) => None,
    }
}

fn is_git_repo(root: &Path) -> bool {
    git(root, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

fn is_tracked(root: &Path, rel: &str) -> bool {
    git(root, &["ls-files", "--", rel]).is_ok_and(|o| !o.trim().is_empty())
}

static EXAMPLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)example|sample|template|defaults?").unwrap());

pub fn env_files(project_id: &str) -> Res {
    let root = root(project_id)?;
    let git = is_git_repo(&root);
    let mut found = vec![];
    for sub in ENV_DIRS {
        let dir = root.join(sub);
        let Ok(items) = fs::read_dir(&dir) else { continue };
        let mut names: Vec<String> = items
            .flatten()
            .filter(|d| d.file_type().is_ok_and(|t| t.is_file()))
            .map(|d| d.file_name().to_string_lossy().into_owned())
            .filter(|n| is_env(n))
            .collect();
        names.sort();
        for name in names {
            let full = dir.join(&name);
            let rel = rel_of(&root, &full);
            let meta = fs::metadata(&full).map_err(|e| e.to_string())?;
            if meta.len() > MAX_TEXT {
                continue;
            }
            let text = fs::read_to_string(&full).map_err(|e| e.to_string())?;
            found.push(json!({
                "rel": rel, "isExample": EXAMPLE.is_match(&name), "entries": parse_env(&text),
                "gitIgnored": if git { git_ignored(&root, &rel) } else { None },
                "tracked": git && is_tracked(&root, &rel), "modified": mtime_ms(&meta)
            }));
        }
    }
    Ok(Value::Array(found))
}

fn skipped(name: &str) -> bool {
    HIDDEN.contains(&name) || HEAVY.contains(&name)
}

/// Find files by name anywhere in the project (skips node_modules and other generated folders).
pub fn find_files(project_id: &str, query: &str, limit: usize) -> Res {
    let root = root(project_id)?;
    let q = query.trim().to_lowercase();
    let mut out = vec![];
    if q.is_empty() {
        return Ok(json!(out));
    }
    let mut queue = VecDeque::from([root.clone()]);
    let mut visited = 0;
    while out.len() < limit && visited < 20_000 {
        let Some(dir) = queue.pop_front() else { break };
        let Ok(items) = fs::read_dir(&dir) else { continue };
        for it in items.flatten() {
            visited += 1;
            let name = it.file_name().to_string_lossy().into_owned();
            if skipped(&name) {
                continue;
            }
            let full = it.path();
            let rel = rel_of(&root, &full);
            if it.file_type().is_ok_and(|t| t.is_dir()) {
                queue.push_back(full);
            } else if rel.to_lowercase().contains(&q) {
                out.push(json!({ "name": name, "rel": rel, "type": "file", "size": 0, "heavy": false, "env": is_env(&name) }));
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    Ok(json!(out))
}

/// Add an env file to the project's root .gitignore so it is never committed.
pub fn ignore_in_git(project_id: &str, rel: &str) -> Res {
    let root = root(project_id)?;
    inside(&root, rel)?;
    let file = root.join(".gitignore");
    let current = fs::read_to_string(&file).unwrap_or_default();
    let line = format!("/{rel}");
    if current.split('\n').any(|l| l.strip_suffix('\r').unwrap_or(l) == line) {
        return Ok(Value::Null);
    }
    let prefix = if !current.is_empty() && !current.ends_with('\n') { "\n" } else { "" };
    fs::write(&file, format!("{current}{prefix}\n# Secrets (added by Vibeloft)\n{line}\n")).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

// ---------- create / rename / delete ----------

/// `full` is the project folder itself ("" or ".").
fn is_root(root: &Path, full: &Path) -> bool {
    full.strip_prefix(root).is_ok_and(|r| r.components().all(|c| c == Component::CurDir))
}

pub fn create_entry(project_id: &str, rel: &str, kind: &str) -> Res {
    let root = root(project_id)?;
    let full = inside(&root, rel)?;
    if rel.trim().is_empty() || is_root(&root, &full) {
        return Err("Enter a name.".into());
    }
    if full.exists() {
        return Err(format!("\"{rel}\" already exists."));
    }
    if kind == "dir" {
        fs::create_dir_all(&full).map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::OpenOptions::new().write(true).create_new(true).open(&full).map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}

pub fn rename_entry(project_id: &str, from: &str, to: &str) -> Res {
    let root = root(project_id)?;
    let src = inside(&root, from)?;
    let dst = inside(&root, to)?;
    if is_root(&root, &src) || is_root(&root, &dst) {
        return Err("Cannot rename the project folder.".into());
    }
    if !src.exists() {
        return Err(format!("\"{from}\" no longer exists."));
    }
    if dst.exists() && src.to_string_lossy().to_lowercase() != dst.to_string_lossy().to_lowercase() {
        return Err(format!("\"{to}\" already exists."));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

/// Moves to the Recycle Bin / Trash, so a mistake can be undone.
pub fn delete_entry(project_id: &str, rel: &str) -> Res {
    let root = root(project_id)?;
    let full = inside(&root, rel)?;
    if is_root(&root, &full) {
        return Err("Cannot delete the project folder.".into());
    }
    trash::delete(&full).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

// ---------- list / search across the project ----------

/// Visit every file (breadth first, by name), skipping generated folders. `visit` returns false to stop.
fn walk(root: &Path, mut visit: impl FnMut(&Path, String) -> bool) {
    const MAX_FILES: usize = 30_000;
    let mut queue = VecDeque::from([root.to_path_buf()]);
    let mut count = 0;
    while let Some(dir) = queue.pop_front() {
        let Ok(items) = fs::read_dir(&dir) else { continue };
        let mut items: Vec<_> = items.flatten().map(|it| (it.file_name().to_string_lossy().into_owned(), it)).collect();
        items.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then_with(|| a.0.cmp(&b.0)));
        for (name, it) in items {
            if skipped(&name) {
                continue;
            }
            let Ok(t) = it.file_type() else { continue };
            let full = it.path();
            if t.is_dir() {
                queue.push_back(full);
            } else if t.is_file() {
                count += 1;
                if count > MAX_FILES || !visit(&full, rel_of(root, &full)) {
                    return;
                }
            }
        }
    }
}

/// Every file path in the project (for Ctrl+P), skipping generated folders.
pub fn list_all_files(project_id: &str) -> Res {
    let root = root(project_id)?;
    let mut out = vec![];
    walk(&root, |_, rel| {
        out.push(rel);
        true
    });
    Ok(json!(out))
}

const TEXT_SEARCH_MAX_FILE: u64 = 1024 * 1024;
const TEXT_SEARCH_MAX_MATCHES: usize = 2000;

struct SearchOptions {
    case_sensitive: bool,
    regex: bool,
    whole_word: bool,
}

fn opts(v: &Value) -> SearchOptions {
    let b = |k: &str| v[k].as_bool().unwrap_or(false);
    SearchOptions { case_sensitive: b("caseSensitive"), regex: b("regex"), whole_word: b("wholeWord") }
}

// ponytail: Rust regex syntax, not JavaScript's (no lookaround or backreferences; replacement
// `$1a` means group "1a", write `${1}a`); such patterns show the regex error. Swap in fancy-regex if needed.
fn make_matcher(query: &str, o: &SearchOptions) -> Result<Regex, String> {
    let mut src = if o.regex { query.to_string() } else { regex::escape(query) };
    if o.whole_word {
        src = format!(r"\b(?:{src})\b");
    }
    if !o.case_sensitive {
        src = format!("(?i){src}");
    }
    Regex::new(&src).map_err(|e| e.to_string())
}

/// Length in UTF-16 units, the way the UI (JavaScript) counts columns.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// One file's matches as the UI expects them (1-based line and column), counting into `total`.
fn line_matches(text: &str, re: &Regex, total: &mut usize) -> Vec<Value> {
    let mut matches = vec![];
    for (i, raw) in text.split('\n').enumerate() {
        if *total >= TEXT_SEARCH_MAX_MATCHES {
            break;
        }
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let mut shown = String::new();
        for m in re.find_iter(line) {
            if shown.is_empty() {
                let mut n = 0;
                shown = line.chars().take_while(|c| {
                    n += c.len_utf16();
                    n <= 300
                }).collect();
            }
            matches.push(json!({
                "line": i + 1, "col": js_len(&line[..m.start()]) + 1, "length": js_len(m.as_str()).max(1), "text": shown
            }));
            *total += 1;
            if *total >= TEXT_SEARCH_MAX_MATCHES {
                break;
            }
        }
    }
    matches
}

fn name_of(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

fn search_text(project_id: &str, query: &str, o: &SearchOptions) -> Res {
    let root = root(project_id)?;
    if query.is_empty() {
        return Ok(json!({ "results": [], "truncated": false }));
    }
    let re = make_matcher(query, o)?;
    let mut results = vec![];
    let mut total = 0;
    let mut truncated = false;
    walk(&root, |full, rel| {
        if is_env(name_of(&rel)) {
            return true; // never search secrets
        }
        if fs::metadata(full).map_or(true, |m| m.len() > TEXT_SEARCH_MAX_FILE) {
            return true;
        }
        let Ok(buf) = fs::read(full) else { return true };
        if buf.iter().take(8192).any(|&b| b == 0) {
            return true;
        }
        let matches = line_matches(&String::from_utf8_lossy(&buf), &re, &mut total);
        if !matches.is_empty() {
            results.push(json!({ "rel": rel, "matches": matches }));
        }
        if total >= TEXT_SEARCH_MAX_MATCHES {
            truncated = true;
            return false;
        }
        true
    });
    Ok(json!({ "results": results, "truncated": truncated }))
}

fn replace_text(project_id: &str, files: &[String], query: &str, replacement: &str, o: &SearchOptions) -> Res {
    let root = root(project_id)?;
    let re = make_matcher(query, o)?;
    let mut changed = 0;
    for rel in files {
        if is_env(name_of(rel)) {
            continue;
        }
        let full = inside(&root, rel)?;
        let before = fs::read_to_string(&full).map_err(|e| e.to_string())?;
        // With regex on, $1-style groups work; otherwise the text is inserted literally.
        let after = if o.regex { re.replace_all(&before, replacement) } else { re.replace_all(&before, NoExpand(replacement)) };
        if after != before {
            fs::write(&full, after.as_bytes()).map_err(|e| e.to_string())?;
            changed += 1;
        }
    }
    Ok(json!(changed))
}

// ---------- Prettier config ----------

/// JavaScript truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false)) && v.as_f64() != Some(0.0) && v.as_str() != Some("")
}

/// The project's Prettier settings; found=false if the project doesn't use Prettier.
pub fn prettier_config(project_id: &str) -> Res {
    let root = root(project_id)?;
    for name in [".prettierrc", ".prettierrc.json"] {
        let f = root.join(name);
        if f.exists() {
            let options = fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
            // YAML form: use Prettier defaults
            return Ok(json!({ "found": true, "options": options.unwrap_or_else(|| json!({})) }));
        }
    }
    let others = [
        ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs",
        "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
    ];
    if others.iter().any(|n| root.join(n).exists()) {
        return Ok(json!({ "found": true, "options": {} }));
    }
    // No package.json: not found.
    if let Some(pkg) = fs::read_to_string(root.join("package.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        if pkg["prettier"].is_object() {
            return Ok(json!({ "found": true, "options": pkg["prettier"] }));
        }
        if truthy(&pkg["prettier"]) || truthy(&pkg["devDependencies"]["prettier"]) || truthy(&pkg["dependencies"]["prettier"]) {
            return Ok(json!({ "found": true, "options": {} }));
        }
    }
    Ok(json!({ "found": false, "options": {} }))
}

// ---------- watching for changes on disk ----------

struct Watch {
    _watcher: notify::RecommendedWatcher,
    refs: u32,
}

static WATCHERS: LazyLock<Mutex<HashMap<String, Watch>>> = LazyLock::new(Default::default);

static GIT_STATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\.git/(index|HEAD|ORIG_HEAD|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|packed-refs)$|^\.git/refs/(heads|remotes|tags)/|^\.git/rebase-(merge|apply)$").unwrap()
});

fn is_git_state_file(rel: &str) -> bool {
    !rel.ends_with(".lock") && GIT_STATE.is_match(rel)
}

/// Whether a change at `rel` is worth telling the UI about.
fn wanted(rel: &str) -> bool {
    // Git state the Git tab shows: the index, the current branch, branch tips
    // (commits, merges, pulls) and remote-tracking refs (pushes, fetches).
    // Objects, logs and lock files are noise.
    let parts: Vec<&str> = rel.split('/').collect();
    // The project's own .git, or one in an app folder (a project can hold one repository per app).
    let git_meta = match parts.iter().position(|p| *p == ".git") {
        Some(g @ (0 | 1)) => is_git_state_file(&parts[g..].join("/")),
        _ => false,
    };
    git_meta || !parts.iter().any(|p| skipped(p))
}

pub fn watch_project(project_id: &str) -> Result<(), String> {
    let mut watchers = WATCHERS.lock().unwrap();
    if let Some(w) = watchers.get_mut(project_id) {
        w.refs += 1;
        return Ok(());
    }
    let root = root(project_id)?;
    // None = the watcher failed.
    let (tx, rx) = mpsc::channel::<Option<String>>();
    let r = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
        Ok(e) if !e.kind.is_access() => {
            for p in e.paths {
                let rel = rel_of(&r, &p);
                if !rel.is_empty() && wanted(&rel) {
                    let _ = tx.send(Some(rel));
                }
            }
        }
        Ok(_) => {}
        Err(_) => {
            let _ = tx.send(None);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    watchers.insert(project_id.to_string(), Watch { _watcher: watcher, refs: 1 });
    // Collect changes until 250 ms pass without one, then send them in one event.
    // The thread ends when the watcher is dropped (its sender goes with it).
    let id = project_id.to_string();
    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut pending = HashSet::new();
            let mut failed = false;
            let mut next = Ok(first);
            loop {
                match next {
                    Ok(Some(rel)) => {
                        pending.insert(rel);
                    }
                    Ok(None) => failed = true,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
                next = rx.recv_timeout(Duration::from_millis(250));
            }
            if !pending.is_empty() {
                util::emit("files:changed", json!({ "projectId": id, "paths": pending.into_iter().collect::<Vec<_>>() }));
            }
            if failed {
                unwatch_project(&id, true);
                return;
            }
        }
    });
    Ok(())
}

pub fn unwatch_project(project_id: &str, force: bool) -> Value {
    let mut watchers = WATCHERS.lock().unwrap();
    let done = watchers.get_mut(project_id).is_some_and(|w| {
        w.refs = w.refs.saturating_sub(1);
        force || w.refs == 0
    });
    // Closed after the lock is released.
    let w = if done { watchers.remove(project_id) } else { None };
    drop(watchers);
    drop(w);
    Value::Null
}

/// Stop every project folder watcher (app exit).
pub fn unwatch_all() {
    let all: Vec<Watch> = WATCHERS.lock().unwrap().drain().map(|(_, w)| w).collect();
    drop(all);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn env_parsing() {
        let e = parse_env("# c\r\nexport A=1 # note\r\nB=\"x # y\"\n\nC='q'\nbad line\nD=");
        assert_eq!(
            Value::Array(e),
            json!([
                { "key": "A", "value": "1", "line": 2 },
                { "key": "B", "value": "x # y", "line": 3 },
                { "key": "C", "value": "q", "line": 5 },
                { "key": "D", "value": "", "line": 7 }
            ])
        );
    }
    #[test]
    fn search_columns_and_options() {
        let mut total = 0;
        let re = make_matcher("a.b", &SearchOptions { case_sensitive: false, regex: false, whole_word: false }).unwrap();
        let m = line_matches("é A.B a.b\r\naxb", &re, &mut total);
        assert_eq!(total, 2);
        assert_eq!((m[0]["col"].as_u64(), m[1]["col"].as_u64()), (Some(3), Some(7)));
        assert_eq!(m[0]["text"], "é A.B a.b");
        let re = make_matcher("cat", &SearchOptions { case_sensitive: true, regex: false, whole_word: true }).unwrap();
        assert_eq!(line_matches("cat Cat concat", &re, &mut 0).len(), 1);
    }
    #[test]
    fn watch_filter() {
        assert!(wanted("src/a.ts"));
        assert!(!wanted("node_modules/x/y.js"));
        assert!(wanted(".git/index"));
        assert!(wanted("app/.git/refs/heads/main"));
        assert!(!wanted(".git/objects/ab/cd"));
        assert!(!wanted(".git/index.lock"));
    }
    #[test]
    fn inside_refuses_escapes() {
        let root = Path::new("proj");
        assert!(inside(root, "src/a.ts").is_ok());
        assert!(inside(root, "").is_ok());
        assert!(inside(root, "../x").is_err());
        assert!(inside(root, "src/../../x").is_err());
        assert!(inside(root, if cfg!(windows) { "C:\\x" } else { "/etc/passwd" }).is_err());
    }
}
