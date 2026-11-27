// Claude Code hooks: each Claude Code terminal
// Vibeloft starts gets a small settings file (passed with --settings, so
// nothing is written into your projects or your own Claude Code settings)
// whose hooks report "prompt sent", "needs you" and "finished" back to
// Vibeloft. Hooks only report: they always exit 0 and never change what Claude does.
//
// They post to a listener on 127.0.0.1 that accepts only requests carrying a
// random token made fresh each time Vibeloft starts.
use crate::{
    checkpoints, claude_sessions, terminals,
    util::{self, Args, Res},
};
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::PathBuf,
    sync::{mpsc, Arc, LazyLock, Mutex},
    thread,
    time::Duration,
};
use tiny_http::{Header, Request, Response, Server};

pub fn handle(_ch: &str, _a: &Args) -> Option<Res> {
    None
}

static TOKEN: LazyLock<String> = LazyLock::new(|| format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()));
static SERVER: Mutex<Option<(Arc<Server>, u16)>> = Mutex::new(None);

const EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "Notification", "Stop", "StopFailure", "StatusLine", "SessionEnd", "PreToolUse"];

/// Terminals where Claude is in the middle of a turn (prompt sent, not finished yet).
static IN_TURN: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

fn pct(v: &Value) -> Option<i64> {
    v.as_f64().filter(|n| n.is_finite()).map(|n| n.round().clamp(0.0, 100.0) as i64)
}

fn cut(v: &Value, n: usize) -> Option<String> {
    v.as_str().map(|s| s.chars().take(n).collect())
}

/// Claude Code's status-line data: model, context use and (on Claude plans)
/// usage-limit windows. Sent to the Terminal tab; the short text it returns is
/// what Claude Code shows in its own status line.
fn status_from(terminal_id: &str, j: &Value) -> (Value, String) {
    let mut limits = vec![];
    let mut parts = vec![];
    let model = cut(&j["model"]["display_name"], 60);
    let context = pct(&j["context_window"]["used_percentage"]);
    parts.extend(model.clone());
    parts.extend(context.map(|c| format!("context {c}%")));
    for (key, label) in [("five_hour", "5-hour"), ("seven_day", "Weekly"), ("spend_limit", "Spend")] {
        let w = &j["rate_limits"][key];
        if let Some(used) = pct(&w["used_percentage"]) {
            let mut l = json!({ "label": label, "usedPct": used });
            if let Some(at) = w["resets_at"].as_f64().filter(|n| *n > 0.0) {
                l["resetsAt"] = json!(at * 1000.0);
            }
            limits.push(l);
            parts.push(format!("{} {used}%", label.to_lowercase()));
        }
    }
    let mut status = json!({ "terminalId": terminal_id, "limits": limits });
    if let Some(m) = model {
        status["model"] = json!(m);
    }
    if let Some(c) = context {
        status["contextPct"] = json!(c);
    }
    if let Some(c) = j["cost"]["total_cost_usd"].as_f64() {
        status["costUsd"] = json!(c);
    }
    (status, parts.join(" · "))
}

fn header(v: &str) -> Header {
    Header::from_bytes("content-type", v).unwrap()
}

fn reply(req: Request, code: u16) {
    let _ = req.respond(Response::empty(code).with_header(header("text/plain")));
}

fn reply_json(req: Request) {
    let _ = req.respond(Response::from_string("{}").with_header(header("application/json")));
}

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
}

