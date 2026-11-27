// Past Claude Code conversations for a
// project, read from Claude Code's own session files
// (~/.claude/projects/<folder>/<session id>.jsonl). Read only.
use crate::{
    store,
    util::{Args, Res},
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::UNIX_EPOCH,
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "claude:sessions" => Ok(list_sessions(&a.s(0))),
        "claude:activeSession" => Ok(json!(active_session(&a.s(0), a.n(1), &a.strs(2)))),
        _ => return None,
    })
}

const HEAD_BYTES: u64 = 256 * 1024;
const TAIL_BYTES: u64 = 64 * 1024;

pub fn config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
}

/// Claude Code names each project's folder after its path, with every other character replaced by "-".
pub fn session_dir(project_path: &str) -> Option<PathBuf> {
    // One "-" per UTF-16 unit, as JavaScript (Claude Code) counts characters.
    let want: String = project_path
        .trim_end_matches(['\\', '/'])
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase().to_string() } else { "-".repeat(c.len_utf16()) })
        .collect();
    let base = config_dir().join("projects");
    fs::read_dir(&base).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).find(|d| d.to_lowercase() == want).map(|d| base.join(d))
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter(|c| c["type"] == "text").map(|c| c["text"].as_str().unwrap_or_default()).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

fn read_at(file: &Path, from: u64, len: u64) -> std::io::Result<String> {
    let mut f = fs::File::open(file)?;
    f.seek(SeekFrom::Start(from))?;
    let mut buf = Vec::new();
    f.take(len).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn read_head(file: &Path) -> std::io::Result<String> {
    read_at(file, 0, HEAD_BYTES)
}

/// The end of a long conversation file, where Claude Code writes its latest title.
fn read_tail(file: &Path, size: u64) -> std::io::Result<String> {
    if size <= HEAD_BYTES {
        return Ok(String::new());
    }
    let len = TAIL_BYTES.min(size - HEAD_BYTES);
    read_at(file, size - len, len)
}

#[derive(Default)]
struct Names {
    custom: Option<String>,
    ai: Option<String>,
    summary: Option<String>,
}

/// The conversation's name: one you gave it (/rename) wins, then the title
/// Claude Code gives it, then an older-style summary. Later entries replace
/// earlier ones (Claude Code updates its title as the conversation goes on).
fn title_from(text: &str, n: &mut Names) {
    for line in text.split('\n') {
        if !line.contains("-title\"") && !line.contains("\"summary\"") {
            continue;
        }
        let Ok(j) = serde_json::from_str::<Value>(line) else { continue };
        let s = |k: &str| j[k].as_str().map(str::to_owned);
        match j["type"].as_str() {
            Some("custom-title") if s("customTitle").is_some() => n.custom = s("customTitle"),
            Some("ai-title") if s("aiTitle").is_some() => n.ai = s("aiTitle"),
            Some("summary") if s("summary").is_some() => n.summary = s("summary"),
            _ => {}
        }
    }
}

static TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""timestamp":"(\d{4}-\d\d-\d\dT[^"]+)""#).unwrap());
static ENTRYPOINT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""entrypoint":"([A-Za-z0-9_-]+)""#).unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

fn entrypoint(text: &str) -> Option<String> {
    ENTRYPOINT.captures(text).map(|m| m[1].to_owned())
}

fn truthy(v: &Value) -> bool {
    !(v.is_null() || *v == false || *v == 0 || *v == "")
}

/// What a conversation's head and tail say: its title, first prompt, prompt count,
/// entrypoint and when its last message was written (ms, 0 if unknown).
fn summarize(head: &str, tail: &str) -> (Option<String>, Option<String>, u32, Option<String>, i64) {
    let mut names = Names::default();
    title_from(head, &mut names);
    title_from(tail, &mut names);
    // When the last message was written (the file's own time also changes
    // when another app merely touches it).
    let last_at = head
        .split('\n')
        .chain(tail.split('\n'))
        .filter_map(|l| TIMESTAMP.captures(l))
        .filter_map(|m| chrono::DateTime::parse_from_rfc3339(&m[1]).ok())
        .map(|t| t.timestamp_millis())
        .max()
        .unwrap_or(0);
    let mut first = None;
    let mut prompts = 0;
    for line in head.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        // The last line of the chunk may be cut off.
        let Ok(j) = serde_json::from_str::<Value>(line) else { continue };
        if j["type"] == "user" && !truthy(&j["isMeta"]) && !truthy(&j["isSidechain"]) {
            let text = text_of(&j["message"]["content"]);
            let text = text.trim();
            // Skip slash-command plumbing, tool results and interrupted markers.
            if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") || text.starts_with("[Request interrupted") {
                continue;
            }
            prompts += 1;
            if first.is_none() {
                first = Some(SPACES.replace_all(text, " ").chars().take(240).collect());
            }
        }
    }
    (names.custom.or(names.ai).or(names.summary), first, prompts, entrypoint(head), last_at)
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn mtime_ms(m: &fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64)
}

/// The project's conversation files (sub-agents' files left out).
fn conversations(project_id: &str) -> Option<(PathBuf, Vec<String>)> {
    let db = store::load();
    let path = db["projects"].as_array()?.iter().find(|p| p["id"] == project_id)?["localPath"].as_str()?.to_owned();
    let dir = session_dir(&path)?;
    let files = fs::read_dir(&dir)
        .map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|f| f.ends_with(".jsonl") && !f.starts_with("agent-")).collect())
        .unwrap_or_default();
    Some((dir, files))
}

