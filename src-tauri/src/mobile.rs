// Helpers for mobile app projects (Android): build an APK,
// find the latest build, install it on a phone or emulator, and watch the app's logs.
// Works with Expo / React Native (android folder), Flutter, Capacitor and plain
// Android (Gradle) projects. Read-only except for the builds and the log files
// Vibeloft saves for Claude.
use crate::{
    setup::{self, Output},
    store,
    util::{Args, Res},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "mobile:info" => store::project_path(&a.s(0)).map(|root| mobile_info(&root)),
        "mobile:buildCommand" => build_command(
            &a.s(0),
            if a.s(1) == "debug" { "debug" } else { "release" },
            if a.s(2) == "cloud" { "cloud" } else { "local" },
            a.s(3) == "phone",
            &a.s(4),
        ),
        "mobile:devices" => devices(&a.s(0)),
        "mobile:install" => install(&a.s(0), &a.s(1), &a.s(2)),
        "mobile:logsCommand" => logs_command(&a.s(0), &a.s(1)).map(Value::from),
        "mobile:saveLog" => save_log(&a.s(0), &a.s(1)).map(Value::from),
        _ => return None,
    })
}

const WIN: bool = cfg!(windows);

fn read_json(file: &Path) -> Value {
    fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

fn q(s: &str) -> String {
    if WIN {
        format!("'{}'", s.replace('\'', "''"))
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

fn rel_of(root: &Path, full: &Path) -> String {
    full.strip_prefix(root).unwrap_or(full).to_string_lossy().replace('\\', "/")
}

/// The Android SDK folder: ANDROID_HOME / ANDROID_SDK_ROOT, the project's local.properties, or the usual install place.
fn sdk_dir(android_dir: Option<&Path>) -> Option<PathBuf> {
    let from_props = android_dir.and_then(|d| fs::read_to_string(d.join("local.properties")).ok()).and_then(|t| {
        t.lines().find_map(|l| l.strip_prefix("sdk.dir=")).map(|v| v.replace("\\:", ":").replace("\\\\", "\\").trim().to_string())
    });
    let home = dirs::home_dir().unwrap_or_default();
    let usual = if WIN {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Local")).join("Android").join("Sdk")
    } else {
        home.join("Library").join("Android").join("sdk")
    };
    [std::env::var_os("ANDROID_HOME").map(PathBuf::from), std::env::var_os("ANDROID_SDK_ROOT").map(PathBuf::from), from_props.map(PathBuf::from), Some(usual)]
        .into_iter()
        .flatten()
        .find(|d| !d.as_os_str().is_empty() && d.exists())
}

/// adb: on PATH, or in the Android SDK's platform-tools.
fn find_adb(android_dir: Option<&Path>) -> Option<PathBuf> {
    let exe = if WIN { "adb.exe" } else { "adb" };
    let path = std::env::var_os("PATH").unwrap_or_default();
    if let Some(p) = std::env::split_paths(&path).filter(|d| !d.as_os_str().is_empty()).map(|d| d.join(exe)).find(|p| p.exists()) {
        return Some(p);
    }
    sdk_dir(android_dir).map(|s| s.join("platform-tools").join(exe)).filter(|p| p.exists())
}

struct Detected {
    kind: &'static str,
    label: &'static str,
    android_dir: Option<PathBuf>,
    app_id: Option<String>,
}

fn detect(root: &Path) -> Option<Detected> {
    let pkg = read_json(&root.join("package.json"));
    let has = |d: &str| pkg["dependencies"].get(d).is_some() || pkg["devDependencies"].get(d).is_some();
    let gradlew = if WIN { "gradlew.bat" } else { "gradlew" };
    let android_dir = [root.join("android"), root.to_path_buf()].into_iter().find(|d| d.join(gradlew).exists() && d.join("app").exists());
    let expo_android = read_json(&root.join("app.json"))["expo"]["android"]["package"].as_str().map(str::to_string);
    let d = |kind, label, app_id| Some(Detected { kind, label, android_dir: android_dir.clone(), app_id });

    let pubspec = fs::read_to_string(root.join("pubspec.yaml")).unwrap_or_default();
    if regex::Regex::new(r"\bflutter:").unwrap().is_match(&pubspec) {
        return d("flutter", "Flutter", None);
    }
    if has("expo") {
        return d("expo", "Expo (React Native)", expo_android);
    }
    if has("@capacitor/android") || root.join("capacitor.config.ts").exists() || root.join("capacitor.config.json").exists() {
        return d("capacitor", "Capacitor", None);
    }
    if has("react-native") {
        return d("react-native", "React Native", None);
    }
    if android_dir.is_some() {
        return d("android", "Android (Gradle)", None);
    }
    None
}

/// Where builds land, per project type.
fn apk_folders(root: &Path, d: &Detected) -> Vec<PathBuf> {
    let mut out = vec![];
    if d.kind == "flutter" {
        out.push(root.join("build").join("app").join("outputs").join("flutter-apk"));
    }
    if let Some(a) = &d.android_dir {
        out.push(a.join("app").join("build").join("outputs").join("apk"));
    }
    out
}

fn find_apks(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    let Ok(items) = fs::read_dir(dir) else { return };
    for e in items.flatten() {
        let p = e.path();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            find_apks(&p, depth + 1, out);
        } else if e.file_name().to_string_lossy().ends_with(".apk") {
            out.push(p);
        }
    }
}

fn iso(t: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn builds(root: &Path, d: &Detected) -> Vec<Value> {
    let mut files = vec![];
    for f in apk_folders(root, d) {
        find_apks(&f, 0, &mut files);
    }
    let mut list: Vec<(SystemTime, Value)> = files
        .into_iter()
        .filter_map(|file| {
            let s = fs::metadata(&file).ok()?;
            let mtime = s.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            // Gradle writes output-metadata.json next to the APK: app id and version.
            let meta = read_json(&file.with_file_name("output-metadata.json"));
            let path = file.to_string_lossy();
            let el = meta["elements"].as_array().and_then(|els| {
                els.iter().find(|x| x["outputFile"].as_str().is_some_and(|o| !o.is_empty() && path.ends_with(o)))
            });
            let lower = path.to_lowercase();
            let variant = meta["variantName"].as_str().unwrap_or(if lower.contains("debug") {
                "debug"
            } else if lower.contains("release") {
                "release"
            } else {
                ""
            });
            let v = json!({
                "rel": rel_of(root, &file),
                "name": file.file_name().map(|n| n.to_string_lossy().into_owned()),
                "variant": variant,
                "sizeBytes": s.len(),
                "builtAt": iso(mtime),
                "versionName": el.map_or(Value::Null, |e| e["versionName"].clone()),
                "versionCode": el.map_or(Value::Null, |e| e["versionCode"].clone()),
                "appId": meta["applicationId"].as_str().map(str::to_string).or_else(|| d.app_id.clone())
            });
            Some((mtime, v))
        })
        .collect();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    list.into_iter().map(|x| x.1).collect()
}

/// Mobile details for a project, or null if it isn't a mobile app Vibeloft knows.
fn mobile_info(root: &Path) -> Value {
    let Some(d) = detect(root) else { return Value::Null };
    let list = builds(root, &d);
    let app_id = list.first().map(|b| b["appId"].clone()).filter(|v| !v.is_null()).unwrap_or_else(|| json!(d.app_id));
    json!({
        "kind": d.kind,
        "label": d.label,
        "androidFolder": d.android_dir.as_ref().map(|a| Some(rel_of(root, a)).filter(|r| !r.is_empty()).unwrap_or_else(|| ".".into())),
        "canBuildLocally": d.kind == "flutter" || d.android_dir.is_some(),
        "hasEas": root.join("eas.json").exists(),
        "adb": find_adb(d.android_dir.as_deref()),
        "appId": app_id,
        "builds": list
    })
}

/// Phone serials: letters, digits, _ . : - only (they go into commands).
fn valid_serial(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c))
}

const ABIS: [&str; 4] = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"];

/// The CPU type of a connected phone/emulator (e.g. arm64-v8a), or None.
fn device_abi(adb: Option<PathBuf>, serial: &str) -> Option<String> {
    let adb = adb?;
    if !valid_serial(serial) {
        return None;
    }
    let r = setup::exec(adb, &["-s", serial, "shell", "getprop", "ro.product.cpu.abi"], Duration::from_secs(10));
    let out = r.out();
    let abi = out.split_whitespace().next().unwrap_or_default();
    (r.ok && ABIS.contains(&abi)).then(|| abi.to_string())
}

/// Build for one CPU type only ("for this phone") or all of them. React Native
/// and Expo apps compile their native code once per CPU type, so one type is
/// several times faster and the APK less than half the size.
fn build_command(project_id: &str, variant: &str, place: &str, phone: bool, serial: &str) -> Res {
    let root = store::project_path(project_id)?;
    let d = detect(&root);
    let per_abi = phone && place == "local" && d.as_ref().is_some_and(|d| ["expo", "react-native", "flutter"].contains(&d.kind));
    // The connected phone's CPU type; with none connected, the one nearly every modern phone uses.
    let abi = per_abi.then(|| device_abi(find_adb(d.as_ref().and_then(|d| d.android_dir.as_deref())), serial).unwrap_or_else(|| "arm64-v8a".into()));
    Ok(json!({ "command": build_command_for(&root, d.as_ref(), variant, place, abi.as_deref())?, "abi": abi }))
}

/// The shell command (PowerShell on Windows) that builds an APK. It ends with the build's exit code.
fn build_command_for(root: &Path, d: Option<&Detected>, variant: &str, place: &str, abi: Option<&str>) -> Result<String, String> {
    let Some(d) = d else { return Err("This doesn’t look like a mobile app project.".into()) };
    let end = if WIN { "; exit $LASTEXITCODE" } else { "; exit $?" };
    if place == "cloud" {
        let eas = read_json(&root.join("eas.json"));
        // An APK profile (installable on a phone), else "preview".
        let profile = eas["build"]
            .as_object()
            .and_then(|ps| ps.iter().find(|(_, p)| p["android"]["buildType"] == "apk").map(|(k, _)| k.as_str()))
            .unwrap_or("preview");
        return Ok(format!("npx eas-cli build --platform android --profile {profile}{end}"));
    }
    if d.kind == "flutter" {
        let platform = match abi {
            Some("arm64-v8a") => " --target-platform android-arm64",
            Some("armeabi-v7a") => " --target-platform android-arm",
            Some("x86_64") => " --target-platform android-x64",
            _ => "",
        };
        return Ok(format!("flutter build apk --{variant}{platform}{end}"));
    }
    let Some(android_dir) = &d.android_dir else {
        return Err("There’s no android folder to build from. Use a cloud build, or generate it first (for Expo: npx expo prebuild).".into());
    };
    let mut task = if variant == "release" { "assembleRelease" } else { "assembleDebug" }.to_string();
    if let (Some(abi), "expo" | "react-native") = (abi, d.kind) {
        task += &format!(" -PreactNativeArchitectures={abi}");
    }
    let gradlew = android_dir.join(if WIN { "gradlew.bat" } else { "gradlew" });
    let sync = if d.kind == "capacitor" { format!("npx cap sync android{}", if WIN { "; " } else { " && " }) } else { String::new() };
    let (g, p) = (q(&gradlew.to_string_lossy()), q(&android_dir.to_string_lossy()));
    Ok(if WIN { format!("{sync}& {g} -p {p} {task}{end}") } else { format!("{sync}{g} -p {p} {task}{end}") })
}

fn parse_devices(out: &str) -> Vec<Value> {
    out.lines()
        .skip(1)
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next().unwrap_or_default();
            let state = parts.next().unwrap_or_default();
            let model = parts.find_map(|x| x.strip_prefix("model:")).map(|m| m.replace('_', " "));
            let emulator = serial.starts_with("emulator-");
            let name = model.unwrap_or_else(|| if emulator { "Emulator".into() } else { serial.into() });
            json!({ "serial": serial, "state": state, "name": name, "emulator": emulator })
        })
        .collect()
}

