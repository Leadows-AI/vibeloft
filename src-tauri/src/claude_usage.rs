// How much Claude Code has been used in a
// project: tokens and cost, per day, read from Claude Code's own conversation
// files (read-only).
//
// Each saved reply records its token usage and model; Vibeloft prices those.
// Claude Code also keeps its own running cost per conversation ("cost-state"),
// which includes background requests it doesn't save as replies (e.g. the
// summary it writes while you're away). When that total is higher, the
// conversation's daily figures are scaled up to match it, so totals agree
// with Claude Code's /cost. Conversations from VS Code report no total, so
// they are priced from their replies alone.
//
// Cost is what the usage would cost at Anthropic's API prices. On a Claude
// subscription (Pro/Max/Team) you don't pay per token; it's then a measure of
// how much was used.
use crate::{
    claude_sessions, store,
    util::{Args, Res},
};
use chrono::{Duration, Local, NaiveDate};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::SystemTime,
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "claude:usage" => Ok(claude_usage(&a.s(0))),
        _ => return None,
    })
}

/// $ per million tokens: input, output, cache read. Cache writes: 5 min = 1.25x input, 1 hour = 2x input.
const PRICES: &[(&str, f64, f64, f64)] = &[
    ("claude-fable-5-2", 8.0, 40.0, 0.2),
    ("claude-mythos-5-2", 8.0, 40.0, 0.2),
    ("claude-fable-5-1", 10.0, 50.0, 1.0),
    ("claude-mythos-5-1", 10.0, 50.0, 1.0),
    ("claude-fable-5", 10.0, 50.0, 1.0),
    ("claude-mythos-5", 10.0, 50.0, 1.0),
    ("claude-opus-5-5", 4.0, 20.0, 0.2),
    ("claude-opus-5", 5.0, 25.0, 0.5),
    ("claude-opus-4-8", 5.0, 25.0, 0.5),
    ("claude-opus-4-7", 5.0, 25.0, 0.5),
    ("claude-opus-4-6", 5.0, 25.0, 0.5),
    ("claude-opus-4", 15.0, 75.0, 1.5),
    ("claude-sonnet-5-5", 2.0, 10.0, 0.1),
    ("claude-sonnet-5", 2.0, 10.0, 0.2),
    ("claude-sonnet-4", 3.0, 15.0, 0.3),
    ("claude-haiku-5-5", 0.1, 0.5, 0.01),
    ("claude-haiku-4", 1.0, 5.0, 0.1),
];

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn price_of(model: &str, u: &Value) -> f64 {
    let Some(&(_, inp, out, cr)) = PRICES.iter().find(|p| model.starts_with(p.0)) else { return 0.0 };
    let c = &u["cache_creation"];
    let w1h = num(&c["ephemeral_1h_input_tokens"]);
    let w5m = if c.is_object() { num(&c["ephemeral_5m_input_tokens"]) } else { num(&u["cache_creation_input_tokens"]) };
    (num(&u["input_tokens"]) * inp + num(&u["output_tokens"]) * out + num(&u["cache_read_input_tokens"]) * cr + w5m * inp * 1.25 + w1h * inp * 2.0)
        / 1e6
}

const DAY_FIELDS: [&str; 6] = ["costUsd", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "replies"];
/// One day's figures, in DAY_FIELDS order.
type Day = [f64; 6];

#[derive(Clone, Default)]
struct FileResult {
    days: BTreeMap<String, Day>,
    by_model: BTreeMap<String, f64>,
    /// Claude Code's own running total for the conversation, if it keeps one.
    reported_usd: f64,
    from_editor: bool,
}

