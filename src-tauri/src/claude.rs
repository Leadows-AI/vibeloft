// Vibeloft's own small Claude jobs (commit
// messages, architecture overviews, report summaries, help answers) run
// through the Claude Code app installed on this computer, in its one-shot mode
// (`claude -p`): same login, same model setting, no extra SDK bundled with
// Vibeloft. Day-to-day work with Claude happens in the Terminal tab.
use crate::{
    store,
    util::{self, now, Args, Res},
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "help:ask" => help_answer(&a.s(0), &a.s(1), &a.s(2)).map(Value::String),
        "arch:generate" => generate_architecture(&a.s(0)).map(|_| store::load()),
        "arch:export" => export_architecture(&a.s(0)).map(Value::String),
        "report:summary" => report_summary(&a.s(0)).map(Value::String),
        "git:commitMessage" => commit_message(&a.s(0)).map(Value::String),
        _ => return None,
    })
}

static CLAUDE_PATH: Mutex<Option<Option<PathBuf>>> = Mutex::new(None);

/// Look for Claude Code again (e.g. right after the setup check installed it).
pub fn reset_claude_path() {
    *CLAUDE_PATH.lock().unwrap() = None;
}

/// The installed Claude Code (the same one the Terminal tab runs). On Windows it
/// may be `claude.cmd` (npm install); Rust's Command runs a .cmd path through cmd.exe.
pub fn claude_executable() -> Result<PathBuf, String> {
    let mut cached = CLAUDE_PATH.lock().unwrap();
    let found = cached.get_or_insert_with(|| {
        let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
        let home = dirs::home_dir().unwrap_or_default();
        let mut dirs = vec![home.join(".local").join("bin"), home.join(".claude").join("local")];
        dirs.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
        dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
        let over = std::env::var_os("CLAUDE_CODE_PATH").map(PathBuf::from).filter(|p| p.exists());
        over.or_else(|| {
            dirs.iter().filter(|d| !d.as_os_str().is_empty()).flat_map(|d| names.iter().map(move |n| d.join(n))).find(|f| f.exists())
        })
    });
    found.clone().ok_or_else(|| "Claude Code is not installed on this computer. Open Settings → Setup check to install it, then try again.".into())
}

/// Claude's JSON answer (the last line of its output), or the error to show.
fn parse_answer(out: &str, err: &str, fail: &str) -> Result<String, String> {
    let last = out.trim().split('\n').filter(|l| !l.is_empty()).next_back().unwrap_or("{}");
    let why = match serde_json::from_str::<Value>(last) {
        Ok(j) => {
            let result = j["result"].as_str().unwrap_or_default();
            let is_error = !(j["is_error"].is_null() || j["is_error"] == false);
            if !is_error && j["subtype"] == "success" && !result.is_empty() {
                return Ok(result.trim().into());
            }
            [result, j["subtype"].as_str().unwrap_or_default(), "no answer"].into_iter().find(|s| !s.is_empty()).unwrap().to_owned()
        }
        Err(e) => e.to_string(),
    };
    let why = if err.trim().is_empty() { why.as_str() } else { err.trim() };
    let why: String = why.split('\n').next().unwrap_or_default().chars().take(300).collect();
    if Regex::new(r"(?i)not logged in|log in|authenticate").unwrap().is_match(&why) {
        Err("Sign in to Claude first (Settings → Claude account).".into())
    } else {
        Err(format!("{fail} {why}"))
    }
}

/// Run Claude Code once and return its answer. `tools` are the only tools it may
/// use (none by default); anything else is refused without asking. The session
/// isn't saved, so it doesn't appear in the Terminal's History.
fn one_shot(prompt: &str, cwd: Option<&Path>, tools: &[&str], timeout: Duration, fail: &str) -> Result<String, String> {
    let exe = claude_executable()?;
    let model = store::load()["settings"]["model"].as_str().unwrap_or_default().to_owned();
    let mut c = util::command(&exe);
    c.args(["-p", "--output-format", "json", "--no-session-persistence", "--permission-mode", "dontAsk", "--model", &model]);
    if !tools.is_empty() {
        c.args(["--allowedTools", &tools.join(",")]);
    }
    c.current_dir(cwd.map_or_else(std::env::temp_dir, Path::to_path_buf));
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("{fail} {e}"))?;
    let (mut stdin, mut so, mut se) = (child.stdin.take().unwrap(), child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let input = prompt.to_owned();
    thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes()); // dropping stdin ends it
    });
    let out = thread::spawn(move || {
        let mut s = String::new();
        let _ = so.read_to_string(&mut s);
        s
    });
    let err = thread::spawn(move || {
        let mut s = String::new();
        let _ = se.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                // ponytail: for claude.cmd this ends cmd.exe, not the node process under it; kill the tree if that leaks.
                let _ = child.kill();
                return Err(format!("{fail} (it took too long)."));
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("{fail} {e}")),
        }
    }
    parse_answer(&out.join().unwrap_or_default(), &err.join().unwrap_or_default(), fail)
}

fn require_repo(project_id: &str) -> Result<Value, String> {
    let db = store::load();
    let p = db["projects"].as_array().and_then(|ps| ps.iter().find(|p| p["id"] == project_id)).cloned().ok_or("Project not found")?;
    if !p["localPath"].as_str().is_some_and(|l| Path::new(l).exists()) {
        return Err("Set a local folder for this project first (Overview → Edit), so Claude can read the code.".into());
    }
    Ok(p)
}

const ARCH_PROMPT: &str = r#"Analyze this repository and write an architecture overview in Markdown for a developer who is new to it. Use exactly these sections:

