// Source control for the Git tab. Every command runs in the project folder
// with interactive prompts disabled, so a GUI app can never hang waiting for
// a password; credentials come from the user's git credential manager.
use crate::{
    store,
    util::{command, Args, Res},
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    let id = a.s(0);
    let none = |r: Result<(), String>| r.map(|_| Value::Null);
    Some(match ch {
        "git:status" => status(&id),
        "git:diff" => diff_sides(&id, &a.s(1), a.b(2)),
        "git:stage" => none(stage(&id, &a.strs(1))),
        "git:stageAll" => none(root(&id).and_then(|cwd| git(&cwd, &["add", "-A"]).map(|_| ()))),
        "git:unstage" => none(unstage(&id, &a.strs(1))),
        "git:discard" => none(discard(&id, &a.strs(1))),
        "git:commit" => commit(&id, &a.s(1)).map(Value::String),
        "git:push" => push(&id).map(Value::String),
        // Fast-forward only: never creates surprise merge commits.
        "git:pull" => root(&id)
            .and_then(|cwd| git_with(&cwd, &["pull", "--ff-only"], None, 300, &[]))
            .map(|o| Value::String(or(o.trim(), "Up to date."))),
        "git:fetch" => none(root(&id).and_then(|cwd| git_with(&cwd, &["fetch", "--quiet"], None, 120, &[]).map(|_| ()))),
        "git:branches" => branches(&id),
        "git:switch" => none(switch_branch(&id, &a.s(1), a.b(2))),
        "git:log" => log(&id, 40, None),
        "git:logSince" => log(&id, 200, Some(&a.s(1))),
        "git:init" => none(root(&id).and_then(|cwd| git(&cwd, &["init"]).map(|_| ()))),
        "git:mergeInfo" => merge_info(&id),
        "git:mergeIntoDefault" => merge_into_default(&id).map(Value::String),
        "git:repos" => repo_list(&id),
        "git:pickRepo" => none(pick_repo(&id, &a.s(1))),
        _ => return None,
    })
}

fn or(s: &str, fallback: &str) -> String {
    if s.is_empty() { fallback } else { s }.to_string()
}

pub fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    store::project_path(project_id)
}

/// `dir` joined with a repository folder relative to it ('' = `dir` itself).
pub fn sub(dir: &Path, rel: &str) -> PathBuf {
    if rel.is_empty() { dir.to_path_buf() } else { dir.join(rel) }
}

// A project folder can hold several apps, each with its own repository.
// The Git tab works on one at a time (picked per project); paths it gets and
// sends stay relative to the project folder, e.g. "web/src/App.tsx".
static PICKED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// The project's repositories, as folders relative to it ('' = the project folder itself). One level deep.
pub fn repos(project_id: &str) -> Result<Vec<String>, String> {
    let dir = project_dir(project_id)?;
    let mut subs: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|d| d.file_type().is_ok_and(|t| t.is_dir()))
        .map(|d| d.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && n != "node_modules" && dir.join(n).join(".git").exists())
        .collect();
    subs.sort();
    // No sub-repositories: the folder itself (also when it sits inside a bigger repo, or isn't one yet).
    if dir.join(".git").exists() || subs.is_empty() {
        subs.insert(0, String::new());
    }
    Ok(subs)
}

fn current_repo(project_id: &str) -> Result<String, String> {
    let all = repos(project_id)?;
    let picked = PICKED.lock().unwrap().as_ref().and_then(|m| m.get(project_id).cloned());
    Ok(picked.filter(|p| all.contains(p)).unwrap_or_else(|| all[0].clone()))
}

fn pick_repo(project_id: &str, repo: &str) -> Result<(), String> {
    if !repos(project_id)?.iter().any(|r| r == repo) {
        return Err("Unknown repository.".into());
    }
    PICKED.lock().unwrap().get_or_insert_with(HashMap::new).insert(project_id.into(), repo.into());
    Ok(())
}

/// Each repository with its number of changed files, for the repository picker.
fn repo_list(project_id: &str) -> Res {
    let dir = project_dir(project_id)?;
    let list: Vec<Value> = repos(project_id)?
        .into_iter()
        .map(|path| {
            let out = git(&sub(&dir, &path), &["status", "--porcelain", "--untracked-files=all"]).unwrap_or_default();
            json!({ "path": path, "changes": out.split('\n').filter(|l| !l.is_empty()).count() })
        })
        .collect();
    Ok(json!({ "current": current_repo(project_id)?, "repos": list }))
}

