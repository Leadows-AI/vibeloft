// Restore points before each Claude prompt.
//
// Checkpoints: snapshots of a project's files taken before Claude works, so
// "Undo what Claude did" can put them back.
//
// Each one is a git commit stored under refs/vibeloft/checkpoints/. It is made
// with a temporary index, so your staging area, branches and history are never
// touched, and refs outside refs/heads and refs/tags are never pushed. Files
// ignored by .gitignore (node_modules, .env, …) are not included and are never
// changed by an undo.
//
// A project folder can hold several repositories (one per app): a checkpoint
// is then a ref with the same id in each of them, taken and restored together.
use crate::{
    gitops::{escapes, git, git_with, project_dir, repos, sub},
    util::{now, uid, Args, Res},
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    let id = a.s(0);
    Some(match ch {
        "checkpoint:create" => create_checkpoint(&id, &a.s(1)),
        "checkpoint:list" => list_checkpoints(&id).map(Value::Array),
        "checkpoint:changes" => changes_since(&id, &arg_str(a, 1)).map(Value::Array),
        "checkpoint:file" => file_since(&id, &arg_str(a, 1), &arg_str(a, 2)),
        "checkpoint:restore" => restore_checkpoint(&id, &arg_str(a, 1)),
        _ => return None,
    })
}

/// TS `String(x)`: checkpoint ids may arrive as numbers.
fn arg_str(a: &Args, i: usize) -> String {
    match a.v(i) {
        Value::String(s) => s,
        v => v.to_string(),
    }
}

const PREFIX: &str = "refs/vibeloft/checkpoints/";
const KEEP: usize = 40;
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FIVE_MIN: u64 = 300;

fn git_dir(cwd: &Path) -> Result<PathBuf, String> {
    Ok(PathBuf::from(git(cwd, &["rev-parse", "--absolute-git-dir"])?.trim()))
}

static ATTR_SOURCE_WORKS: OnceLock<bool> = OnceLock::new();

/// Git options that store and restore files byte for byte: no line-ending
/// conversion (core.autocrlf, .gitattributes), so an undo gives back exactly
/// the bytes that were there.
fn raw_opts(cwd: &Path) -> Vec<String> {
    let mut o: Vec<String> = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"].map(String::from).to_vec();
    // --attr-source needs git 2.42+.
    if *ATTR_SOURCE_WORKS.get_or_init(|| git(cwd, &["--attr-source", EMPTY_TREE, "rev-parse", "--git-dir"]).is_ok()) {
        o.extend(["--attr-source".into(), EMPTY_TREE.into()]);
    }
    o
}

fn with(base: Vec<String>, rest: &[&str]) -> Vec<String> {
    base.into_iter().chain(rest.iter().map(|s| s.to_string())).collect()
}

/// A tree object of the working folder as it is right now (tracked + new files,
/// minus ignored). `raw` keeps exact bytes (for checkpoints); otherwise git's
/// normal line-ending rules apply (to compare with commits).
fn snapshot_tree(cwd: &Path, raw: bool) -> Result<String, String> {
    let dir = git_dir(cwd)?;
    if raw {
        // A separate index kept between snapshots, so unchanged files aren't re-read.
        let _ = fs::create_dir_all(dir.join("vibeloft"));
        let index = dir.join("vibeloft").join("index");
        let env = [("GIT_INDEX_FILE", index.to_str().unwrap_or_default())];
        let opts = raw_opts(cwd);
        git_with(cwd, &with(opts.clone(), &["add", "-A", "--", "."]), None, FIVE_MIN, &env)?;
        return Ok(git_with(cwd, &with(opts, &["write-tree"]), None, 120, &env)?.trim().to_string());
    }
    let tmp = std::env::temp_dir().join(format!("vibeloft-index-{}", uid()));
    let result = (|| {
        // Starting from the real index lets git skip re-reading unchanged files.
        let real = dir.join("index");
        if real.exists() {
            fs::copy(&real, &tmp).map_err(|e| e.to_string())?;
        }
        let env = [("GIT_INDEX_FILE", tmp.to_str().unwrap_or_default())];
        git_with(cwd, &["add", "-A", "--", "."], None, FIVE_MIN, &env)?;
        Ok(git_with(cwd, &["write-tree"], None, 120, &env)?.trim().to_string())
    })();
    let _ = fs::remove_file(&tmp);
    result
}

fn head_commit(cwd: &Path) -> Option<String> {
    Some(git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]).unwrap_or_default().trim().to_string()).filter(|s| !s.is_empty())
}

struct Repo {
    rel: String,
    cwd: PathBuf,
}

fn git_repos(project_id: &str) -> Result<Vec<Repo>, String> {
    let dir = project_dir(project_id)?;
    Ok(repos(project_id)?
        .into_iter()
        .map(|rel| Repo { cwd: sub(&dir, &rel), rel })
        .filter(|r| git(&r.cwd, &["rev-parse", "--is-inside-work-tree"]).is_ok())
        .collect())
}