/// Local date (YYYY-MM-DD) of a timestamp.
fn day_of(iso: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(iso).ok().map(|d| d.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

fn parse_lines(lines: impl Iterator<Item = String>) -> FileResult {
    // A reply is written as several lines (thinking, text, tool calls) sharing
    // one message id; the last line has the final usage.
    let mut replies: HashMap<String, (String, String, Value)> = HashMap::new();
    let mut r = FileResult::default();
    let mut entry: Option<String> = None;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        // Cheap pre-checks: most lines are neither replies nor cost records.
        let is_reply = line.contains("\"type\":\"assistant\"") && line.contains("\"usage\"");
        let is_cost = !is_reply && line.starts_with("{\"type\":\"cost-state\"");
        if !is_reply && !is_cost && entry.is_some() {
            continue;
        }
        let Ok(j) = serde_json::from_str::<Value>(&line) else { continue };
        if entry.is_none() {
            entry = j["entrypoint"].as_str().map(str::to_owned);
        }
        if is_cost {
            if let Some(t) = j["totalCostUSD"].as_f64() {
                r.reported_usd = r.reported_usd.max(t);
            }
        }
        if is_reply {
            let m = &j["message"];
            if let (Some(id), Some(model), Some(ts)) = (m["id"].as_str(), m["model"].as_str(), j["timestamp"].as_str()) {
                if m["usage"].is_object() && !id.is_empty() && !model.is_empty() && model != "<synthetic>" {
                    replies.insert(id.into(), (ts.into(), model.into(), m["usage"].clone()));
                }
            }
        }
    }
    for (ts, model, u) in replies.into_values() {
        // ponytail: a reply with an unreadable timestamp is skipped (the TS filed it under "NaN-NaN-NaN").
        let Some(key) = day_of(&ts) else { continue };
        let cost = price_of(&model, &u);
        let d = r.days.entry(key).or_default();
        d[0] += cost;
        d[1] += num(&u["input_tokens"]);
        d[2] += num(&u["output_tokens"]);
        d[3] += num(&u["cache_read_input_tokens"]);
        d[4] += num(&u["cache_creation_input_tokens"]);
        d[5] += 1.0;
        *r.by_model.entry(model).or_default() += cost;
    }
    r.from_editor = entry.is_some_and(|e| e != "cli");
    r
}

// Conversation files only grow; re-read one only when it has changed.
static CACHE: LazyLock<Mutex<HashMap<PathBuf, (SystemTime, u64, FileResult)>>> = LazyLock::new(Default::default);

fn cached_read(file: &Path) -> Option<FileResult> {
    let m = fs::metadata(file).ok()?;
    let (mtime, size) = (m.modified().ok()?, m.len());
    if let Some((t, s, r)) = CACHE.lock().unwrap().get(file) {
        if *t == mtime && *s == size {
            return Some(r.clone());
        }
    }
    let f = fs::File::open(file).ok()?;
    let lines = BufReader::new(f).split(b'\n').map_while(Result::ok).map(|l| {
        let s = String::from_utf8_lossy(&l).into_owned();
        s.strip_suffix('\r').map(str::to_owned).unwrap_or(s)
    });
    let result = parse_lines(lines);
    CACHE.lock().unwrap().insert(file.to_owned(), (mtime, size, result.clone()));
    Some(result)
}

// ---------- the saved record ----------
//
// Claude Code deletes old conversation files (after 30 days by default), and a
// moved project folder points at different ones. So Vibeloft keeps its own
// record per project: each conversation's daily figures. A figure already
// recorded is never lowered, and totals are always worked out from the record.
// It's kept in its own file (claude-usage.json, next to studio.json).

#[derive(Clone, Default)]
struct SessionRecord {
    from_editor: bool,
    /// Claude Code's own running total for the conversation (0 if it keeps none).
    reported_usd: f64,
    /// Per local day: raw figures priced from the saved replies.
    days: BTreeMap<String, Day>,
    /// Raw cost per model.
    models: BTreeMap<String, f64>,
}

type Sessions = BTreeMap<String, SessionRecord>;

impl SessionRecord {
    fn to_json(&self) -> Value {
        let days: Map<String, Value> = self
            .days
            .iter()
            .map(|(k, d)| (k.clone(), Value::Object(DAY_FIELDS.iter().zip(d).map(|(f, v)| (f.to_string(), json!(v))).collect())))
            .collect();
        json!({ "fromEditor": self.from_editor, "reportedUsd": self.reported_usd, "days": days, "models": self.models })
    }
    fn from_json(v: &Value) -> Self {
        let obj = |k: &str| v[k].as_object().cloned().unwrap_or_default();
        SessionRecord {
            from_editor: v["fromEditor"].as_bool().unwrap_or(false),
            reported_usd: num(&v["reportedUsd"]),
            days: obj("days").into_iter().map(|(k, d)| (k, DAY_FIELDS.map(|f| num(&d[f])))).collect(),
            models: obj("models").into_iter().map(|(k, c)| (k, num(&c))).collect(),
        }
    }
}

fn usage_file() -> PathBuf {
    crate::store::user_data_dir().join("claude-usage.json")
}

/// The record, per project. Also serializes updates (calls run in parallel here).
static RECORD: Mutex<Option<HashMap<String, Sessions>>> = Mutex::new(None);

fn load_record(rec: &mut Option<HashMap<String, Sessions>>) -> &mut HashMap<String, Sessions> {
    rec.get_or_insert_with(|| {
        let j: Value = fs::read_to_string(usage_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        if j["version"] != 1 {
            return HashMap::new();
        }
        j["projects"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(p, ss)| {
                let ss = ss.as_object().into_iter().flatten().map(|(id, s)| (id.clone(), SessionRecord::from_json(s))).collect();
                (p.clone(), ss)
            })
            .collect()
    })
}

fn save_record(rec: &HashMap<String, Sessions>) {
    let projects: Map<String, Value> = rec
        .iter()
        .map(|(p, ss)| (p.clone(), Value::Object(ss.iter().map(|(id, s)| (id.clone(), s.to_json())).collect())))
        .collect();
    let file = usage_file();
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = file.with_extension("json.tmp");
    // Atomic replace.
    if fs::write(&tmp, json!({ "version": 1, "projects": projects }).to_string()).is_ok() {
        let _ = fs::rename(&tmp, &file);
    }
}

/// Merge fresh figures into the record without lowering anything. Returns whether it changed.
fn merge_session(into: &mut SessionRecord, fresh: &SessionRecord) -> bool {
    let mut changed = false;
    if fresh.reported_usd > into.reported_usd {
        into.reported_usd = fresh.reported_usd;
        changed = true;
    }
    if fresh.from_editor && !into.from_editor {
        into.from_editor = true;
        changed = true;
    }
    for (date, d) in &fresh.days {
        let t = into.days.entry(date.clone()).or_default();
        for k in 0..6 {
            if d[k] > t[k] + 1e-12 {
                t[k] = d[k];
                changed = true;
            }
        }
    }
    for (m, c) in &fresh.models {
        let t = into.models.entry(m.clone()).or_default();
        if *c > *t + 1e-12 {
            *t = *c;
            changed = true;
        }
    }
    changed
}

fn jsonl_in(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|f| f.ends_with(".jsonl")).collect())
        .unwrap_or_default()
}