## Summary
Two or three sentences: what the app does and who uses it.

## Tech stack
A bullet list (languages, frameworks, database, hosting/build tools, key libraries).

## Structure
How the code is organised: the main folders and what each one holds. If there is a client and a server (or a mobile app and an API), describe each part.

## Diagram
One Mermaid diagram in a ```mermaid block (use "flowchart LR") showing the main parts and how they talk to each other (UI, API, database, external services). Keep node labels short and wrap them in double quotes.

## Data model
The main entities and how they relate.

## Key flows
Two to four important user flows, each traced through the code with file paths.

## Running locally
The commands to install, run and test, taken from the repo.

## Risks and notes
Anything fragile, missing (tests, env docs) or worth knowing.

Base every statement on files you actually read. Reply with only the Markdown document."#;

pub fn generate_architecture(project_id: &str) -> Result<(), String> {
    let project = require_repo(project_id)?;
    let markdown = one_shot(
        ARCH_PROMPT,
        project["localPath"].as_str().map(Path::new),
        &["Read", "Glob", "Grep"],
        Duration::from_secs(10 * 60),
        "Architecture analysis failed.",
    )?;
    // Strip a wrapping ```markdown fence if the model added one.
    let markdown = Regex::new(r"^```(?:markdown|md)?\s*\n((?s:.*))\n```$").unwrap().replace(&markdown, "$1").into_owned();
    store::mutate(|db| {
        if let Some(p) = db["projects"].as_array_mut().and_then(|ps| ps.iter_mut().find(|p| p["id"] == project_id)) {
            p["architecture"] = json!(markdown);
            p["architectureUpdatedAt"] = json!(now());
        }
    });
    Ok(())
}

/// Optional: write the architecture doc into the repo so it is versioned with the code.
pub fn export_architecture(project_id: &str) -> Result<String, String> {
    let p = require_repo(project_id)?;
    let dir = Path::new(p["localPath"].as_str().unwrap_or_default()).join("docs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("ARCHITECTURE.md");
    let text = format!("# {} – Architecture\n\n{}\n", p["name"].as_str().unwrap_or_default(), p["architecture"].as_str().unwrap_or_default());
    fs::write(&file, text).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

/// Ask Claude for a commit message describing the staged changes (.env files are never included).
pub fn commit_message(project_id: &str) -> Result<String, String> {
    require_repo(project_id)?;
    let diff = crate::gitops::staged_diff(project_id, 24_000)?;
    if diff.trim().is_empty() {
        return Err("Stage some changes first, then Claude can describe them.".into());
    }
    let text = one_shot(
        &format!(
            r#"Write a git commit message for these staged changes.

Format: one summary line of at most 72 characters in the imperative mood ("Add…", "Fix…"), then a blank line, then up to four short bullet points only if they add useful detail. No quotes, no code fences, no sign-off. Reply with only the commit message.

{diff}"#
        ),
        None,
        &[],
        Duration::from_secs(180),
        "Claude could not write a commit message.",
    )?;
    Ok(Regex::new(r"^```\w*\n?|\n?```$").unwrap().replace_all(&text, "").trim().to_owned())
}

/// A short, customer-friendly progress summary written from report facts (no code is read).
pub fn report_summary(facts: &str) -> Result<String, String> {
    one_shot(
        &format!(
            "You are writing the opening paragraph of a project status report that a software agency sends to its customer.

Write 3 to 5 sentences in plain, friendly, professional English for a non-technical reader: what was achieved in this period, what is being worked on now, anything that needs the customer's attention (overdue or at-risk dates, critical bugs), and what comes next. Use only the facts below; do not invent features, dates or numbers. No headings, no bullet points, no greeting or sign-off. Reply with only the paragraph.

{facts}"
        ),
        None,
        &[],
        Duration::from_secs(180),
        "Claude could not write the summary.",
    )
}

/// "Ask Vibeloft": answer a question about using Vibeloft from its built-in
/// guide. No tools and no project files: just the guide and the question.
pub fn help_answer(question: &str, screen: &str, guide: &str) -> Result<String, String> {
    let question: String = question.chars().take(2000).collect();
    one_shot(
        &format!(
            "You are the built-in help for Vibeloft, a desktop app for building and managing customer software projects with Claude Code. Answer the user's question about using Vibeloft.

Rules:
- Use only the guide below. Never invent buttons, menus, shortcuts or features. If the guide doesn't cover it, say so briefly and point to the closest thing it does cover.
- Be short and practical: at most about 120 words, as numbered steps when there are steps. Put exact button and tab names in **bold**.
- Plain friendly English for someone new to the app.
- The user is currently on: {screen}.
- After the answer, on separate final lines, you may add:
  TOURS: <comma-separated ids from: welcome, project, terminal, git>   (only if a guided tour would help)
  TOPICS: <comma-separated topic ids from the guide, most relevant first, at most 3>

GUIDE
{guide}

QUESTION
{question}"
        ),
        None,
        &[],
        Duration::from_secs(180),
        "Claude could not answer right now. Try again, or browse the topics below.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_claude_answer() {
        let ok = "noise\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\" Hi \"}\n";
        assert_eq!(parse_answer(ok, "", "Failed.").unwrap(), "Hi");
        let bad = "{\"subtype\":\"error_max_turns\",\"is_error\":true}";
        assert_eq!(parse_answer(bad, "", "Failed.").unwrap_err(), "Failed. error_max_turns");
        assert_eq!(parse_answer("", "Error: Not logged in\nmore", "Failed.").unwrap_err(), "Sign in to Claude first (Settings → Claude account).");
    }
}
