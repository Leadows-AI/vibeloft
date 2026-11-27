// The setup check: is everything Vibeloft needs installed
// and signed in? Install buttons run each tool's official installer, with the output
// shown in the app. Nothing runs unless the person clicks.
use crate::{
    account,
    util::{self, Args, Res},
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{Read, Write},
    process::{Child, Stdio},
    sync::{mpsc, LazyLock, Mutex},
    thread,
    time::{Duration, Instant},
};

const STEPS: [&str; 4] = ["claude", "git", "gh", "ghLogin"];

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    let step = || STEPS.into_iter().find(|s| *s == a.s(0)).ok_or_else(|| "Unknown setup step.".to_string());
    Some(match ch {
        "setup:status" => Ok(setup_status()),
        "setup:commands" => {
            let st = setup_status();
            Ok(Value::Object(STEPS.iter().map(|s| (s.to_string(), setup_command(s, &st))).collect()))
        }
        "setup:run" => step().map(run_setup_step),
        "setup:cancel" => {
            cancel_step();
            Ok(Value::Null)
        }
        "setup:manual" => step().map(|s| {
            open_manual(s);
            Value::Null
        }),
        _ => return None,
    })
}

const IS_WIN: bool = cfg!(windows);
const IS_MAC: bool = cfg!(target_os = "macos");

/// What a finished program printed. Shared with mobile.rs and account.rs (Node's execFile).
pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// It couldn't start, e.g. not installed.
    pub not_found: bool,
}

impl Output {
    /// stdout + stderr, trimmed.
    pub fn out(&self) -> String {
        format!("{}{}", self.stdout, self.stderr).trim().to_string()
    }
}

/// Run a program, killing it after `timeout`.
pub fn exec(file: impl AsRef<std::ffi::OsStr>, args: &[&str], timeout: Duration) -> Output {
    let fail = |e: std::io::Error| Output { ok: false, stdout: String::new(), stderr: e.to_string(), not_found: e.kind() == std::io::ErrorKind::NotFound };
    let mut c = util::command(file);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match c.spawn() {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let read = |mut r: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut b = Vec::new();
            let _ = r.read_to_end(&mut b);
            String::from_utf8_lossy(&b).into_owned()
        })
    };
    let out = read(Box::new(child.stdout.take().unwrap()));
    let err = read(Box::new(child.stderr.take().unwrap()));
    let end = Instant::now() + timeout;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.success(),
            Ok(None) if Instant::now() < end => thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    Output { ok, stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default(), not_found: false }
}

fn run(file: &str, args: &[&str]) -> Output {
    exec(file, args, Duration::from_secs(15))
}

