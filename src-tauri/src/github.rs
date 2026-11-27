// All GitHub access goes through the `gh` CLI, so it uses the login the user
// already has (`gh auth login`) and the app never stores a token.
use crate::{
    store,
    util::{now, run, uid, upsert, Args, Res},
};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "gh:status" => Ok(gh_status()),
        "gh:repos" => list_repos(a.opt_s(0).filter(|o| !o.is_empty())),
        "gh:clone" => clone_repo(&a.s(0), &a.s(1)),
        "gh:team" => team(&a.s(0)),
        "gh:invite" => invite(&a.s(0), &a.s(1)),
        "gh:sync" => {
            // Auto-sync and the Sync button can overlap; two runs would open duplicate issues.
            static SYNC: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let Ok(_guard) = SYNC.try_lock() else { return Some(Err("A sync is already running.".into())) };
            sync_issues(&a.s(0)).map(|result| json!({ "db": store::load(), "result": result }))
        }
        _ => return None,
    })
}

fn gh_status() -> Value {
    match gh(&["api", "user", "--jq", ".login"]) {
        Ok(user) => {
            let user = user.trim();
            json!({ "ok": true, "user": user, "message": format!("Signed in as {user}") })
        }
        Err(msg) => {
            let m = msg.to_lowercase();
            let message = if ["enoent", "not recognized", "not found"].iter().any(|s| m.contains(s)) {
                "GitHub CLI (gh) is not installed. Get it from cli.github.com."
            } else {
                "Not signed in. Run \"gh auth login\" in a terminal."
            };
            json!({ "ok": false, "user": null, "message": message })
        }
    }
}

