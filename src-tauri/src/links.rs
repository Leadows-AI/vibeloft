// Linked projects: an app (the "consumer", e.g. a mobile app) that uses the
// API of another project (the "provider", e.g. a web app). Vibeloft watches the
// provider's API files and tells you when they changed since the consumer was
// last updated for them.
use crate::{
    store,
    util::{now, upsert, Args, Res},
};
use serde_json::{json, Value};
use std::path::Path;

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "link:save" => save_link(a.v(0)),
        "link:delete" => {
            let id = a.s(0);
            Ok(store::mutate(|db| {
                if let Some(l) = db["links"].as_array_mut() {
                    l.retain(|x| x["id"] != id.as_str());
                }
            }))
        }
        "link:synced" => mark_synced(&a.s(0)),
        "link:status" => Ok(link_status(&a.s(0))),
        _ => return None,
    })
}

fn git(cwd: &Path, args: &[String]) -> Result<String, String> {
    crate::gitops::git(cwd, args)
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// Git pathspecs for the API files; globs like backend/** work.
fn pathspecs(paths: &[String]) -> Vec<String> {
    let clean: Vec<String> = paths
        .iter()
        .map(|p| {
            let p = p.trim().replace('\\', "/");
            p.strip_prefix("./").map(str::to_string).unwrap_or(p)
        })
        .filter(|p| !p.is_empty() && !p.starts_with('/') && !p.contains(".."))
        .collect();
    if clean.is_empty() {
        vec![".".into()]
    } else {
        clean.iter().map(|p| format!(":(glob){p}")).collect()
    }
}

fn head(cwd: &Path) -> Option<String> {
    let out = git(cwd, &strs(&["rev-parse", "--verify", "--quiet", "HEAD"])).unwrap_or_default();
    Some(out.trim().to_string()).filter(|s| !s.is_empty())
}

fn find_link(id: &str) -> Option<Value> {
    store::load()["links"].as_array().and_then(|l| l.iter().find(|x| x["id"] == id)).cloned()
}

/// `a ?? b` for JSON values.
fn or(a: &Value, b: &Value) -> Value {
    if a.is_null() { b.clone() } else { a.clone() }
}

fn save_link(mut link: Value) -> Res {
    if !link.is_object() {
        return Err("Link missing.".into());
    }
    if link["consumerId"] == link["providerId"] {
        return Err("A project can’t be linked to itself.".into());
    }
    let existing = link["id"].as_str().and_then(find_link);
    let ex = existing.clone().unwrap_or_default();
    let mut synced_commit = or(&link["syncedCommit"], &ex["syncedCommit"]);
    // A new link starts "up to date": only later API changes count.
    if existing.is_none() && !synced_commit.as_str().is_some_and(|s| !s.is_empty()) {
        let provider = link["providerId"].as_str().unwrap_or_default();
        synced_commit = json!(head(&store::project_path(provider)?));
    }
    let synced_at = or(&or(&link["syncedAt"], &ex["syncedAt"]), &json!(now()));
    link["syncedCommit"] = synced_commit;
    link["syncedAt"] = synced_at;
    Ok(store::mutate(|db| upsert(&mut db["links"], link)))
}

/// The consumer has been updated for everything the provider has now.
fn mark_synced(id: &str) -> Res {
    let mut link = find_link(id).ok_or("Link not found.")?;
    let commit = head(&store::project_path(link["providerId"].as_str().unwrap_or_default())?);
    link["syncedCommit"] = json!(commit);
    link["syncedAt"] = json!(now());
    Ok(store::mutate(|db| upsert(&mut db["links"], link)))
}

/// API commits in the provider since the consumer was last updated, plus uncommitted API edits.
fn link_status(id: &str) -> Value {
    let fail = |error: &str| json!({ "linkId": id, "providerHead": null, "commits": [], "uncommitted": [], "error": error });
    let Some(link) = find_link(id) else { return fail("Link not found.") };
    let cwd = match store::project_path(link["providerId"].as_str().unwrap_or_default()) {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let provider_head = head(&cwd);
    let api_paths: Vec<String> = link["apiPaths"].as_array().map_or(vec![], |a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect());
    let specs = pathspecs(&api_paths);
    let synced = link["syncedCommit"].as_str().filter(|s| !s.is_empty());
    let range = match synced {
        Some(c) if git(&cwd, &["cat-file".into(), "-e".into(), format!("{c}^{{commit}}")]).is_ok() => format!("{c}..HEAD"),
        _ => match link["syncedAt"].as_str().filter(|s| !s.is_empty()) {
            Some(at) => format!("--since={at}"),
            None => "-0".into(),
        },
    };
    let out = if provider_head.is_some() {
        let mut args = strs(&["log", "-50", &range, "--pretty=format:%h%x1f%s%x1f%an%x1f%cI%x1e", "--"]);
        args.extend(specs.iter().cloned());
        git(&cwd, &args).unwrap_or_default()
    } else {
        String::new()
    };
    let commits: Vec<Value> = parse_log(&out);
    let mut args = strs(&["status", "--porcelain", "--untracked-files=all", "--"]);
    args.extend(specs);
    let status = git(&cwd, &args).unwrap_or_default();
    let uncommitted: Vec<&str> = status.split('\n').filter(|l| !l.is_empty()).map(|l| l.get(3..).unwrap_or("")).collect();
    json!({ "linkId": id, "providerHead": provider_head, "commits": commits, "uncommitted": uncommitted })
}

fn parse_log(out: &str) -> Vec<Value> {
    out.split('\x1e')
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|r| {
            let mut f = r.split('\x1f');
            let mut next = || f.next().map_or(Value::Null, |s| json!(s));
            json!({ "hash": next(), "subject": next(), "author": next(), "date": next() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pathspecs_and_log() {
        let p = |v: &[&str]| pathspecs(&strs(v));
        assert_eq!(p(&[" ./api\\routes.ts ", "/abs", "../up", ""]), vec![":(glob)api/routes.ts"]);
        assert_eq!(p(&[]), vec!["."]);
        let log = parse_log("abc\x1fFix\x1fAnn\x1f2026-01-01\x1e\nd\x1fS\x1fB\x1fT\x1e");
        assert_eq!(log.len(), 2);
        assert_eq!(log[1]["hash"], "d");
        assert_eq!(log[0]["date"], "2026-01-01");
    }
}