/// The folder of the repository picked in the Git tab.
pub fn root(project_id: &str) -> Result<PathBuf, String> {
    Ok(sub(&project_dir(project_id)?, &current_repo(project_id)?))
}

fn prefix(project_id: &str) -> Result<String, String> {
    let r = current_repo(project_id)?;
    Ok(if r.is_empty() { r } else { format!("{r}/") })
}

/// Project-relative paths from the UI -> paths inside the current repository.
fn in_repo(project_id: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let pre = prefix(project_id)?;
    paths
        .iter()
        .map(|p| match p.strip_prefix(&pre) {
            Some(rest) => Ok(rest.to_string()),
            None => Err(format!("{p} is not in the {} repository.", current_repo(project_id)?)),
        })
        .collect()
}

pub fn git<S: AsRef<OsStr>>(cwd: &Path, args: &[S]) -> Result<String, String> {
    git_with(cwd, args, None, 120, &[])
}

/// Run git like gitops.ts `git`: no prompts, no colors, a timeout (seconds); on failure the error
/// is its stderr (or stdout), trimmed.
pub fn git_with<S: AsRef<OsStr>>(cwd: &Path, args: &[S], input: Option<&str>, timeout: u64, env: &[(&str, &str)]) -> Result<String, String> {
    let mut c = command("git");
    c.args(["-c", "core.quotepath=false", "-c", "color.ui=false"]).args(args).current_dir(cwd);
    c.envs([("GIT_TERMINAL_PROMPT", "0"), ("GIT_OPTIONAL_LOCKS", "0"), ("GCM_INTERACTIVE", "always")]).envs(env.iter().copied());
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    c.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = c.spawn().map_err(|e| format!("git: {e}"))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(text.as_bytes());
    }
    // Read both pipes on their own threads, so a full pipe never blocks git while we wait.
    let drain = |p: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut buf = vec![];
            if let Some(mut p) = p {
                let _ = p.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break Some(s),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    match status {
        Some(s) if s.success() => Ok(out),
        _ => {
            let msg = if !err.is_empty() { err } else { out };
            let msg = msg.trim();
            Err(match status {
                None => format!("git timed out after {timeout} seconds. {msg}").trim().to_string(),
                Some(s) if msg.is_empty() => format!("git exited with {s}"),
                _ => msg.to_string(),
            })
        }
    }
}

/// Paths from the UI must stay inside the project.
fn check_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    for p in &paths {
        if p.is_empty() || escapes(p) {
            return Err(format!("Invalid path: {p}"));
        }
    }
    Ok(paths)
}

/// True when a relative path is absolute or climbs out of its folder with "..".
pub fn escapes(p: &str) -> bool {
    let mut depth = 0i32;
    for c in Path::new(p).components() {
        match c {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            Component::RootDir | Component::Prefix(_) => return true,
        }
    }
    false
}

struct Head {
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
}

/// Parse `git status --porcelain=v1 --branch -z`; file paths get `pre` (the repository folder) in front.
fn parse_status(out: &str, pre: &str) -> (Head, Vec<Value>) {
    let parts: Vec<&str> = out.split('\0').collect();
    let mut head = Head { branch: None, upstream: None, ahead: 0, behind: 0 };
    let mut files = vec![];
    let counts_re = Regex::new(r" \[(.*)\]$").unwrap();
    let mut i = 0;
    while i < parts.len() {
        let entry = parts[i];
        i += 1;
        if entry.is_empty() {
            continue;
        }
        if let Some(h) = entry.strip_prefix("## ") {
            // "## main...origin/main [ahead 1, behind 2]" or "## No commits yet on main"
            let counts = counts_re.captures(h).map(|c| c[1].to_string()).unwrap_or_default();
            let h = counts_re.replace(h, "");
            let h = h.strip_prefix("No commits yet on ").or_else(|| h.strip_prefix("Initial commit on ")).unwrap_or(&h);
            let mut split = h.splitn(2, "...");
            let local = split.next().unwrap_or_default();
            head.branch = if local.starts_with("HEAD") { None } else { Some(local.to_string()) };
            head.upstream = split.next().map(str::to_string);
            let num = |what: &str| {
                Regex::new(&format!(r"{what} (\d+)")).unwrap().captures(&counts).and_then(|c| c[1].parse().ok()).unwrap_or(0)
            };
            head.ahead = num("ahead");
            head.behind = num("behind");
            continue;
        }
        let mut chars = entry.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let path = format!("{pre}{}", entry.get(3..).unwrap_or_default());
        let mut f = json!({
            "path": path,
            "index": x.to_string(),
            "worktree": y.to_string(),
            "staged": x != ' ' && x != '?',
            "unstaged": y != ' ',
            "untracked": x == '?',
            "conflicted": x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D'),
        });
        if x == 'R' || x == 'C' {
            f["oldPath"] = json!(format!("{pre}{}", parts.get(i).copied().unwrap_or_default()));
            i += 1;
        }
        files.push(f);
    }
    (head, files)
}

