// Fonts picked from fonts.google.com in Settings. The first time a family is
// used it is downloaded once and saved with the font files built into the CSS
// (data: URLs), so it keeps working offline and the UI never loads anything
// from the internet itself.
use crate::util::{self, Args, Res};
use base64::Engine;
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf, process::Stdio, sync::LazyLock, thread, time::Duration};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "font:google" => google_font(&a.s(0)),
        "font:list" => font_list(),
        _ => return None,
    })
}

static FAMILY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$").unwrap());
static FONT_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"url\((https://fonts\.gstatic\.com/[^)]+)\)").unwrap());

/// Google only serves woff2 to browsers it recognises, so ask like one.
const BROWSER: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/// The same user data folder as store.rs.
fn cache_file(family: &str) -> PathBuf {
    let dir = crate::store::user_data_dir();
    dir.join("fonts").join(format!("{}.css", family.to_lowercase().split(' ').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-")))
}

// ponytail: downloads with the curl that ships with Windows 10+ and macOS, so no HTTP crate; use ureq if curl ever falls short.
fn get(url: &str) -> Result<Vec<u8>, String> {
    let out = util::command("curl").args(["-sSfL", "--max-time", "60", "-A", BROWSER, url]).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The family as fonts.google.com writes it, or None if it can't be a family name.
fn clean_family(family: &str) -> Option<String> {
    let f = family.split_whitespace().collect::<Vec<_>>().join(" ");
    FAMILY.is_match(&f).then_some(f)
}

/// @font-face CSS for a Google Fonts family, with the font files embedded.
fn google_font(family: &str) -> Res {
    let family = clean_family(family).ok_or("Use the font name exactly as fonts.google.com shows it, e.g. \"IBM Plex Sans\".")?;
    let file = cache_file(&family);
    if let Ok(css) = fs::read_to_string(&file) {
        return Ok(json!(css));
    }

    let base = format!("https://fonts.googleapis.com/css2?family={}", family.replace(' ', "+"));
    let css = get(&format!("{base}:wght@400;500;600;700&display=swap"))
        // Some families don't have all four weights: take what there is.
        .or_else(|_| get(&format!("{base}&display=swap")))
        .map_err(|_| format!("Couldn't find \"{family}\" on Google Fonts. Check the name, and that you're online."))?;
    let css = String::from_utf8_lossy(&css).into_owned();

    // A variable font repeats the same file for every weight: fetch each file once.
    let mut urls: Vec<&str> = FONT_URL.captures_iter(&css).map(|c| c.get(1).unwrap().as_str()).collect();
    urls.sort_unstable();
    urls.dedup();
    let data: HashMap<&str, String> = thread::scope(|s| {
        let jobs: Vec<_> = urls.iter().map(|u| (*u, s.spawn(move || get(u)))).collect();
        jobs.into_iter()
            .map(|(u, j)| {
                let bytes = j.join().map_err(|_| "Font download failed.".to_string())??;
                Ok((u, format!("data:font/woff2;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
            })
            .collect::<Result<_, String>>()
    })?;
    let css = FONT_URL.replace_all(&css, |c: &regex::Captures| format!("url({})", data[&c[1]])).into_owned();

    fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&file, &css).map_err(|e| e.to_string())?;
    Ok(json!(css))
}

/// Google's font catalogue (the list fonts.google.com itself uses; no API key needed).
const CATALOGUE: &str = "https://fonts.google.com/metadata/fonts";
const LIST_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Every Google Fonts family as [{family, category, weights}], most popular first.
/// Downloaded at most once a week; an older copy, or [], when offline.
fn font_list() -> Res {
    let file = crate::store::user_data_dir().join("fonts").join("list.json");
    let cached: Option<Value> = fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok());
    let fresh = fs::metadata(&file).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age < LIST_MAX_AGE);
    if let (true, Some(list)) = (fresh, &cached) {
        return Ok(list.clone());
    }
    match get(CATALOGUE).and_then(|raw| trim_list(&raw)) {
        Ok(list) => {
            let _ = fs::create_dir_all(file.parent().unwrap()).and_then(|_| fs::write(&file, list.to_string()));
            Ok(list)
        }
        Err(_) => Ok(cached.unwrap_or_else(|| json!([]))),
    }
}

/// Keeps what the Settings picker needs from Google's ~3 MB catalogue (~60 KB).
fn trim_list(raw: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(raw);
    // The feed has been served with Google's ")]}'" anti-JSON-hijacking prefix before.
    let text = text.trim_start().trim_start_matches(")]}'");
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut fams: Vec<&Value> = v["familyMetadataList"].as_array().ok_or("No font list.")?.iter().collect();
    fams.sort_by_key(|f| f["popularity"].as_u64().unwrap_or(u64::MAX));
    let list = fams
        .into_iter()
        .filter_map(|f| {
            // Only names google_font accepts.
            let family = clean_family(f["family"].as_str()?)?;
            // Keys are "400", "700i", ...: italics don't parse, so these are the upright weights.
            let mut weights: Vec<u64> = f["fonts"].as_object()?.keys().filter_map(|k| k.parse().ok()).collect();
            weights.sort_unstable();
            Some(json!({ "family": family, "category": f["category"].as_str().unwrap_or(""), "weights": weights }))
        })
        .collect();
    Ok(Value::Array(list))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn family_names() {
        assert_eq!(clean_family("  IBM   Plex Sans "), Some("IBM Plex Sans".into()));
        assert_eq!(clean_family("Evil/../x"), None);
        assert_eq!(clean_family(""), None);
        assert!(cache_file("IBM Plex Sans").ends_with("fonts/ibm-plex-sans.css"));
    }

    #[test]
    fn catalogue_trim() {
        let raw = br#")]}'
{"familyMetadataList":[
 {"family":"Roboto","category":"Sans Serif","popularity":2,"fonts":{"700":{},"400":{},"400i":{}}},
 {"family":"Bad/Name","category":"Serif","popularity":0,"fonts":{"400":{}}},
 {"family":"Inter","category":"Sans Serif","popularity":1,"fonts":{"400":{}},"extra":true}
]}"#;
        assert_eq!(
            trim_list(raw).unwrap(),
            json!([
                {"family": "Inter", "category": "Sans Serif", "weights": [400]},
                {"family": "Roboto", "category": "Sans Serif", "weights": [400, 700]}
            ])
        );
        assert!(trim_list(b"<html>").is_err());
    }
}