fn on_request(mut req: Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or_default();
    if *req.method() != tiny_http::Method::Post || path != "/hook" || query(&url, "t").as_deref() != Some(TOKEN.as_str()) {
        return reply(req, 404);
    }
    let terminal_id = query(&url, "id").unwrap_or_default();
    let event = query(&url, "e").unwrap_or_default();
    if !terminals::is_session_id(&terminal_id) || !EVENTS.contains(&event.as_str()) {
        return reply(req, 400);
    }
    let mut body = Vec::new();
    let _ = req.as_reader().take(256 * 1024 + 1).read_to_end(&mut body);
    if body.len() > 256 * 1024 {
        return; // too big: dropped, like the TS
    }
    // A bad body: the event alone is still useful.
    let j: Value = serde_json::from_slice(&body).ok().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let session_id = j["session_id"].as_str().filter(|s| terminals::is_session_id(s)).map(str::to_owned);

    if event == "StatusLine" {
        let (status, line) = status_from(&terminal_id, &j);
        let _ = req.respond(Response::from_string(line).with_header(header("text/plain; charset=utf-8")));
        util::emit("term:status", status);
        return;
    }
    // About to change a file. Inside a turn you started, nothing to do (answer
    // at once). Otherwise Claude is carrying on by itself (a background job
    // it started finished, /loop…): save an undo checkpoint first.
    if event == "PreToolUse" && IN_TURN.lock().unwrap().contains(&terminal_id) {
        return reply_json(req);
    }
    let mut e = Map::new();
    e.insert("terminalId".into(), json!(terminal_id));
    e.insert("event".into(), json!(event));
    let mut put = |k: &str, v: Option<String>| {
        if let Some(v) = v {
            e.insert(k.into(), json!(v));
        }
    };
    put("sessionId", session_id.clone());
    let prompt = cut(&j["prompt"], 2000);
    put("prompt", prompt.clone());
    put("message", cut(&j["message"], 500));
    put("notificationType", cut(&j["notification_type"], usize::MAX));
    let reason = cut(&j["reason"], 40);
    put("reason", reason.clone());
    put("error", cut(&j["error"], 60));
    put("errorDetails", cut(&j["last_assistant_message"], 300).or_else(|| cut(&j["error_details"], 300)));

    if let Some(s) = &session_id {
        terminals::set_session(&terminal_id, s, "");
    }
    // Prompt sent: take the undo checkpoint before answering, so Claude only
    // starts once the "before" state is saved (capped so it never hangs).
    let starts = event == "UserPromptSubmit" || event == "PreToolUse";
    if starts {
        IN_TURN.lock().unwrap().insert(terminal_id.clone());
    }
    if matches!(event.as_str(), "Stop" | "StopFailure" | "SessionEnd") {
        IN_TURN.lock().unwrap().remove(&terminal_id);
    }
    if starts {
        let label = if event == "PreToolUse" { "Claude carried on by itself".to_string() } else { prompt.unwrap_or_default() };
        if let Some(cp) = checkpoint_before(&terminal_id, &label) {
            e.insert("checkpoint".into(), json!(cp));
        }
    }
    if event == "SessionEnd" && reason.as_deref() != Some("clear") {
        terminals::end_claude(&terminal_id);
    }
    if event == "PreToolUse" {
        reply_json(req);
    } else {
        reply(req, 204);
    }
    util::emit("term:hook", Value::Object(e));
}

/// The undo checkpoint saved before a prompt (index.ts onHookPrompt); its id, or None after 15 s.
fn checkpoint_before(terminal_id: &str, prompt: &str) -> Option<String> {
    let project = terminals::project_of(terminal_id)?;
    let label: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(checkpoints::create_checkpoint(&project, &format!("Before: {label}")));
    });
    rx.recv_timeout(Duration::from_secs(15)).ok()?.ok()?["id"].as_str().map(str::to_owned)
}

fn ensure_server() -> Option<u16> {
    let mut s = SERVER.lock().unwrap();
    if let Some((_, port)) = s.as_ref() {
        return Some(*port);
    }
    let server = Arc::new(Server::http("127.0.0.1:0").ok()?);
    let port = server.server_addr().to_ip()?.port();
    let srv = server.clone();
    thread::spawn(move || {
        for req in srv.incoming_requests() {
            // Each on its own thread: a prompt waits for its checkpoint, the status line must not.
            thread::spawn(move || on_request(req));
        }
    });
    *s = Some((server, port));
    Some(port)
}