fn status(project_id: &str) -> Res {
    let cwd = root(project_id)?;
    if git(&cwd, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(json!({ "isRepo": false, "branch": null, "upstream": null, "ahead": 0, "behind": 0, "files": [], "hasCommits": false }));
    }
    let out = git(&cwd, &["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"])?;
    let (h, files) = parse_status(&out, &prefix(project_id)?);
    let has_commits = git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let has_remote = !git(&cwd, &["remote"]).unwrap_or_default().trim().is_empty();
    let git_dir = git(&cwd, &["rev-parse", "--absolute-git-dir"]).unwrap_or_default().trim().to_string();
    let merging = !git_dir.is_empty() && Path::new(&git_dir).join("MERGE_HEAD").exists();
    Ok(json!({
        "isRepo": true, "branch": h.branch, "upstream": h.upstream, "ahead": h.ahead, "behind": h.behind,
        "files": files, "hasCommits": has_commits, "hasRemote": has_remote, "merging": merging
    }))
}

/// The repository's main branch: what origin/HEAD points at, else main or master.
fn default_branch(cwd: &Path) -> Option<String> {
    let head = git(cwd, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).unwrap_or_default();
    if let Some((_, b)) = head.trim().split_once('/') {
        return Some(b.to_string());
    }
    let local = git(cwd, &["branch", "--format=%(refname:short)"]).unwrap_or_default();
    let local: Vec<&str> = local.split('\n').map(str::trim).collect();
    ["main", "master", "develop"].into_iter().find(|b| local.contains(b)).map(str::to_string)
}

fn current_branch(cwd: &Path) -> Option<String> {
    Some(git(cwd, &["branch", "--show-current"]).unwrap_or_default().trim().to_string()).filter(|s| !s.is_empty())
}

/// How the current branch relates to the main branch (for "Merge into main").
fn merge_info(project_id: &str) -> Res {
    let cwd = root(project_id)?;
    let current = current_branch(&cwd);
    let main = default_branch(&cwd);
    let mut unmerged = 0u64;
    if let (Some(m), Some(c)) = (&main, &current) {
        if c != m {
            unmerged = git(&cwd, &["rev-list", "--count", &format!("{m}..HEAD")]).ok().and_then(|n| n.trim().parse().ok()).unwrap_or(0);
        }
    }
    Ok(json!({ "defaultBranch": main, "current": current, "unmerged": unmerged }))
}

/// Merge the current branch into the main branch and stay on main (ready to push).
/// Only with no uncommitted changes. If the merge conflicts, it is undone and
/// you stay on your branch.
fn merge_into_default(project_id: &str) -> Result<String, String> {
    let cwd = root(project_id)?;
    let st = status(project_id)?;
    if st["files"].as_array().is_some_and(|f| !f.is_empty()) {
        return Err("Commit (or discard) your changes before merging.".into());
    }
    let main = default_branch(&cwd).ok_or("Could not find the main branch.")?;
    let current = current_branch(&cwd).filter(|c| *c != main).ok_or_else(|| format!("You are already on {main}."))?;
    git(&cwd, &["switch", &main])?;
    let merged = (|| {
        // Bring main up to date first, when it tracks a remote branch.
        let up = git(&cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).unwrap_or_default();
        if !up.trim().is_empty() {
            git_with(&cwd, &["pull", "--ff-only"], None, 300, &[])?;
        }
        git_with(&cwd, &["merge", "--no-edit", &current], None, 300, &[])
    })();
    if let Err(msg) = merged {
        let _ = git(&cwd, &["merge", "--abort"]);
        let _ = git(&cwd, &["switch", &current]);
        if msg.to_lowercase().contains("conflict") {
            return Err(format!("{current} and {main} changed the same lines, so git can't merge them by itself. Nothing was changed. Ask Claude Code in the Terminal: \"merge {current} into {main} and resolve the conflicts\"."));
        }
        return Err(format!("Merge stopped and was undone; you are back on {current}. {msg}"));
    }
    Ok(format!("Merged {current} into {main}. You're now on {main}. Push to send it to GitHub."))
}