pub fn list_sessions(project_id: &str) -> Value {
    let Some((dir, files)) = conversations(project_id) else { return json!([]) };
    let mut recent: Vec<(String, i64, u64)> =
        files.into_iter().filter_map(|f| fs::metadata(dir.join(&f)).ok().map(|m| (f, mtime_ms(&m), m.len()))).collect();
    recent.sort_by(|a, b| b.1.cmp(&a.1));
    recent.truncate(60);

    let mut out = vec![];
    for (f, mtime, size) in recent {
        let file = dir.join(&f);
        let (Ok(head), Ok(tail)) = (read_head(&file), read_tail(&file, size)) else { continue };
        let (title, first_prompt, prompts, entry, last_at) = summarize(&head, &tail);
        if first_prompt.is_none() && title.is_none() {
            continue;
        }
        out.push(json!({
            "id": &f[..f.len() - ".jsonl".len()],
            "title": title,
            "firstPrompt": first_prompt,
            "prompts": prompts,
            "updatedAt": iso(if last_at > 0 { last_at } else { mtime }),
            "sizeKb": (size as f64 / 1024.0).round(),
            // Started in VS Code (or another editor) rather than a terminal like Vibeloft's.
            "fromEditor": entry.is_some_and(|e| e != "cli"),
        }));
    }
    out.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    Value::Array(out)
}

/// Which conversation a terminal is in: the one in this project written to most
/// recently since the terminal started, not already claimed by another terminal.
pub fn active_session(project_id: &str, since_ms: f64, exclude: &[String]) -> Option<String> {
    let (dir, files) = conversations(project_id)?;
    let mut best: Option<(String, i64)> = None;
    for f in files {
        let id = f[..f.len() - ".jsonl".len()].to_owned();
        if exclude.contains(&id) {
            continue;
        }
        let Ok(m) = fs::metadata(dir.join(&f)) else { continue };
        let mtime = mtime_ms(&m);
        if (mtime as f64) < since_ms - 2000.0 || best.as_ref().is_some_and(|b| mtime <= b.1) {
            continue;
        }
        // A conversation going on in VS Code at the same time isn't this terminal's.
        if entrypoint(&read_head(&dir.join(&f)).unwrap_or_default()).is_some_and(|e| e != "cli") {
            continue;
        }
        best = Some((id, mtime));
    }
    best.map(|b| b.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_title_and_prompts() {
        let head = [
            r#"{"type":"user","entrypoint":"cli","timestamp":"2026-01-02T03:04:05.000Z","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","timestamp":"2026-01-02T03:05:00.000Z","message":{"content":[{"type":"text","text":"Fix  the\nlogin"}]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"meta"}}"#,
            r#"{"type":"ai-title","aiTitle":"Login fix"}"#,
            r#"{"type":"user","message":{"content":"cut off"#,
        ]
        .join("\n");
        let tail = r#"{"type":"custom-title","customTitle":"Mine"}"#;
        let (title, first, prompts, entry, last) = summarize(&head, tail);
        assert_eq!(title.as_deref(), Some("Mine"));
        assert_eq!(first.as_deref(), Some("Fix the login"));
        assert_eq!(prompts, 1);
        assert_eq!(entry.as_deref(), Some("cli"));
        assert_eq!(iso(last), "2026-01-02T03:05:00.000Z");
    }
}
