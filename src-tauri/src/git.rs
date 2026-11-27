// Folder inspection and repo info. Use util::run for git.
use crate::util::{run, Args, Res};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{fs, path::Path};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "folder:inspect" => Ok(inspect_folder(&a.s(0))),
        "folder:repoInfo" => Ok(repo_info(&a.s(0))),
        _ => return None,
    })
}

/// "https://github.com/a/b.git" or "git@github.com:a/b.git" -> "a/b"
pub fn parse_github_slug(url: &str) -> Option<String> {
    let re = Regex::new(r"(?i)github\.com[:/]([^/]+)/([^/\s]+?)(?:\.git)?/?$").unwrap();
    re.captures(url.trim()).map(|m| format!("{}/{}", &m[1], &m[2]))
}

const STACK_HINTS: &[(&str, &str)] = &[
    ("expo", "Expo"),
    ("react-native", "React Native"),
    ("next", "Next.js"),
    ("react", "React"),
    ("vue", "Vue"),
    ("@angular/core", "Angular"),
    ("svelte", "Svelte"),
    ("vite", "Vite"),
    ("express", "Express"),
    ("fastify", "Fastify"),
    ("@nestjs/core", "NestJS"),
    ("prisma", "Prisma"),
    ("mongoose", "MongoDB"),
    ("pg", "PostgreSQL"),
    ("firebase", "Firebase"),
    ("@supabase/supabase-js", "Supabase"),
    ("tailwindcss", "Tailwind"),
    ("typescript", "TypeScript"),
];

fn read_deps(pkg_path: &Path, deps: &mut Map<String, Value>) {
    let Ok(pkg) = fs::read_to_string(pkg_path).map_err(|_| ()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|_| ())) else {
        return;
    };
    for key in ["dependencies", "devDependencies"] {
        if let Some(d) = pkg[key].as_object() {
            deps.extend(d.clone());
        }
    }
}

fn inspect_folder(path: &str) -> Value {
    let dir = Path::new(path);
    // Not a git repo or no origin: no repo.
    let repo = run("git", &["remote", "get-url", "origin"], Some(dir), None).ok().and_then(|u| parse_github_slug(&u));

    // Look at the root and common monorepo sub-folders (client/server/app/mobile...).
    let mut deps = Map::new();
    for sub in ["", "client", "server", "frontend", "backend", "web", "api", "app", "mobile"] {
        let p = dir.join(sub).join("package.json");
        if p.exists() {
            read_deps(&p, &mut deps);
        }
    }
    let mut stack: Vec<&str> = STACK_HINTS.iter().filter(|(dep, _)| deps.contains_key(*dep)).map(|(_, label)| *label).collect();
    if dir.join("pubspec.yaml").exists() {
        stack.push("Flutter");
    }
    if dir.join("requirements.txt").exists() || dir.join("pyproject.toml").exists() {
        stack.push("Python");
    }

    let kind = if deps.contains_key("react-native") || deps.contains_key("expo") {
        "mobile"
    } else if !stack.is_empty() {
        "web"
    } else {
        "other"
    };
    let mut tech: Vec<&str> = vec![];
    for s in stack {
        if !tech.contains(&s) {
            tech.push(s);
        }
    }
    let name = match &repo {
        Some(r) => r.split('/').nth(1).unwrap_or_default().to_string(),
        None => dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
    };
    json!({ "repo": repo, "kind": kind, "name": name, "techStack": tech })
}

fn repo_info(path: &str) -> Value {
    let dir = Path::new(path);
    if !dir.exists() {
        return json!({ "lastCommit": null, "branch": null, "dirty": false });
    }
    let git = |args: &[&str]| run("git", args, Some(dir), None).unwrap_or_default().trim().to_string();
    let log = git(&["log", "-1", "--format=%cI|%s"]);
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    let status = git(&["status", "--porcelain"]);
    let or_null = |s: String| if s.is_empty() { Value::Null } else { Value::String(s) };
    json!({ "lastCommit": or_null(log), "branch": or_null(branch), "dirty": !status.is_empty() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_slugs() {
        assert_eq!(parse_github_slug("https://github.com/a/b.git\n").as_deref(), Some("a/b"));
        assert_eq!(parse_github_slug("git@github.com:a/b.git").as_deref(), Some("a/b"));
        assert_eq!(parse_github_slug("https://github.com/a/b/").as_deref(), Some("a/b"));
        assert_eq!(parse_github_slug("https://gitlab.com/a/b"), None);
    }
}