/// Read the project's conversation files and fold them into the saved record.
fn update_record(project_id: &str) -> Sessions {
    let mut guard = RECORD.lock().unwrap();
    let rec = load_record(&mut guard);
    let db = store::load();
    let path = db["projects"].as_array().and_then(|ps| ps.iter().find(|p| p["id"] == project_id)).and_then(|p| p["localPath"].as_str());
    let mine = rec.entry(project_id.to_owned()).or_default();
    let Some(dir) = path.and_then(claude_sessions::session_dir).filter(|d| d.exists()) else { return mine.clone() };
    let mut changed = false;
    for f in jsonl_in(&dir) {
        let Some(main) = cached_read(&dir.join(&f)) else { continue };
        let id = &f[..f.len() - ".jsonl".len()];
        // A conversation's sub-agents are saved next to it; they count towards it.
        let sub_dir = dir.join(id).join("subagents");
        let subs: Vec<FileResult> = jsonl_in(&sub_dir).iter().filter_map(|x| cached_read(&sub_dir.join(x))).collect();
        let mut fresh = SessionRecord { from_editor: main.from_editor, reported_usd: main.reported_usd, ..Default::default() };
        for p in std::iter::once(&main).chain(&subs) {
            for (date, d) in &p.days {
                let t = fresh.days.entry(date.clone()).or_default();
                for k in 0..6 {
                    t[k] += d[k];
                }
            }
            for (m, c) in &p.by_model {
                *fresh.models.entry(m.clone()).or_default() += c;
            }
        }
        if fresh.days.is_empty() && fresh.reported_usd == 0.0 {
            continue;
        }
        let into = mine
            .entry(id.to_owned())
            .or_insert_with(|| SessionRecord { from_editor: fresh.from_editor, ..Default::default() });
        if merge_session(into, &fresh) {
            changed = true;
        }
    }
    let out = mine.clone();
    if changed {
        save_record(rec);
    }
    out
}

/// Update every project's usage record (runs a little after start, then every 30 min),
/// so nothing is lost to Claude Code's clean-up.
pub fn record_all_projects() {
    let db = store::load();
    for p in db["projects"].as_array().into_iter().flatten().filter(|p| p["localPath"].is_string()) {
        update_record(p["id"].as_str().unwrap_or_default());
    }
}

/// Forget a deleted project's usage record.
pub fn forget_usage(project_id: &str) {
    let mut guard = RECORD.lock().unwrap();
    let rec = load_record(&mut guard);
    if rec.remove(project_id).is_some() {
        save_record(rec);
    }
}

/// Tokens and cost of Claude Code in this project: totals for today / 7 / 30 days / all, per day and per model.
pub fn claude_usage(project_id: &str) -> Value {
    totals(&update_record(project_id), Local::now().date_naive())
}