/// adb for this project, if it's a mobile app and adb was found.
fn adb_for(root: &Path) -> Option<PathBuf> {
    detect(root).and_then(|d| find_adb(d.android_dir.as_deref()))
}

/// Phones and emulators adb can see.
fn devices(project_id: &str) -> Res {
    let Some(adb) = adb_for(&store::project_path(project_id)?) else { return Ok(json!([])) };
    Ok(Value::Array(parse_devices(&setup::exec(adb, &["devices", "-l"], Duration::from_secs(15)).out())))
}

/// Install a build on a device (replacing the installed version, keeping its data).
fn install(project_id: &str, rel: &str, serial: &str) -> Res {
    let root = store::project_path(project_id)?;
    let safe = Path::new(rel).components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    let file = root.join(rel);
    if !safe || !rel.ends_with(".apk") || !file.is_file() {
        return Err("That build isn’t in this project.".into());
    }
    if !valid_serial(serial) {
        return Err("Unknown device.".into());
    }
    let adb = adb_for(&root).ok_or("adb (Android platform tools) wasn’t found.")?;
    let r = setup::exec(adb, &["-s", serial, "install", "-r", &file.to_string_lossy()], Duration::from_secs(5 * 60));
    Ok(install_result(&r))
}

fn install_result(r: &Output) -> Value {
    let out = r.out();
    let fail = regex::Regex::new(r"Failure \[([^\]]+)\]").unwrap().captures(&out).map(|c| c[1].to_string());
    if r.ok && fail.is_none() {
        return json!({ "ok": true, "message": "Installed." });
    }
    let hint = if out.contains("INSTALL_FAILED_UPDATE_INCOMPATIBLE") {
        " The phone has a version signed with a different key: uninstall the app from the phone first (its data will be lost)."
    } else if out.contains("INSTALL_FAILED_VERSION_DOWNGRADE") {
        " The phone has a newer version: uninstall it first, or raise the version number."
    } else if out.contains("unauthorized") {
        " Unlock the phone and allow USB debugging for this computer."
    } else {
        ""
    };
    let last = out.split('\n').next_back().map(|l| l.trim_end_matches('\r')).filter(|l| !l.is_empty()).unwrap_or("Install failed.");
    json!({ "ok": false, "message": format!("{}.{hint}", fail.as_deref().unwrap_or(last)) })
}