/// Folders inside the outer repository that are repositories of their own (they have their own checkpoints).
fn inner_of(r: &Repo, all: &[Repo]) -> Vec<String> {
    if r.rel.is_empty() { all.iter().filter(|x| !x.rel.is_empty()).map(|x| x.rel.clone()).collect() } else { vec![] }
}

fn not_inner(inner: &[String], c: &Value) -> bool {
    let p = c["path"].as_str().unwrap_or_default();
    !inner.iter().any(|i| p == i || p.starts_with(&format!("{i}/")))
}

fn list_in(cwd: &Path) -> Vec<Value> {
    let format = "--format=%(refname)%1f%(objectname)%1f%(tree)%1f%(subject)%1f%(creatordate:iso-strict)";
    let out = git(cwd, &["for-each-ref", "--sort=-creatordate", format, PREFIX]).unwrap_or_default();
    out.split('\n')
        .filter(|l| !l.is_empty())
        .map(|line| {
            let f: Vec<&str> = line.split('\x1f').collect();
            let at = |i: usize| f.get(i).copied().unwrap_or_default();
            json!({ "id": at(0).get(PREFIX.len()..).unwrap_or_default(), "commit": at(1), "tree": at(2), "label": at(3), "at": at(4) })
        })
        .collect()
}

fn id_num(c: &Value) -> u64 {
    c["id"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn list_checkpoints(project_id: &str) -> Result<Vec<Value>, String> {
    let mut all: Vec<Value> = vec![];
    for r in git_repos(project_id)? {
        for c in list_in(&r.cwd) {
            if !all.iter().any(|x| x["id"] == c["id"]) {
                all.push(c);
            }
        }
    }
    all.sort_by_key(|c| std::cmp::Reverse(id_num(c)));
    Ok(all)
}

/// Create a checkpoint for a project; returns the checkpoint (TS `Checkpoint`) or null when nothing was saved.
/// Called by hooks.rs when a prompt is sent.
/// Take a checkpoint, unless nothing changed since the last one (then that one is returned).
pub fn create_checkpoint(project_id: &str, label: &str) -> Res {
    let rs = git_repos(project_id)?;
    if rs.is_empty() {
        return Ok(Value::Null); // no git repository: checkpoints need git
    }
    let mut snaps = vec![];
    for r in &rs {
        snaps.push((r, snapshot_tree(&r.cwd, true)?, list_in(&r.cwd)));
    }
    if let Some(last) = snaps[0].2.first() {
        if snaps.iter().all(|(_, tree, existing)| existing.first().is_some_and(|e| e["id"] == last["id"] && e["tree"] == tree.as_str())) {
            return Ok(last.clone());
        }
    }

    let id = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis()).to_string();
    let clean: String = Regex::new(r"\s+").unwrap().replace_all(label, " ").trim().chars().take(200).collect();
    let clean = if clean.is_empty() { "Checkpoint".to_string() } else { clean };
    let who = [
        ("GIT_AUTHOR_NAME", "Vibeloft"),
        ("GIT_AUTHOR_EMAIL", "checkpoint@vibeloft.local"),
        ("GIT_COMMITTER_NAME", "Vibeloft"),
        ("GIT_COMMITTER_EMAIL", "checkpoint@vibeloft.local"),
    ];
    let mut first = Value::Null;
    for (r, tree, existing) in &snaps {
        let mut args = vec!["commit-tree".to_string(), tree.clone()];
        if let Some(h) = head_commit(&r.cwd) {
            args.extend(["-p".into(), h]);
        }
        args.extend(["-m".into(), clean.clone()]);
        let commit = git_with(&r.cwd, &args, None, 120, &who)?.trim().to_string();
        git(&r.cwd, &["update-ref", &format!("{PREFIX}{id}"), &commit])?;
        // Keep the most recent ones only.
        for old in existing.iter().skip(KEEP - 1) {
            let _ = git(&r.cwd, &["update-ref", "-d", &format!("{PREFIX}{}", old["id"].as_str().unwrap_or_default())]);
        }
        if first.is_null() {
            first = json!({ "id": id, "commit": commit, "tree": tree, "label": clean, "at": now() });
        }
    }
    Ok(first)
}

fn parse_name_status(out: &str) -> Vec<Value> {
    let parts: Vec<&str> = out.split('\0').filter(|p| !p.is_empty()).collect();
    parts
        .as_chunks::<2>().0.iter()
        .map(|c| {
            let status = match c[0].chars().next() {
                Some('A') => "added",
                Some('D') => "deleted",
                _ => "modified",
            };
            json!({ "path": c[1], "status": status })
        })
        .collect()
}

/// Which files (project-relative) differ between `base` (a checkpoint id, or "HEAD") and the folder now.
fn changes_since(project_id: &str, base: &str) -> Result<Vec<Value>, String> {
    let rs = git_repos(project_id)?;
    let mut all = vec![];
    for r in &rs {
        let base_tree = resolve_base_tree(&r.cwd, base)?;
        // Commits store normalized line endings; checkpoints store exact bytes.
        let now_tree = snapshot_tree(&r.cwd, base != "HEAD")?;
        let Some(base_tree) = base_tree else { continue }; // e.g. a repository added after this checkpoint
        let out = git(&r.cwd, &["diff", "--name-status", "--no-renames", "-z", &base_tree, &now_tree])?;
        let inner = inner_of(r, &rs);
        for mut c in parse_name_status(&out).into_iter().filter(|c| not_inner(&inner, c)) {
            if !r.rel.is_empty() {
                c["path"] = json!(format!("{}/{}", r.rel, c["path"].as_str().unwrap_or_default()));
            }
            all.push(c);
        }
    }
    Ok(all)
}

fn is_checkpoint_id(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn resolve_base_tree(cwd: &Path, base: &str) -> Result<Option<String>, String> {
    if base == "HEAD" {
        // Before the first commit, compare against an empty tree.
        return Ok(Some(match head_commit(cwd) {
            Some(h) => format!("{h}^{{tree}}"),
            None => git_with(cwd, &["hash-object", "-t", "tree", "--stdin"], Some(""), 120, &[])?.trim().to_string(),
        }));
    }
    if !is_checkpoint_id(base) {
        return Err("Unknown checkpoint.".into());
    }
    let t = git(cwd, &["rev-parse", "--verify", "--quiet", &format!("{PREFIX}{base}^{{tree}}")]).unwrap_or_default();
    Ok(Some(t.trim().to_string()).filter(|s| !s.is_empty()))
}

/// Both sides of one file (project-relative path): as it was at `base`, and as it is now.
fn file_since(project_id: &str, base: &str, project_path: &str) -> Res {
    let rs = git_repos(project_id)?;
    let r = rs
        .iter()
        .find(|x| !x.rel.is_empty() && project_path.starts_with(&format!("{}/", x.rel)))
        .or_else(|| rs.iter().find(|x| x.rel.is_empty()))
        .ok_or("Not in a git repository.")?;
    let path = if r.rel.is_empty() { project_path } else { &project_path[r.rel.len() + 1..] };
    if escapes(path) {
        return Err("Invalid path.".into());
    }
    let abs = r.cwd.join(path);
    let original = match resolve_base_tree(&r.cwd, base)? {
        Some(tree) => git(&r.cwd, &["show", &format!("{tree}:{path}")]).unwrap_or_default(),
        None => String::new(),
    };
    let modified = fs::read(&abs).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    Ok(json!({ "original": original, "modified": modified }))
}

/// Put the folder back the way it was at a checkpoint. The current state is
/// saved as a new checkpoint first, so the undo itself can be undone.
fn restore_checkpoint(project_id: &str, id: &str) -> Res {
    if !is_checkpoint_id(id) {
        return Err("Unknown checkpoint.".into());
    }
    let target = list_checkpoints(project_id)?.into_iter().find(|c| c["id"] == id).ok_or("That checkpoint no longer exists.")?;
    let backup = create_checkpoint(project_id, &format!("Before undo to \"{}\"", target["label"].as_str().unwrap_or_default()))?;
    let rs = git_repos(project_id)?;
    let (mut restored, mut deleted) = (0, 0);
    for r in &rs {
        let commit = git(&r.cwd, &["rev-parse", "--verify", "--quiet", &format!("{PREFIX}{id}")]).unwrap_or_default().trim().to_string();
        if commit.is_empty() {
            continue; // a repository added after this checkpoint: left alone
        }
        let now_tree = snapshot_tree(&r.cwd, true)?;
        let diff = git(&r.cwd, &["diff", "--name-status", "--no-renames", "-z", &format!("{commit}^{{tree}}"), &now_tree])?;
        let inner = inner_of(r, &rs);
        let changes: Vec<Value> = parse_name_status(&diff).into_iter().filter(|c| not_inner(&inner, c)).collect();
        let path_of = |c: &Value| c["path"].as_str().unwrap_or_default().to_string();
        let to_restore: Vec<String> = changes.iter().filter(|c| c["status"] != "added").map(path_of).collect();
        let to_delete: Vec<String> = changes.iter().filter(|c| c["status"] == "added").map(path_of).collect();
        for chunk in to_restore.chunks(100) {
            let mut args = with(raw_opts(&r.cwd), &["restore", &format!("--source={commit}"), "--worktree", "--"]);
            args.extend(chunk.iter().cloned());
            git(&r.cwd, &args)?;
        }
        for p in &to_delete {
            if !escapes(p) {
                let _ = fs::remove_file(r.cwd.join(p));
            }
        }
        restored += to_restore.len();
        deleted += to_delete.len();
    }
    Ok(json!({ "restored": restored, "deleted": deleted, "backup": backup.get("id").cloned().unwrap_or(Value::Null) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn name_status() {
        let c = parse_name_status("A\0new.txt\0D\0gone.txt\0M\0a b.txt\0");
        assert_eq!(c, vec![
            json!({ "path": "new.txt", "status": "added" }),
            json!({ "path": "gone.txt", "status": "deleted" }),
            json!({ "path": "a b.txt", "status": "modified" }),
        ]);
    }
}