/// The two sides of a diff: HEAD (or the staged copy) against the working file.
fn diff_sides(project_id: &str, project_path: &str, staged: bool) -> Res {
    let cwd = root(project_id)?;
    let path = check_paths(in_repo(project_id, &[project_path.to_string()])?)?.remove(0);
    let show = |spec: String| git(&cwd, &["show", &spec]).unwrap_or_default();
    if staged {
        return Ok(json!({ "original": show(format!("HEAD:{path}")), "modified": show(format!(":{path}")) }));
    }
    let mut original = show(format!(":{path}"));
    if original.is_empty() {
        original = show(format!("HEAD:{path}"));
    }
    let modified = fs::read(cwd.join(&path)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    Ok(json!({ "original": original, "modified": modified }))
}

fn with_paths(base: &[&str], paths: &[String]) -> Vec<String> {
    base.iter().map(|s| s.to_string()).chain(paths.iter().cloned()).collect()
}

fn stage(project_id: &str, paths: &[String]) -> Result<(), String> {
    let cwd = root(project_id)?;
    git(&cwd, &with_paths(&["add", "-A", "--"], &check_paths(in_repo(project_id, paths)?)?)).map(|_| ())
}

fn unstage(project_id: &str, project_paths: &[String]) -> Result<(), String> {
    let cwd = root(project_id)?;
    let paths = check_paths(in_repo(project_id, project_paths)?)?;
    if git(&cwd, &with_paths(&["restore", "--staged", "--"], &paths)).is_err() {
        // Before the first commit there is no HEAD to restore from.
        git(&cwd, &with_paths(&["rm", "--cached", "-r", "-q", "--"], &paths))?;
    }
    Ok(())
}

/// Throw away local changes. Untracked files are removed.
fn discard(project_id: &str, project_paths: &[String]) -> Result<(), String> {
    let cwd = root(project_id)?;
    let st = status(project_id)?;
    let is_new = |p: &String| {
        st["files"].as_array().into_iter().flatten().find(|f| f["path"] == p.as_str()).is_some_and(|f| f["untracked"] == true)
    };
    let (untracked, tracked): (Vec<String>, Vec<String>) = project_paths.iter().cloned().partition(is_new);
    let untracked = check_paths(in_repo(project_id, &untracked)?)?;
    let tracked = check_paths(in_repo(project_id, &tracked)?)?;
    if !tracked.is_empty() {
        git(&cwd, &with_paths(&["restore", "--worktree", "--"], &tracked))?;
    }
    if !untracked.is_empty() {
        git(&cwd, &with_paths(&["clean", "-f", "-q", "--"], &untracked))?;
    }
    Ok(())
}

fn commit(project_id: &str, message: &str) -> Result<String, String> {
    let cwd = root(project_id)?;
    if message.trim().is_empty() {
        return Err("Write a commit message first.".into());
    }
    git_with(&cwd, &["commit", "-F", "-"], Some(message), 120, &[])?;
    Ok(git(&cwd, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

fn push(project_id: &str) -> Result<String, String> {
    let cwd = root(project_id)?;
    let st = status(project_id)?;
    let args: &[&str] = if st["upstream"].is_string() { &["push"] } else { &["push", "-u", "origin", "HEAD"] };
    git_with(&cwd, args, None, 300, &[]).map(|o| or(o.trim(), "Pushed."))
}

fn local_branches(cwd: &Path) -> Vec<String> {
    git(cwd, &["branch", "--format=%(refname:short)"]).unwrap_or_default().split('\n').filter(|b| !b.is_empty()).map(str::to_string).collect()
}

fn branches(project_id: &str) -> Res {
    let cwd = root(project_id)?;
    let local = local_branches(&cwd);
    let remote: Vec<String> = git(&cwd, &["branch", "-r", "--format=%(refname:short)"])
        .unwrap_or_default()
        .split('\n')
        .filter(|b| !b.is_empty() && !b.ends_with("/HEAD") && b.contains('/'))
        .map(str::to_string)
        .collect();
    Ok(json!({ "current": current_branch(&cwd), "local": local, "remote": remote }))
}

fn switch_branch(project_id: &str, name: &str, create: bool) -> Result<(), String> {
    let cwd = root(project_id)?;
    if !Regex::new(r"^[A-Za-z0-9_./-]+$").unwrap().is_match(name) || name.starts_with('-') {
        return Err("Invalid branch name.".into());
    }
    if create {
        git(&cwd, &["switch", "-c", name])?;
    } else if name.contains('/') && !local_branches(&cwd).iter().any(|b| b == name) {
        // A remote branch like origin/feature: create a local tracking branch.
        git(&cwd, &["switch", "--track", name])?;
    } else {
        git(&cwd, &["switch", name])?;
    }
    Ok(())
}

fn log(project_id: &str, limit: u32, since: Option<&str>) -> Res {
    let cwd = root(project_id)?;
    let mut args = vec![format!("-{limit}")];
    if let Some(s) = since.filter(|s| !s.is_empty()) {
        args.push(format!("--since={s}"));
    }
    args.push("--pretty=format:%h%x1f%s%x1f%an%x1f%cI%x1e".into());
    let out = git(&cwd, &with_paths(&["log"], &args)).unwrap_or_default();
    Ok(Value::Array(out.split('\x1e').map(str::trim).filter(|r| !r.is_empty()).map(parse_commit).collect()))
}

fn parse_commit(r: &str) -> Value {
    let mut f = r.split('\x1f');
    let mut c = serde_json::Map::new();
    for key in ["hash", "subject", "author", "date"] {
        if let Some(v) = f.next() {
            c.insert(key.into(), v.into());
        }
    }
    Value::Object(c)
}

/// Staged diff text, for writing a commit message with Claude.
pub fn staged_diff(project_id: &str, max_chars: usize) -> Result<String, String> {
    let cwd = root(project_id)?;
    // Never show .env files (secrets) to Claude.
    let no_secrets = ["--", ".", ":(exclude).env", ":(exclude).env.*", ":(exclude)**/.env", ":(exclude)**/.env.*", ":(exclude)*.env"];
    let stat = git(&cwd, &[&["diff", "--cached", "--stat"][..], &no_secrets].concat())?;
    let diff = git(&cwd, &[&["diff", "--cached", "--no-ext-diff", "-U2"][..], &no_secrets].concat())?;
    let body = if diff.chars().count() > max_chars { format!("{}\n… (diff truncated)", diff.chars().take(max_chars).collect::<String>()) } else { diff };
    Ok(format!("{stat}\n{body}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn porcelain_status() {
        let out = "## main...origin/main [ahead 1, behind 2]\0 M a.txt\0R  new.txt\0old.txt\0?? n.txt\0UU c.txt\0";
        let (h, files) = parse_status(out, "web/");
        assert_eq!((h.branch.as_deref(), h.upstream.as_deref(), h.ahead, h.behind), (Some("main"), Some("origin/main"), 1, 2));
        assert_eq!(files.len(), 4);
        assert_eq!(files[0]["path"], "web/a.txt");
        assert_eq!((files[0]["staged"].as_bool(), files[0]["unstaged"].as_bool()), (Some(false), Some(true)));
        assert_eq!(files[1]["oldPath"], "web/old.txt");
        assert_eq!(files[2]["untracked"], true);
        assert_eq!(files[3]["conflicted"], true);
        let (h, _) = parse_status("## No commits yet on dev\0", "");
        assert_eq!((h.branch.as_deref(), h.upstream), (Some("dev"), None));
    }
    #[test]
    fn path_escapes() {
        assert!(!escapes("a/b.txt") && !escapes("a/../b"));
        assert!(escapes("../x") && escapes("a/../../x") && escapes("/etc/passwd"));
    }
}