/// Command for a terminal that shows the app's logs and crashes from a device.
fn logs_command(project_id: &str, serial: &str) -> Result<String, String> {
    let root = store::project_path(project_id)?;
    let d = detect(&root);
    let adb = d.as_ref().and_then(|d| find_adb(d.android_dir.as_deref())).ok_or("adb (Android platform tools) wasn’t found.")?;
    if !valid_serial(serial) {
        return Err("Unknown device.".into());
    }
    // Crashes from any app, plus the app framework's own log (JavaScript console, Flutter print…).
    let tags: &[&str] = match d.map_or("", |d| d.kind) {
        "flutter" => &["AndroidRuntime:E", "flutter:V", "*:S"],
        "expo" | "react-native" => &["AndroidRuntime:E", "ReactNativeJS:V", "ReactNative:W", "unknown:ReactNative:W", "*:S"],
        "capacitor" => &["AndroidRuntime:E", "Capacitor:V", "Capacitor/Console:V", "*:S"],
        _ => &["AndroidRuntime:E", "*:W"],
    };
    let tags = tags.iter().map(|t| format!("'{t}'")).collect::<Vec<_>>().join(" ");
    Ok(format!("{}{} -s {serial} logcat -v time -T 1 {tags}", if WIN { "& " } else { "" }, q(&adb.to_string_lossy())))
}

