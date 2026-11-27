// Turns a report (self-contained HTML built by the UI) into a PDF using
// Chromium's print engine, with scripts turned off.
// ponytail: Tauri has no printToPDF, so this prints with headless Edge/Chrome (Edge ships with
// Windows); upgrade to WebView2's PrintToPdf / WKWebView createPDF if a machine lacks both.
use crate::util::{self, Args, Res};
use regex::Regex;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tauri_plugin_dialog::DialogExt;

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "report:pdf" => save_pdf(&a.s(0), &a.s(1)),
        _ => return None,
    })
}

fn safe_name(file_name: &str) -> String {
    let name: String = Regex::new(r#"[\\/:*?"<>|]+"#).unwrap().replace_all(file_name, "-").chars().take(120).collect();
    if name.is_empty() { "Status report".into() } else { name }
}

fn browser() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![];
    if cfg!(windows) {
        for base in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"].iter().filter_map(std::env::var_os) {
            let base = PathBuf::from(base);
            candidates.push(base.join(r"Microsoft\Edge\Application\msedge.exe"));
            candidates.push(base.join(r"Google\Chrome\Application\chrome.exe"));
        }
    } else {
        candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into());
        candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into());
        candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium".into());
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn save_pdf(html: &str, file_name: &str) -> Res {
    // Automated checks write to a fixed path instead of asking.
    let path = match std::env::var_os("VIBE_PDF_OUT") {
        Some(p) => PathBuf::from(p),
        None => {
            let picked = util::app()
                .dialog()
                .file()
                .set_title("Save report as PDF")
                .set_directory(dirs::document_dir().unwrap_or_default())
                .set_file_name(format!("{}.pdf", safe_name(file_name)))
                .add_filter("PDF", &["pdf"])
                .blocking_save_file();
            match picked.and_then(|p| p.into_path().ok()) {
                Some(p) => p,
                None => return Ok(Value::Null),
            }
        }
    };
    let browser = browser().ok_or("Saving a PDF needs Microsoft Edge or Google Chrome installed.")?;

    // A4 with half-inch margins, backgrounds printed, no scripts (a CSP, because
    // --blink-settings=scriptEnabled=false stops headless printing altogether).
    let page = "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"><style>@page{size:A4;margin:0.5in 0.5in 0.6in 0.5in}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>";
    let html = if html.contains("<head>") { html.replacen("<head>", &format!("<head>{page}"), 1) } else { format!("{page}{html}") };
    let tmp = std::env::temp_dir().join(format!("vibeloft-pdf-{}", util::uid()));
    let result = (|| {
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let page_file = tmp.join("report.html");
        fs::write(&page_file, html).map_err(|e| e.to_string())?;
        let args = [
            "--headless".to_string(),
            "--disable-gpu".into(),
            "--no-first-run".into(),
            "--no-pdf-header-footer".into(),
            // Its own profile, so a running Edge/Chrome doesn't take over the job.
            format!("--user-data-dir={}", tmp.join("profile").display()),
            format!("--print-to-pdf={}", path.display()),
            page_file.display().to_string(),
        ];
        util::run(&browser.to_string_lossy(), &args, None, None)
    })();
    let _ = fs::remove_dir_all(&tmp);
    result?;
    if !path.is_file() {
        return Err("The PDF could not be created.".into());
    }
    Ok(json!(path.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn safe_names() {
        assert_eq!(super::safe_name("A/B: report?"), "A-B- report-");
        assert_eq!(super::safe_name(""), "Status report");
    }
}