/// Installers add folders to PATH for new programs, but this app keeps the PATH
/// it started with. Read the current one so new tools are found without a restart.
pub fn refresh_path() {
    let home = dirs::home_dir().unwrap_or_default();
    let mut extra: Vec<String> = vec![];
    let sep = if IS_WIN { ';' } else { ':' };
    if IS_WIN {
        let r = run(
            "powershell.exe",
            &["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
        );
        if r.ok {
            extra.extend(r.out().split(';').map(str::to_string));
        }
        extra.extend([home.join(".local").join("bin").to_string_lossy().into_owned(), r"C:\Program Files\Git\cmd".into(), r"C:\Program Files\GitHub CLI".into()]);
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let r = run(&shell, &["-ilc", "echo -n \"$PATH\""]);
        if r.ok {
            extra.extend(r.out().split(':').map(str::to_string));
        }
        extra.extend([home.join(".local").join("bin").to_string_lossy().into_owned(), "/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
    }
    let current = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", merge_path(&current, &extra, sep));
}

/// The current PATH plus the folders it doesn't have yet (case-insensitive).
fn merge_path(current: &str, extra: &[String], sep: char) -> String {
    let mut merged: Vec<String> = current.split(sep).map(str::to_string).collect();
    for d in extra.iter().map(|x| x.trim()).filter(|x| !x.is_empty()) {
        if !merged.iter().any(|m| m.to_lowercase() == d.to_lowercase()) {
            merged.push(d.to_string());
        }
    }
    merged.join(&sep.to_string())
}

fn first_line(s: &str) -> String {
    s.split('\n').next().unwrap_or_default().trim().to_string()
}

// Automated UI checks only: VIBE_SETUP_SIMULATE=claude,login,git,gh,ghlogin pretends
// those are missing, and "installing" one runs a harmless stand-in instead.
static SIMULATED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| {
    Mutex::new(std::env::var("VIBE_SETUP_SIMULATE").unwrap_or_default().split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
});

fn sim(k: &str, v: bool) -> bool {
    !SIMULATED.lock().unwrap().contains(k) && v
}

static AUTH_USER: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)account\s+(\S+)").unwrap());
static AS_USER: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)as\s+(\S+)").unwrap());

pub fn setup_status() -> Value {
    refresh_path();
    crate::claude::reset_claude_path();
    let claude_path = crate::claude::claude_executable().ok();
    let claude_v = claude_path.map(|p| exec(p, &["--version"], Duration::from_secs(15)));
    let claude_ok = claude_v.as_ref().is_some_and(|v| v.ok);
    let git_v = run("git", &["--version"]);
    let gh_v = run("gh", &["--version"]);
    let gh_auth = if gh_v.ok { Some(run("gh", &["auth", "status"])) } else { None };
    let gh_auth_out = gh_auth.as_ref().map(Output::out).unwrap_or_default();
    let gh_user = AUTH_USER.captures(&gh_auth_out).or_else(|| AS_USER.captures(&gh_auth_out)).map(|c| c[1].to_string());
    let account = if claude_ok { account::account_status() } else { Value::Null };
    let winget = IS_WIN && run("winget", &["--version"]).ok;
    let brew = IS_MAC && run("brew", &["--version"]).ok;
    let version = |o: &Output, prefix: &str| if o.ok { {
        let l = first_line(&o.out());
        json!(l.strip_prefix(prefix).unwrap_or(&l))
    } } else { Value::Null };
    json!({
        "platform": match std::env::consts::OS { "windows" => "win32", "macos" => "darwin", os => os },
        "claude": { "installed": sim("claude", claude_ok), "version": claude_v.filter(|v| v.ok).map(|v| first_line(&v.out())) },
        "claudeSignedIn": sim("login", account["loggedIn"] == true),
        "claudeAccount": account["email"],
        "git": { "installed": sim("git", git_v.ok), "version": version(&git_v, "git version ") },
        "gh": { "installed": sim("gh", gh_v.ok), "version": version(&gh_v, "gh version ") },
        "ghSignedIn": sim("ghlogin", gh_auth.is_some_and(|a| a.ok)),
        "ghUser": gh_user,
        "winget": winget,
        "brew": brew
    })
}

/// The exact command each Install button runs, shown to the person before they click (null: none).
pub fn setup_command(step: &str, status: &Value) -> Value {
    let winget = |id: &str| format!("winget install --id {id} -e --source winget --accept-package-agreements --accept-source-agreements");
    let has = |k: &str| status[k] == true;
    let cmd = |command: String, url: &str| json!({ "command": command, "manualUrl": url });
    match step {
        "claude" if IS_WIN => cmd("irm https://claude.ai/install.ps1 | iex".into(), "https://code.claude.com/docs/en/setup"),
        "claude" => cmd("curl -fsSL https://claude.ai/install.sh | bash".into(), "https://code.claude.com/docs/en/setup"),
        "git" if IS_WIN && has("winget") => cmd(winget("Git.Git"), "https://git-scm.com/download/win"),
        "git" if IS_MAC => cmd(if has("brew") { "brew install git" } else { "xcode-select --install" }.into(), "https://git-scm.com/download/mac"),
        "gh" if IS_WIN && has("winget") => cmd(winget("GitHub.cli"), "https://cli.github.com"),
        "gh" if IS_MAC && has("brew") => cmd("brew install gh".into(), "https://cli.github.com"),
        "ghLogin" => cmd("gh auth login --web --git-protocol https --hostname github.com".into(), "https://cli.github.com/manual/gh_auth_login"),
        _ => Value::Null,
    }
}

fn open_manual(step: &str) {
    let url = match step {
        "claude" => "https://code.claude.com/docs/en/setup",
        "git" if IS_WIN => "https://git-scm.com/download/win",
        "git" => "https://git-scm.com/downloads",
        "gh" => "https://cli.github.com",
        _ => "https://cli.github.com/manual/gh_auth_login",
    };
    let _ = tauri_plugin_opener::open_url(url, None::<&str>);
}

fn emit(step: &str, text: &str) {
    util::emit("setup:output", json!({ "step": step, "text": text }));
}

static RUNNING: Mutex<Option<Child>> = Mutex::new(None);

/// Run a step's command, streaming its output to the setup panel. Returns the new status.
fn run_setup_step(step: &str) -> Value {
    let before = setup_status();
    let Some(command) = setup_command(step, &before)["command"].as_str().map(str::to_string) else {
        open_manual(step);
        return json!({ "ok": false, "status": before });
    };
    emit(step, &format!("> {command}\n"));
    if !SIMULATED.lock().unwrap().is_empty() {
        emit(step, &format!("(test) pretending to install {step}…\n"));
        thread::sleep(Duration::from_millis(800));
        SIMULATED.lock().unwrap().remove(if step == "ghLogin" { "ghlogin" } else { step });
        emit(step, "\nDone.\n");
        return json!({ "ok": true, "status": setup_status() });
    }
    let code = run_streaming(step, &command);
    emit(step, &if code == 0 { "\nDone.\n".to_string() } else { format!("\nFinished with code {code}.\n") });
    json!({ "ok": code == 0, "status": setup_status() })
}

/// The command's exit code; -1 if it couldn't start or was cancelled.
fn run_streaming(step: &str, command: &str) -> i32 {
    let mut c = if IS_WIN {
        let mut c = util::command("powershell.exe");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
        c
    } else {
        let mut c = util::command(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
        c.args(["-lc", command]);
        c
    };
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match c.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit(step, &format!("\n{e}\n"));
            return -1;
        }
    };
    let (tx, rx) = mpsc::channel::<String>();
    let pipe = |mut r: Box<dyn Read + Send>, tx: mpsc::Sender<String>| {
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n @ 1..) = r.read(&mut buf) {
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            }
        });
    };
    pipe(Box::new(child.stdout.take().unwrap()), tx.clone());
    pipe(Box::new(child.stderr.take().unwrap()), tx);
    let mut stdin = child.stdin.take();
    let pid = child.id();
    *RUNNING.lock().unwrap() = Some(child);
    let mut forward = |text: String| {
        emit(step, &text);
        // GitHub sign-in: it shows a one-time code, then waits for Enter to open the browser.
        if step == "ghLogin" && text.to_lowercase().contains("press enter") {
            if let Some(s) = stdin.as_mut() {
                let _ = s.write_all(b"\n");
            }
        }
    };
    loop {
        if let Ok(text) = rx.recv_timeout(Duration::from_millis(100)) {
            forward(text);
        }
        let mut running = RUNNING.lock().unwrap();
        let status = match running.as_mut() {
            Some(c) if c.id() == pid => {
                let s = match c.try_wait() {
                    Ok(None) => continue,
                    Ok(Some(s)) => s.code().unwrap_or(-1),
                    Err(_) => -1,
                };
                *running = None;
                s
            }
            _ => -1, // cancelled
        };
        drop(running);
        // Output that was already on its way.
        while let Ok(text) = rx.try_recv() {
            forward(text);
        }
        return status;
    }
}

/// Stop a running setup step (Cancel, app exit).
pub fn cancel_step() {
    if let Some(mut c) = RUNNING.lock().unwrap().take() {
        let _ = c.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_merge_skips_known_folders() {
        let extra = vec![r" C:\Git\cmd ".to_string(), r"c:\tools".into(), "".into()];
        assert_eq!(merge_path(r"C:\Tools;C:\x", &extra, ';'), r"C:\Tools;C:\x;C:\Git\cmd");
    }
}