/// Save log text where Claude can read it, and return the file's path.
fn save_log(project_id: &str, text: &str) -> Result<String, String> {
    store::project_path(project_id)?;
    let user_data = store::user_data_dir();
    let dir = user_data.join("mobile-logs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{project_id}-{}.log", iso(SystemTime::now()).replace([':', '.'], "-")));
    let n = text.chars().count();
    let tail: String = text.chars().skip(n.saturating_sub(200_000)).collect();
    fs::write(&file, tail).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adb_devices_list() {
        let d = parse_devices("List of devices attached\r\nR58M123 device usb:1 product:x model:Galaxy_S10 device:y\r\nemulator-5554 offline\r\n\r\n");
        assert_eq!(
            Value::Array(d),
            json!([
                { "serial": "R58M123", "state": "device", "name": "Galaxy S10", "emulator": false },
                { "serial": "emulator-5554", "state": "offline", "name": "Emulator", "emulator": true }
            ])
        );
    }
    #[test]
    fn install_failure_message() {
        let r = Output { ok: false, stdout: "Performing Streamed Install\nadb: failed to install x.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE: x]".into(), stderr: String::new(), not_found: false };
        assert_eq!(
            install_result(&r)["message"],
            "INSTALL_FAILED_VERSION_DOWNGRADE: x. The phone has a newer version: uninstall it first, or raise the version number."
        );
        assert!(!valid_serial("a b") && valid_serial("emulator-5554") && valid_serial("192.168.1.2:5555"));
    }
}
