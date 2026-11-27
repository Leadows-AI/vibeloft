// The Claude Code login on this computer, through
// `claude auth …`. Vibeloft never sees a password or token: signing in happens in the browser.
use crate::{
    setup,
    util::{self, Args, Res},
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(Ok(match ch {
        "account:status" => account_status(),
        "account:login" => login(if a.s(0) == "console" { "console" } else { "claudeai" }),
        "account:loginCode" => {
            login_code(&a.s(0));
            Value::Null
        }
        "account:loginCancel" => {
            login_cancel();
            Value::Null
        }
        "account:logout" => {
            setup::exec(exe(), &["auth", "logout"], Duration::from_secs(20));
            account_status()
        }
        _ => return None,
    }))
}

/// The installed Claude Code (the same one the Terminal tab runs), else plain `claude`.
fn exe() -> PathBuf {
    crate::claude::claude_executable().unwrap_or_else(|_| "claude".into())
}

pub fn account_status() -> Value {
    let r = setup::exec(exe(), &["auth", "status", "--json"], Duration::from_secs(20));
    parse_status(&r)
}

fn parse_status(r: &setup::Output) -> Value {
    match serde_json::from_str::<Value>(&r.stdout) {
        Ok(j) if j.is_object() => {
            let f = |k: &str| j[k].clone();
            json!({
                "installed": true,
                "loggedIn": !matches!(j["loggedIn"], Value::Null | Value::Bool(false)),
                "email": f("email"), "orgName": f("orgName"), "authMethod": f("authMethod"),
                "subscriptionType": f("subscriptionType"), "loginExpiresAt": f("loginExpiresAt")
            })
        }
        _ => {
            let error = if r.not_found {
                "Claude Code is not installed on this computer.".to_string()
            } else {
                let msg = if !r.stderr.trim().is_empty() { r.stderr.trim() } else if !r.stdout.is_empty() { &r.stdout } else { "Could not read the login status." };
                msg.chars().take(300).collect()
            };
            json!({
                "installed": !r.not_found, "loggedIn": false, "email": null, "orgName": null, "authMethod": null,
                "subscriptionType": null, "loginExpiresAt": null, "error": error
            })
        }
    }
}

struct Login {
    child: Child,
    stdin: Option<ChildStdin>,
}

static LOGIN: Mutex<Option<Login>> = Mutex::new(None);

/// Runs `claude auth login`, which opens the browser. Output (such as a sign-in link) streams to the UI.
fn login(method: &str) -> Value {
    login_cancel();
    let mut c = util::command(exe());
    c.args(["auth", "login", &format!("--{method}")]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let Ok(mut child) = c.spawn() else { return account_status() };
    for r in [Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>, Box::new(child.stderr.take().unwrap())] {
        thread::spawn(move || {
            let mut r = r;
            let mut buf = [0u8; 8192];
            while let Ok(n @ 1..) = r.read(&mut buf) {
                util::emit("account:loginOutput", json!(String::from_utf8_lossy(&buf[..n])));
            }
        });
    }
    let pid = child.id();
    let stdin = child.stdin.take();
    *LOGIN.lock().unwrap() = Some(Login { child, stdin });
    // Wait until it ends, or another sign-in / Cancel replaced it.
    loop {
        thread::sleep(Duration::from_millis(100));
        let mut g = LOGIN.lock().unwrap();
        match g.as_mut() {
            Some(l) if l.child.id() == pid => {
                if matches!(l.child.try_wait(), Ok(None)) {
                    continue;
                }
                *g = None;
            }
            _ => {}
        }
        break;
    }
    account_status()
}

/// Some sign-ins show a code in the browser to paste back.
fn login_code(code: &str) {
    if let Some(Login { stdin: Some(s), .. }) = LOGIN.lock().unwrap().as_mut() {
        let _ = s.write_all(format!("{}\n", code.trim()).as_bytes());
    }
}

/// Stop a running sign-in (Cancel, app exit).
pub fn login_cancel() {
    if let Some(mut l) = LOGIN.lock().unwrap().take() {
        let _ = l.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_json_and_errors() {
        let out = |stdout: &str, not_found: bool| setup::Output { ok: true, stdout: stdout.into(), stderr: String::new(), not_found };
        let s = parse_status(&out(r#"{"loggedIn":true,"email":"a@b.c","authMethod":"claude.ai"}"#, false));
        assert_eq!((s["loggedIn"].as_bool(), s["email"].as_str(), s["orgName"].is_null()), (Some(true), Some("a@b.c"), true));
        let s = parse_status(&out("", true));
        assert_eq!((s["installed"].as_bool(), s["error"].as_str()), (Some(false), Some("Claude Code is not installed on this computer.")));
    }
}