fn totals(sessions: &Sessions, today: NaiveDate) -> Value {
    let fmt = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let today_s = fmt(today);
    let week_from = fmt(today - Duration::days(6));
    let month_from = fmt(today - Duration::days(29));
    // all, month, week, today; each: the six day figures, then conversations.
    let mut t = [[0f64; 7]; 4];
    let periods = |date: &str| -> Vec<usize> {
        let mut p = vec![0];
        if date >= month_from.as_str() {
            p.push(1);
        }
        if date >= week_from.as_str() {
            p.push(2);
        }
        if date == today_s {
            p.push(3);
        }
        p
    };

    let mut all_days: BTreeMap<String, Day> = BTreeMap::new();
    let mut by_model: HashMap<String, f64> = HashMap::new();
    let mut editor_share = 0.0;
    for s in sessions.values() {
        let estimated: f64 = s.days.values().map(|d| d[0]).sum();
        // Match Claude Code's own total when it's higher (background requests it doesn't save as replies).
        let scale = if s.reported_usd > estimated && estimated > 0.0 { (s.reported_usd / estimated).min(3.0) } else { 1.0 };
        let mut counted = [false; 4];
        for (date, d) in &s.days {
            let a = all_days.entry(date.clone()).or_default();
            a[0] += d[0] * scale;
            for k in 1..6 {
                a[k] += d[k];
            }
            if s.from_editor {
                editor_share += d[0] * scale;
            }
            // Count the conversation once in each period it was active in.
            for p in periods(date) {
                counted[p] = true;
            }
        }
        for (p, c) in counted.iter().enumerate() {
            if *c {
                t[p][6] += 1.0;
            }
        }
        for (m, c) in &s.models {
            *by_model.entry(m.clone()).or_default() += c * scale;
        }
    }
    for (date, d) in &all_days {
        for p in periods(date) {
            for k in 0..6 {
                t[p][k] += d[k];
            }
        }
    }
    let total = |x: &[f64; 7]| {
        json!({ "costUsd": x[0], "inputTokens": x[1], "outputTokens": x[2], "cacheReadTokens": x[3], "cacheWriteTokens": x[4], "replies": x[5], "conversations": x[6] })
    };
    let days: Vec<Value> = all_days
        .iter()
        .filter(|(k, _)| k.as_str() >= month_from.as_str())
        .map(|(date, d)| json!({ "date": date, "costUsd": d[0], "tokens": d[1] + d[2] + d[3] + d[4], "replies": d[5] }))
        .collect();
    let mut models: Vec<(String, f64)> = by_model.into_iter().collect();
    models.sort_by(|a, b| b.1.total_cmp(&a.1));
    json!({
        "today": total(&t[3]), "week": total(&t[2]), "month": total(&t[1]), "all": total(&t[0]),
        "days": days,
        "byModel": models.into_iter().map(|(model, c)| json!({ "model": model, "costUsd": c })).collect::<Vec<_>>(),
        "editorShareUsd": editor_share,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prices_replies_and_scales_to_reported_total() {
        let lines = [
            r#"{"type":"user","entrypoint":"cli"}"#,
            // Same message id twice: only the last line counts.
            r#"{"type":"assistant","timestamp":"2026-03-10T12:00:00Z","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":1}}}"#,
            r#"{"type":"assistant","timestamp":"2026-03-10T12:00:00Z","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":1000000,"output_tokens":100000,"cache_creation":{"ephemeral_1h_input_tokens":1000000}}}}"#,
            r#"{"type":"assistant","timestamp":"2026-03-10T12:00:00Z","message":{"id":"m2","model":"<synthetic>","usage":{"output_tokens":5}}}"#,
            r#"{"type":"cost-state","totalCostUSD":28}"#,
        ];
        let r = parse_lines(lines.iter().map(|s| s.to_string()));
        assert!(!r.from_editor);
        assert_eq!(r.reported_usd, 28.0);
        let day = day_of("2026-03-10T12:00:00Z").unwrap();
        // 1M in * $4 + 100k out * $20 + 1M 1h-cache writes * $8 = $14.
        assert!((r.days[&day][0] - 14.0).abs() < 1e-9);
        assert_eq!(r.days[&day][5], 1.0);

        let s = SessionRecord { from_editor: false, reported_usd: r.reported_usd, days: r.days.clone(), models: r.by_model.clone() };
        let mut rec = SessionRecord::default();
        assert!(merge_session(&mut rec, &s));
        assert!(!merge_session(&mut rec, &SessionRecord::default()));
        let today = NaiveDate::parse_from_str(&day, "%Y-%m-%d").unwrap();
        let out = totals(&BTreeMap::from([("a".to_string(), rec)]), today);
        assert_eq!(out["today"]["costUsd"], json!(28.0)); // scaled up to Claude Code's own total
        assert_eq!(out["week"]["conversations"], json!(1.0));
        assert_eq!(out["byModel"][0]["model"], "claude-opus-5-5");
    }
}
