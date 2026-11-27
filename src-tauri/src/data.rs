// The database handlers (customers, projects,
// work items, milestones, time tracking, settings).
use crate::{
    app_shell, claude_usage, store, terminals,
    util::{now, uid, upsert, Args, Res},
};
use serde_json::{json, Value};
use std::path::Path;

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "db:get" => Ok(store::load()),
        "customer:save" => Ok(store::mutate(|db| upsert(&mut db["customers"], a.v(0)))),
        "customer:delete" => {
            let id = a.s(0);
            Ok(store::mutate(|db| {
                retain(&mut db["customers"], |c| c["id"] != id.as_str());
                for p in items(&mut db["projects"]) {
                    if p["customerId"] == id.as_str() {
                        p["customerId"] = Value::Null;
                    }
                }
            }))
        }
        "project:save" => Ok(store::mutate(|db| upsert(&mut db["projects"], a.v(0)))),
        "project:delete" => delete_project(&a.s(0), a.b(1)),
        "project:archive" => Ok(archive_project(&a.s(0), a.b(1))),
        "work:save" => save_work(a.v(0)),
        "work:delete" => {
            let id = a.s(0);
            Ok(store::mutate(|db| retain(&mut db["workItems"], |w| w["id"] != id.as_str())))
        }
        "milestone:save" => {
            let mut m = a.v(0);
            if !m.is_object() {
                return Some(Err("Milestone missing.".into()));
            }
            m["updatedAt"] = json!(now());
            Ok(store::mutate(|db| upsert(&mut db["milestones"], m)))
        }
        "milestone:delete" => {
            let id = a.s(0);
            Ok(store::mutate(|db| {
                retain(&mut db["milestones"], |m| m["id"] != id.as_str());
                for w in items(&mut db["workItems"]) {
                    if w["milestoneId"] == id.as_str() {
                        w["milestoneId"] = Value::Null;
                    }
                }
            }))
        }
        // ---------- time tracking: one timer at a time, survives restarts ----------
        "time:start" => {
            let (project_id, note, work_item) = (a.s(0), a.opt_s(1).unwrap_or_default(), a.opt_s(2));
            Ok(store::mutate(|db| {
                stop_running(db);
                let entry = json!({ "id": uid(), "projectId": project_id, "start": now(), "end": null, "note": note, "workItemId": work_item });
                match db["timeEntries"].as_array_mut() {
                    Some(list) => list.push(entry),
                    None => db["timeEntries"] = json!([entry]),
                }
            }))
        }
        "time:stop" => Ok(store::mutate(stop_running)),
        "time:save" => Ok(store::mutate(|db| upsert(&mut db["timeEntries"], a.v(0)))),
        "time:delete" => {
            let id = a.s(0);
            Ok(store::mutate(|db| retain(&mut db["timeEntries"], |t| t["id"] != id.as_str())))
        }
        "settings:save" => {
            let settings = a.v(0);
            if !settings.is_object() {
                return Some(Err("Settings missing.".into()));
            }
            app_shell::apply_theme(settings["theme"].as_str().unwrap_or("light"));
            Ok(store::mutate(|db| db["settings"] = settings))
        }
        _ => return None,
    })
}

fn items(list: &mut Value) -> std::slice::IterMut<'_, Value> {
    match list.as_array_mut() {
        Some(a) => a.iter_mut(),
        None => [].iter_mut(),
    }
}

fn retain(list: &mut Value, keep: impl Fn(&Value) -> bool) {
    if let Some(a) = list.as_array_mut() {
        a.retain(|x| keep(x));
    }
}

/// JS truthiness for the string fields used here ("" and null are false).
fn set(v: &Value) -> bool {
    !(v.is_null() || v == "" || v == false)
}

fn stop_running(db: &mut Value) {
    for t in items(&mut db["timeEntries"]) {
        if !set(&t["end"]) {
            t["end"] = json!(now());
        }
    }
}

fn delete_project(id: &str, trash_folder: bool) -> Res {
    terminals::kill_project(id);
    // Recycle Bin / Trash, never a permanent delete, so a mistake can be undone.
    let db = store::load();
    let folder = db["projects"].as_array().and_then(|ps| ps.iter().find(|p| p["id"] == id)).and_then(|p| p["localPath"].as_str());
    if let Some(folder) = folder.filter(|f| trash_folder && !f.is_empty() && Path::new(f).exists()) {
        trash::delete(folder).map_err(|e| e.to_string())?;
    }
    claude_usage::forget_usage(id);
    Ok(store::mutate(|db| {
        retain(&mut db["projects"], |p| p["id"] != id);
        retain(&mut db["workItems"], |w| w["projectId"] != id);
        retain(&mut db["milestones"], |m| m["projectId"] != id);
        retain(&mut db["timeEntries"], |t| t["projectId"] != id);
        retain(&mut db["links"], |l| l["consumerId"] != id && l["providerId"] != id);
        for key in ["chats", "claudeOpen"] {
            if let Some(map) = db.get_mut(key).and_then(Value::as_object_mut) {
                map.remove(id);
            }
        }
    }))
}

// Archived projects keep all their data; their terminals close to free resources.
fn archive_project(id: &str, archived: bool) -> Value {
    if archived {
        terminals::kill_project(id);
    }
    store::mutate(|db| {
        if let Some(p) = items(&mut db["projects"]).find(|p| p["id"] == id) {
            p["archivedAt"] = if archived { json!(now()) } else { Value::Null };
        }
        if archived {
            for t in items(&mut db["timeEntries"]) {
                if !set(&t["end"]) && t["projectId"] == id {
                    t["end"] = json!(now());
                }
            }
        }
    })
}

fn save_work(mut w: Value) -> Res {
    if !w.is_object() {
        return Err("Work item missing.".into());
    }
    Ok(store::mutate(|db| {
        let before = db["workItems"].as_array().and_then(|l| l.iter().find(|x| x["id"] == w["id"])).cloned().unwrap_or_default();
        // Remember when an item was finished, for "completed this period" in reports.
        let mut done_at = if w["doneAt"].is_null() { before["doneAt"].clone() } else { w["doneAt"].clone() };
        if w["status"] == "done" && before["status"] != "done" {
            done_at = json!(now());
        }
        if w["status"] != "done" {
            done_at = Value::Null;
        }
        w["doneAt"] = done_at;
        // The issue link belongs to sync; a form opened before a (background) sync
        // must not drop it, or the next sync opens a duplicate issue.
        if w["githubNumber"].is_null() && !before["githubNumber"].is_null() {
            for k in ["githubNumber", "githubUrl", "syncedAt"] {
                w[k] = before[k].clone();
            }
        }
        w["updatedAt"] = json!(now());
        upsert(&mut db["workItems"], w);
    }))
}