fn parse(text: &str) -> Res {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

fn list_repos(owner: Option<String>) -> Res {
    let mut args = vec!["repo".to_string(), "list".into()];
    args.extend(owner);
    args.extend(["--limit", "200", "--json", "nameWithOwner,description,isPrivate,updatedAt"].map(String::from));
    parse(&run("gh", &args, None, None)?)
}

fn clone_repo(repo: &str, parent_dir: &str) -> Res {
    let name = repo.split('/').nth(1).ok_or("Invalid repository name.")?;
    let dest = Path::new(parent_dir).join(name);
    if dest.exists() {
        return Err(format!("Folder already exists: {}", dest.display()));
    }
    let d = dest.to_string_lossy().into_owned();
    gh(&["repo", "clone", repo, &d])?;
    Ok(Value::String(d))
}

// Both end up in an API path, so only GitHub's own character sets get through.
fn valid_repo(repo: &str) -> bool {
    let ok = |p: &str| !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    matches!(repo.split_once('/'), Some((o, n)) if ok(o) && ok(n))
}

fn valid_login(login: &str) -> bool {
    (1..=39).contains(&login.len()) && !login.starts_with('-') && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// One JSON value per line (what `gh api --paginate --jq '.[] | …'` prints).
fn json_lines(text: &str) -> Vec<Value> {
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// The repo's collaborators and pending invites. Listing needs push access;
/// invites need admin, so they're left out quietly when we can't see them.
fn team(repo: &str) -> Res {
    if !valid_repo(repo) {
        return Err("Invalid repository name.".into());
    }
    let members = gh(&["api", &format!("repos/{repo}/collaborators?per_page=100"), "--paginate", "--jq", ".[] | {login, role: .role_name}"])?;
    let invited = gh(&["api", &format!("repos/{repo}/invitations?per_page=100"), "--paginate", "--jq", ".[] | .invitee.login"]).unwrap_or_default();
    Ok(json!({ "members": json_lines(&members), "invited": json_lines(&invited) }))
}

/// GitHub emails the invite; people in the repo's organization are added straight away.
fn invite(repo: &str, login: &str) -> Res {
    let login = login.trim().trim_start_matches('@');
    if !valid_repo(repo) {
        return Err("Invalid repository name.".into());
    }
    if !valid_login(login) {
        return Err("That isn't a valid GitHub username.".into());
    }
    gh(&["api", "-X", "PUT", &format!("repos/{repo}/collaborators/{login}"), "-f", "permission=push"])?;
    Ok(Value::Null)
}

/// Run the GitHub CLI. Automated checks can point VIBE_FAKE_GH at a stand-in script.
fn gh<S: AsRef<str>>(args: &[S]) -> Result<String, String> {
    let args: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
    match std::env::var("VIBE_FAKE_GH") {
        Ok(fake) if !fake.is_empty() => run("node", &[&[fake.as_str()][..], &args].concat(), None, None),
        _ => run("gh", &args, None, None),
    }
}

/// GitHub stores due dates as timestamps; noon UTC keeps the same calendar day everywhere.
fn gh_state(m: &Value) -> &'static str {
    if m["status"] == "delivered" { "closed" } else { "open" }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

/// First 10 characters (the YYYY-MM-DD of a timestamp).
fn day(t: &str) -> String {
    t.chars().take(10).collect()
}

fn milestone_args(m: &Value) -> Vec<String> {
    vec![
        "-f".into(), format!("title={}", s(m, "title")),
        "-f".into(), format!("state={}", gh_state(m)),
        "-f".into(), format!("description={}", s(m, "notes")),
        "-f".into(), format!("due_on={}T12:00:00Z", s(m, "dueDate")),
    ]
}

fn err_push(result: &mut Value, msg: String) {
    result["errors"].as_array_mut().unwrap().push(Value::String(msg));
}

fn bump(result: &mut Value, k: &str) {
    result[k] = json!(result[k].as_u64().unwrap_or(0) + 1);
}

/// Two-way sync of delivery milestones with GitHub milestones. Returns the
/// GitHub milestone number -> local milestone map used to link issues.
fn sync_milestones(project_id: &str, repo: &str, result: &mut Value) -> Result<HashMap<u64, Value>, String> {
    let remote: Vec<Value> = serde_json::from_str(&gh(&["api", &format!("repos/{repo}/milestones?state=all&per_page=100")])?).map_err(|e| e.to_string())?;
    let local: Vec<Value> = store::load()["milestones"].as_array().into_iter().flatten().filter(|m| m["projectId"] == project_id).cloned().collect();
    let known: Vec<u64> = local.iter().filter_map(|m| m["githubNumber"].as_u64()).collect();
    let mut changes: Vec<Value> = vec![];
    let stamp = now();

    for r in &remote {
        if r["number"].as_u64().is_some_and(|n| known.contains(&n)) {
            continue;
        }
        changes.push(json!({
            "id": uid(), "projectId": project_id, "title": r["title"],
            "dueDate": day(r["due_on"].as_str().unwrap_or(&stamp)),
            "status": if r["state"] == "closed" { "delivered" } else { "planned" },
            "notes": r["description"].as_str().unwrap_or_default(),
            "githubNumber": r["number"], "updatedAt": stamp, "syncedAt": stamp
        }));
        bump(result, "milestones");
    }

    for m in &local {
        let mut step = || -> Result<(), String> {
            let Some(num) = m["githubNumber"].as_u64() else {
                let created = parse(&gh(&[&["api", "-X", "POST", &format!("repos/{repo}/milestones")].map(String::from)[..], &milestone_args(m)].concat())?)?;
                let mut c = m.clone();
                c["githubNumber"] = created["number"].clone();
                c["syncedAt"] = json!(now());
                c["updatedAt"] = json!(now());
                changes.push(c);
                bump(result, "milestones");
                return Ok(());
            };
            let Some(r) = remote.iter().find(|x| x["number"] == num) else { return Ok(()) };
            let synced = m["syncedAt"].as_str().filter(|x| !x.is_empty());
            let updated = s(m, "updatedAt");
            let r_updated = s(r, "updated_at");
            let local_changed = synced.is_none_or(|t| updated > t);
            let remote_changed = synced.is_none_or(|t| r_updated > t);
            if local_changed && (!remote_changed || updated >= r_updated) {
                let differs = r["title"] != m["title"]
                    || s(r, "state") != gh_state(m)
                    || s(r, "description") != s(m, "notes")
                    || day(s(r, "due_on")) != s(m, "dueDate");
                if differs {
                    gh(&[&["api", "-X", "PATCH", &format!("repos/{repo}/milestones/{num}")].map(String::from)[..], &milestone_args(m)].concat())?;
                    bump(result, "milestones");
                }
                let t = now();
                let mut c = m.clone();
                c["syncedAt"] = json!(t);
                c["updatedAt"] = json!(t);
                changes.push(c);
            } else if remote_changed {
                let mut status = s(m, "status").to_string();
                if r["state"] == "closed" {
                    status = "delivered".into();
                } else if status == "delivered" {
                    status = "planned".into();
                }
                let mut next = m.clone();
                next["title"] = r["title"].clone();
                next["notes"] = json!(s(r, "description"));
                if let Some(d) = r["due_on"].as_str().filter(|d| !d.is_empty()) {
                    next["dueDate"] = json!(day(d));
                }
                next["status"] = json!(status);
                if next["title"] != m["title"] || s(&next, "notes") != s(m, "notes") || next["dueDate"] != m["dueDate"] || next["status"] != m["status"] {
                    bump(result, "milestones");
                }
                let t = now();
                next["syncedAt"] = json!(t);
                next["updatedAt"] = json!(t);
                changes.push(next);
            }
            Ok(())
        };
        if let Err(e) = step() {
            err_push(result, format!("Milestone \"{}\": {e}", s(m, "title")));
        }
    }

    store::mutate(|db| {
        for c in changes {
            upsert(&mut db["milestones"], c);
        }
    });
    let mut map = HashMap::new();
    for m in store::load()["milestones"].as_array().into_iter().flatten() {
        if let (true, Some(n)) = (m["projectId"] == project_id, m["githubNumber"].as_u64()) {
            map.insert(n, m.clone());
        }
    }
    Ok(map)
}

const BUG_LABEL: &str = "bug";
const FEATURE_LABEL: &str = "enhancement";

fn ensure_labels(repo: &str) {
    // --force creates the label or leaves it as is; ignore failures (e.g. no admin rights).
    let _ = gh(&["label", "create", BUG_LABEL, "-R", repo, "--color", "d73a4a", "--force"]);
    let _ = gh(&["label", "create", FEATURE_LABEL, "-R", repo, "--color", "a2eeef", "--force"]);
}

// Board column and priority travel as "status:<id>" / "priority:<id>" labels so a
// team shares one board. Done is the closed state, so it has no status label.
const OPEN_STATUSES: [&str; 4] = ["backlog", "todo", "in_progress", "review"];
const PRIORITIES: [&str; 4] = ["low", "medium", "high", "critical"];

fn is_managed(label: &str) -> bool {
    label.starts_with("status:") || label.starts_with("priority:")
}

fn wanted_labels(item: &Value) -> Vec<String> {
    let mut v = vec![];
    let st = s(item, "status");
    if OPEN_STATUSES.contains(&st) {
        v.push(format!("status:{st}"));
    }
    let p = s(item, "priority");
    if PRIORITIES.contains(&p) {
        v.push(format!("priority:{p}"));
    }
    v
}

fn issue_labels(issue: &Value) -> Vec<String> {
    issue["labels"].as_array().into_iter().flatten().map(|l| s(l, "name").to_string()).collect()
}

/// The value of a "key:value" label, if it is one we know.
fn label_value(labels: &[String], key: &str, allowed: &[&str]) -> Option<String> {
    labels.iter().find_map(|l| l.strip_prefix(key)?.strip_prefix(':').filter(|v| allowed.contains(v)).map(String::from))
}

/// Labels to (add, remove) so the issue matches the item's column and priority.
fn label_diff(item: &Value, issue: &Value) -> (Vec<String>, Vec<String>) {
    let want = wanted_labels(item);
    let have: Vec<String> = issue_labels(issue).into_iter().filter(|l| is_managed(l)).collect();
    (
        want.iter().filter(|l| !have.contains(l)).cloned().collect(),
        have.iter().filter(|l| !want.contains(l)).cloned().collect(),
    )
}

/// `gh issue edit --add-label` fails on labels the repo doesn't have yet.
fn ensure_label(repo: &str, name: &str, made: &mut Vec<String>) {
    if made.iter().any(|m| m == name) {
        return;
    }
    let color = if name.starts_with("status:") { "c5def5" } else { "fbca04" };
    let _ = gh(&["label", "create", name, "-R", repo, "--color", color, "--force"]);
    made.push(name.to_string());
}

/// Returns whether anything was changed on GitHub.
fn push_labels(repo: &str, num: &str, item: &Value, issue: &Value, made: &mut Vec<String>) -> Result<bool, String> {
    let (add, remove) = label_diff(item, issue);
    if add.is_empty() && remove.is_empty() {
        return Ok(false);
    }
    let mut args: Vec<String> = ["issue", "edit", num, "-R", repo].map(String::from).to_vec();
    if !add.is_empty() {
        add.iter().for_each(|l| ensure_label(repo, l, made));
        args.extend(["--add-label".into(), add.join(",")]);
    }
    if !remove.is_empty() {
        args.extend(["--remove-label".into(), remove.join(",")]);
    }
    gh(&args)?;
    Ok(true)
}

fn issue_assignees(issue: &Value) -> Vec<String> {
    let mut v: Vec<String> = issue["assignees"].as_array().into_iter().flatten().map(|a| s(a, "login").to_string()).collect();
    v.sort();
    v
}

/// GitHub logins on the item; None for items from before assignees synced (leave GitHub's alone).
fn item_assignees(item: &Value) -> Option<Vec<String>> {
    let mut v: Vec<String> = item["assignees"].as_array()?.iter().filter_map(|a| a.as_str()).map(|a| a.trim().trim_start_matches('@').to_string()).filter(|a| !a.is_empty()).collect();
    v.sort();
    v.dedup();
    Some(v)
}

fn push_assignees(repo: &str, num: &str, item: &Value, issue: &Value) -> Result<(), String> {
    let Some(want) = item_assignees(item) else { return Ok(()) };
    let have = issue_assignees(issue);
    let add: Vec<&str> = want.iter().filter(|a| !have.contains(a)).map(String::as_str).collect();
    let remove: Vec<&str> = have.iter().filter(|a| !want.contains(a)).map(String::as_str).collect();
    let mut args: Vec<String> = ["issue", "edit", num, "-R", repo].map(String::from).to_vec();
    if !add.is_empty() {
        args.extend(["--add-assignee".into(), add.join(",")]);
    }
    if !remove.is_empty() {
        args.extend(["--remove-assignee".into(), remove.join(",")]);
    }
    if args.len() > 5 {
        gh(&args)?;
    }
    Ok(())
}

/// Two-way sync between a project's bugs/features and its GitHub Issues.
/// - Issues not yet in the app are imported (label "bug" -> bug, otherwise feature).
/// - Items created in the app are opened as issues.
/// - Whichever side changed more recently wins for title, body, open/closed,
///   assignees, board column and priority (the last two as status:/priority: labels).
fn sync_issues(project_id: &str) -> Res {
    let db = store::load();
    let project = db["projects"].as_array().into_iter().flatten().find(|p| p["id"] == project_id);
    let repo = project.and_then(|p| p["repo"].as_str()).filter(|r| !r.is_empty()).ok_or("This project has no GitHub repository set.")?.to_string();
    let mut result = json!({ "pulled": 0, "created": 0, "updated": 0, "milestones": 0, "errors": [] });

    // Milestones first, so issues can be linked to them.
    let milestones = sync_milestones(project_id, &repo, &mut result).unwrap_or_else(|e| {
        err_push(&mut result, format!("Milestones: {e}"));
        HashMap::new()
    });
    let local_milestone = |id: &Value| -> Option<&Value> { id.as_str().and_then(|id| milestones.values().find(|m| m["id"] == id)) };
    let linked_id = |issue: &Value| issue["milestone"]["number"].as_u64().and_then(|n| milestones.get(&n)).map(|m| m["id"].clone());

    let issues: Vec<Value> = serde_json::from_str(&gh(&[
        "issue", "list", "-R", &repo, "--state", "all", "--limit", "500", "--json", "number,title,body,state,url,labels,updatedAt,milestone,assignees",
    ])?)
    .map_err(|e| e.to_string())?;
    let items: Vec<Value> = store::load()["workItems"].as_array().into_iter().flatten().filter(|w| w["projectId"] == project_id).cloned().collect();
    let known: Vec<u64> = items.iter().filter_map(|w| w["githubNumber"].as_u64()).collect();

    let mut changes: Vec<Value> = vec![];
    let stamp = now();

    // 1. Import new issues.
    for issue in &issues {
        if issue["number"].as_u64().is_some_and(|n| known.contains(&n)) {
            continue;
        }
        let labels = issue_labels(issue);
        let is_bug = labels.iter().any(|l| l.to_lowercase() == BUG_LABEL);
        let status = if issue["state"] == "CLOSED" { "done".into() } else { label_value(&labels, "status", &OPEN_STATUSES).unwrap_or("backlog".into()) };
        changes.push(json!({
            "id": uid(), "projectId": project_id,
            "kind": if is_bug { "bug" } else { "feature" },
            "title": issue["title"], "body": s(issue, "body"),
            "status": status,
            "priority": label_value(&labels, "priority", &PRIORITIES).unwrap_or("medium".into()),
            "assignees": issue_assignees(issue),
            "milestoneId": linked_id(issue).unwrap_or(Value::Null),
            "githubNumber": issue["number"], "githubUrl": issue["url"],
            "createdAt": issue["updatedAt"], "updatedAt": stamp, "syncedAt": stamp
        }));
        bump(&mut result, "pulled");
    }

    // 2. Push or pull existing items.
    let mut labels_ready = false;
    let mut made: Vec<String> = vec![];
    for item in &items {
        let mut step = || -> Result<(), String> {
            let title = s(item, "title");
            let body = s(item, "body");
            let Some(num) = item["githubNumber"].as_u64() else {
                if !labels_ready {
                    ensure_labels(&repo);
                    labels_ready = true;
                }
                let mut args: Vec<String> = ["issue", "create", "-R", &repo, "--title", title, "--body"].map(String::from).to_vec();
                args.push(if body.is_empty() { "_Created with Vibeloft_" } else { body }.into());
                for a in item_assignees(item).into_iter().flatten() {
                    args.extend(["--assignee".into(), a]);
                }
                args.extend(["--label".into(), if item["kind"] == "bug" { BUG_LABEL } else { FEATURE_LABEL }.into()]);
                for l in wanted_labels(item) {
                    ensure_label(&repo, &l, &mut made);
                    args.extend(["--label".into(), l]);
                }
                if let Some(m) = local_milestone(&item["milestoneId"]) {
                    args.extend(["--milestone".into(), s(m, "title").into()]);
                }
                let url = gh(&args)?.trim().to_string();
                let number: Value = url.rsplit('/').next().and_then(|n| n.parse::<u64>().ok()).map_or(Value::Null, Value::from);
                if item["status"] == "done" {
                    gh(&["issue", "close", &number.to_string(), "-R", &repo])?;
                }
                let mut c = item.clone();
                c["githubNumber"] = number;
                c["githubUrl"] = json!(url);
                c["syncedAt"] = json!(stamp);
                c["updatedAt"] = json!(stamp);
                changes.push(c);
                bump(&mut result, "created");
                return Ok(());
            };

            // Deleted or transferred on GitHub; leave the local copy alone.
            let Some(issue) = issues.iter().find(|i| i["number"] == num) else { return Ok(()) };
            let n = num.to_string();
            let synced = item["syncedAt"].as_str().filter(|x| !x.is_empty());
            let updated = s(item, "updatedAt");
            let i_updated = s(issue, "updatedAt");
            let local_changed = synced.is_none_or(|t| updated > t);
            let remote_changed = synced.is_none_or(|t| i_updated > t);

            if local_changed && (!remote_changed || updated >= i_updated) {
                // Local wins: push.
                if s(issue, "title") != title || s(issue, "body") != body {
                    gh(&["issue", "edit", &n, "-R", &repo, "--title", title, "--body", body])?;
                }
                let want = local_milestone(&item["milestoneId"]);
                if issue["milestone"]["number"].as_u64() != want.and_then(|w| w["githubNumber"].as_u64()) {
                    match want {
                        Some(w) => gh(&["issue", "edit", &n, "-R", &repo, "--milestone", s(w, "title")])?,
                        None => gh(&["issue", "edit", &n, "-R", &repo, "--remove-milestone"])?,
                    };
                }
                let want_closed = item["status"] == "done";
                if want_closed && issue["state"] == "OPEN" {
                    gh(&["issue", "close", &n, "-R", &repo])?;
                }
                if !want_closed && issue["state"] == "CLOSED" {
                    gh(&["issue", "reopen", &n, "-R", &repo])?;
                }
                push_labels(&repo, &n, item, issue, &mut made)?;
                push_assignees(&repo, &n, item, issue)?;
                let mut c = item.clone();
                c["syncedAt"] = json!(stamp);
                c["updatedAt"] = json!(stamp);
                changes.push(c);
                bump(&mut result, "updated");
            } else if remote_changed {
                // GitHub wins: pull.
                // No status/priority label (issue from before labels, or edited without them): keep ours.
                let labels = issue_labels(issue);
                let mut status = s(item, "status").to_string();
                if issue["state"] == "CLOSED" {
                    status = "done".into();
                } else if let Some(v) = label_value(&labels, "status", &OPEN_STATUSES) {
                    status = v;
                } else if status == "done" {
                    status = "todo".into();
                }
                let priority = label_value(&labels, "priority", &PRIORITIES).unwrap_or_else(|| s(item, "priority").into());
                let milestone_id = if issue["milestone"].is_object() { linked_id(issue).unwrap_or_else(|| item["milestoneId"].clone()) } else { Value::Null };
                let same = s(issue, "title") == title
                    && s(issue, "body") == body
                    && status == s(item, "status")
                    && priority == s(item, "priority")
                    && item_assignees(item).as_ref() == Some(&issue_assignees(issue))
                    && milestone_id == item["milestoneId"];
                // Our own pushes bump GitHub's updatedAt too; only count real changes.
                let t = now();
                let mut c = item.clone();
                c["title"] = issue["title"].clone();
                c["body"] = json!(s(issue, "body"));
                c["status"] = json!(status);
                c["priority"] = json!(priority);
                c["assignees"] = json!(issue_assignees(issue));
                c["milestoneId"] = milestone_id;
                c["syncedAt"] = json!(t);
                c["updatedAt"] = json!(t);
                changes.push(c);
                if !same {
                    bump(&mut result, "updated");
                }
            } else {
                // Neither side changed, but the item predates labels/assignees: fill them in once.
                if push_labels(&repo, &n, item, issue, &mut made)? {
                    bump(&mut result, "updated");
                }
                if item_assignees(item).is_none() {
                    let mut c = item.clone();
                    c["assignees"] = json!(issue_assignees(issue));
                    changes.push(c);
                }
            }
            Ok(())
        };
        if let Err(e) = step() {
            err_push(&mut result, format!("{}: {e}", s(item, "title")));
        }
    }

    store::mutate(|db| {
        for c in changes {
            upsert(&mut db["workItems"], c);
        }
        if let Some(p) = db["projects"].as_array_mut().and_then(|ps| ps.iter_mut().find(|p| p["id"] == project_id)) {
            p["lastSyncedAt"] = json!(stamp);
        }
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(labels: &[&str]) -> Value {
        json!({ "labels": labels.iter().map(|n| json!({ "name": n })).collect::<Vec<_>>() })
    }

    #[test]
    fn labels_round_trip() {
        let item = json!({ "status": "in_progress", "priority": "high" });
        assert_eq!(wanted_labels(&item), ["status:in_progress", "priority:high"]);
        let labels = issue_labels(&issue(&["bug", "status:in_progress", "priority:high"]));
        assert_eq!(label_value(&labels, "status", &OPEN_STATUSES).as_deref(), Some("in_progress"));
        assert_eq!(label_value(&labels, "priority", &PRIORITIES).as_deref(), Some("high"));
        // Unknown values and other labels are ignored.
        assert_eq!(label_value(&issue_labels(&issue(&["status:wat", "statusx:todo"])), "status", &OPEN_STATUSES), None);
        // Done is the closed state: no status label.
        assert_eq!(wanted_labels(&json!({ "status": "done", "priority": "low" })), ["priority:low"]);
    }

    #[test]
    fn team_inputs_are_checked() {
        assert!(valid_repo("Leadows-AI/vibe.loft_2"));
        assert!(!valid_repo("a/../b") && !valid_repo("a/..") && !valid_repo("nope") && !valid_repo("a/b?x=1"));
        assert!(valid_login("ana-z9"));
        assert!(!valid_login("-ana") && !valid_login("") && !valid_login("a/b") && !valid_login(&"a".repeat(40)));
        assert_eq!(json_lines("{\"login\":\"ana\"}\n\n\"zoe\"\n"), [json!({ "login": "ana" }), json!("zoe")]);
    }

    #[test]
    fn assignees_normalise() {
        let issue = json!({ "assignees": [{ "login": "zoe" }, { "login": "ana" }] });
        assert_eq!(issue_assignees(&issue), ["ana", "zoe"]);
        assert_eq!(item_assignees(&json!({ "assignees": [" @zoe", "ana", "", "zoe"] })), Some(vec!["ana".into(), "zoe".into()]));
        // Older items have no list: GitHub's assignees are left alone.
        assert_eq!(item_assignees(&json!({})), None);
    }

    #[test]
    fn diff_only_touches_managed_labels() {
        let item = json!({ "status": "review", "priority": "medium" });
        let (add, remove) = label_diff(&item, &issue(&["bug", "status:todo", "priority:medium", "status:review2"]));
        assert_eq!(add, ["status:review"]);
        assert_eq!(remove, ["status:todo", "status:review2"]);
        let (add, remove) = label_diff(&item, &issue(&["enhancement", "status:review", "priority:medium"]));
        assert!(add.is_empty() && remove.is_empty());
    }
}