/// Whether your own Claude Code settings already set a status line (then Vibeloft doesn't add one).
fn user_has_status_line() -> bool {
    let base = claude_sessions::config_dir();
    ["settings.json", "settings.local.json"].iter().any(|f| {
        let s: Value = fs::read_to_string(base.join(f)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let v = &s["statusLine"];
        !(v.is_null() || *v == false || *v == 0 || *v == "")
    })
}

/// Next to studio.json.
fn hooks_dir() -> PathBuf {
    let dir = crate::store::user_data_dir().join("claude-hooks");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// The command a hook runs: post Claude's event JSON (on stdin) to Vibeloft.
/// Claude Code runs hooks with sh on macOS and Git Bash on Windows (Git is part
/// of Vibeloft's setup), so one bash command works on both. It always exits 0,
/// so a failed report never changes what Claude does.
fn hook_url(port: u16, terminal_id: &str, event: &str) -> String {
    format!("http://127.0.0.1:{port}/hook?t={}&id={terminal_id}&e={event}", *TOKEN)
}

fn hook_command(port: u16, terminal_id: &str, event: &str, max_seconds: u32) -> String {
    format!("curl -s -m {max_seconds} -X POST --data-binary @- '{}' >/dev/null 2>&1 || true", hook_url(port, terminal_id, event))
}

/// Write the per-terminal settings file and return its path, to pass to
/// `claude --settings <path>`. None if the listener couldn't start
/// (Claude Code then runs as normal, without the reports).
pub fn hook_settings_for(terminal_id: &str, extra_dirs: &[String]) -> Option<String> {
    let port = ensure_server()?;
    // Reports run in the background ("async"), so Claude never waits for them.
    // The one exception is "prompt sent": Vibeloft takes the undo checkpoint
    // before Claude starts, so that hook waits (at most ~20 s).
    let report = |event: &str| json!([{ "hooks": [{ "type": "command", "command": hook_command(port, terminal_id, event, 3), "async": true }] }]);
    let mut settings = json!({
        "hooks": {
            "SessionStart": report("SessionStart"),
            "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": hook_command(port, terminal_id, "UserPromptSubmit", 20), "timeout": 25 }] }],
            "Notification": report("Notification"),
            "Stop": report("Stop"),
            "StopFailure": report("StopFailure"),
            // Claude Code posts these straight to Vibeloft (no shell started), so
            // they're quick enough to run before every file change.
            "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "http", "url": hook_url(port, terminal_id, "PreToolUse"), "timeout": 20 }] }],
            "SessionEnd": [{ "hooks": [{ "type": "http", "url": hook_url(port, terminal_id, "SessionEnd"), "timeout": 3 }] }]
        }
    });
    // Status line: context use and usage limits for the Terminal tab. Only when
    // you don't have a status line of your own (ours would replace it).
    if !user_has_status_line() {
        let url = hook_url(port, terminal_id, "StatusLine");
        settings["statusLine"] = json!({ "type": "command", "command": format!("curl -s -m 2 -X POST --data-binary @- '{url}' 2>/dev/null || true") });
    }
    // Linked projects Claude can also read and edit (instead of --add-dir, which
    // asks about each folder every session with "No, exit" as the default).
    if !extra_dirs.is_empty() {
        settings["permissions"] = json!({ "additionalDirectories": extra_dirs });
    }
    let file = hooks_dir().join(format!("{terminal_id}.json"));
    fs::write(&file, serde_json::to_string_pretty(&settings).ok()?).ok()?;
    Some(file.to_string_lossy().into_owned())
}

pub fn remove_hook_settings(terminal_id: &str) {
    IN_TURN.lock().unwrap().remove(terminal_id);
    let _ = fs::remove_file(hooks_dir().join(format!("{terminal_id}.json"))); // not critical
}

/// Stop the hooks server (app exit).
pub fn stop_server() {
    if let Some((s, _)) = SERVER.lock().unwrap().take() {
        s.unblock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_line_from_claude_data() {
        let j = json!({
            "model": { "display_name": "Opus" },
            "context_window": { "used_percentage": 41.6 },
            "rate_limits": { "five_hour": { "used_percentage": 120, "resets_at": 1700000000 }, "seven_day": {} },
            "cost": { "total_cost_usd": 1.5 }
        });
        let (s, line) = status_from("term-0001", &j);
        assert_eq!(line, "Opus · context 42% · 5-hour 100%");
        assert_eq!(s["limits"], json!([{ "label": "5-hour", "usedPct": 100, "resetsAt": 1700000000000.0 }]));
        assert_eq!(s["costUsd"], json!(1.5));
        assert_eq!(status_from("x", &json!({})).1, "");
    }
}
