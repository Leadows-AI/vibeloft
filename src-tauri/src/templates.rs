// Start a new customer project from a template: the files, a CLAUDE.md with
// the project's context, git with a first commit, and optionally a private
// GitHub repository. Dependencies are installed afterwards in a terminal tab,
// so you can watch the progress.
use crate::util::{self, Args, Res};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    process::Stdio,
};

pub fn handle(ch: &str, a: &Args) -> Option<Res> {
    Some(match ch {
        "template:create" => create_from_template(&a.v(0)),
        _ => return None,
    })
}

pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let slug: String = out.trim_matches('-').chars().take(60).collect();
    if slug.is_empty() { "new-app".into() } else { slug }
}

fn write_files(root: &Path, files: &[(&str, String)]) -> Result<(), String> {
    for (rel, content) in files {
        let full = root.join(rel);
        fs::create_dir_all(full.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&full, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// The package.json/tsconfig texts are written out as JSON.stringify(v, null, 2) prints them
// (serde_json would sort the keys).
fn web_files(name: &str, slug: &str, description: &str) -> Vec<(&'static str, String)> {
    let fill = |t: &str| t.replace("__SLUG__", slug).replace("__NAME__", name).replace("__DESC__", &json!(description).to_string());
    vec![
        ("package.json", fill(r#"{
  "name": "__SLUG__",
  "private": true,
  "description": __DESC__,
  "workspaces": [
    "client",
    "server"
  ],
  "scripts": {
    "dev": "concurrently -n server,client -c green,cyan \"npm run dev -w server\" \"npm run dev -w client\"",
    "build": "npm run build -w server && npm run build -w client",
    "typecheck": "npm run typecheck -w server && npm run typecheck -w client"
  },
  "devDependencies": {
    "concurrently": "^10.0.7"
  }
}
"#)),
        (".gitignore", "node_modules/\ndist/\n.env\n.env.*\n!.env.example\n*.log\n.DS_Store\n".into()),
        (".env.example", "# Copy to server/.env and fill in.\nPORT=4000\n# DATABASE_URL=\n".into()),
        ("README.md", format!("# {name}\n\n{}\n\n## Run\n\n```bash\nnpm install\nnpm run dev\n```\n\n- Client: http://localhost:5173 (React + Vite)\n- API: http://localhost:4000/api/health (Express)\n\nThe client forwards `/api` requests to the server, so no CORS setup is needed in development.\n", if description.is_empty() { "A web application." } else { description })),
        // ---------- client ----------
        ("client/package.json", fill(r#"{
  "name": "__SLUG__-client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  },
  "devDependencies": {
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.3.0",
    "typescript": "^7.0.2",
    "vite": "^8.3.8"
  }
}
"#)),
        ("client/tsconfig.json", r#"{
  "compilerOptions": {
    "target": "ES2022",
    "lib": [
      "ES2022",
      "DOM",
      "DOM.Iterable"
    ],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": [
    "src"
  ]
}
"#.into()),
        ("client/vite.config.ts", r#"import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // Calls to /api go to the Express server during development.
    proxy: { '/api': 'http://localhost:4000' }
  }
})
"#.into()),
        ("client/index.html", fill(r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
"#)),
        ("client/src/main.tsx", r#"import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
"#.into()),
        ("client/src/App.tsx", fill(r#"import { useEffect, useState } from 'react'

export default function App() {
  const [status, setStatus] = useState('checking…')

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d: { ok: boolean }) => setStatus(d.ok ? 'connected' : 'error'))
      .catch(() => setStatus('not running'))
  }, [])

  return (
    <main className="app">
      <h1>__NAME__</h1>
      <p>API: {status}</p>
    </main>
  )
}
"#)),
        ("client/src/styles.css", r#":root {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #1c2622;
  background: #f4f6f5;
}
body {
  margin: 0;
}
.app {
  max-width: 720px;
  margin: 80px auto;
  padding: 0 24px;
}
"#.into()),
        // ---------- server ----------
        ("server/package.json", fill(r#"{
  "name": "__SLUG__-server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "cors": "^2.8.6",
    "express": "^5.3.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.19",
    "@types/express": "^5.0.6",
    "@types/node": "^26.6.6",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2"
  }
}
"#)),
        ("server/tsconfig.json", r#"{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": [
    "src"
  ]
}
"#.into()),
        ("server/src/index.ts", r#"import cors from 'cors'
import express from 'express'

const app = express()
app.use(cors())
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

const port = Number(process.env.PORT) || 4000
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`)
})
"#.into()),
    ]
}

fn claude_md(name: &str, customer: Option<&str>, description: &str, web: bool) -> String {
    [
        format!("# {name}"),
        String::new(),
        match customer.filter(|c| !c.is_empty()) {
            Some(c) => format!("Built for **{c}**."),
            None => String::new(),
        },
        if description.is_empty() { String::new() } else { format!("\n{description}") },
        String::new(),
        "## Stack".into(),
        if web {
            "- `client/`: React 19 + Vite + TypeScript (http://localhost:5173)\n- `server/`: Express 5 + TypeScript, run with tsx (http://localhost:4000)\n- The client proxies `/api` to the server in development.".into()
        } else {
            "- Expo (React Native) with TypeScript.".into()
        },
        String::new(),
        "## Commands".into(),
        if web {
            "- `npm install` once, then `npm run dev` starts client and server together.\n- `npm run typecheck` checks both packages. Run it after changes.\n- `npm run build` builds both.".into()
        } else {
            "- `npm install` once, then `npx expo start` (press `w` for web, scan the QR code with Expo Go for a phone).\n- `npx tsc --noEmit` type-checks the app. Run it after changes.".into()
        },
        String::new(),
        "## Conventions".into(),
        "- TypeScript everywhere, strict mode. No `any` unless unavoidable.".into(),
        "- Keep components and modules small and focused; prefer clear names over comments.".into(),
        "- Secrets live in `.env` files, which are git-ignored. Document new variables in `.env.example`.".into(),
        "- Do not commit; the developer reviews and commits changes.".into(),
        String::new(),
    ]
    .join("\n")
}

fn npx(args: &[&str], cwd: &Path) -> Result<(), String> {
    // npx is a script on Windows, so it goes through cmd; every argument here is generated, not user text.
    let mut c = if cfg!(windows) {
        let mut c = util::command("cmd");
        c.args(["/c", "npx"]);
        c
    } else {
        util::command("npx")
    };
    let out = c.args(args).current_dir(cwd).env("CI", "1").stdin(Stdio::null()).stdout(Stdio::null()).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let lines: Vec<&str> = err.trim().split('\n').collect();
    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
    Err(if tail.is_empty() { format!("npx exited with code {}", out.status.code().unwrap_or(-1)) } else { tail })
}

fn first_line(e: &str) -> &str {
    e.split('\n').next().unwrap_or_default()
}

fn create_from_template(opts: &Value) -> Res {
    let name = opts["name"].as_str().unwrap_or_default();
    let description = opts["description"].as_str().unwrap_or_default();
    let customer = opts["customerName"].as_str();
    let parent = Path::new(opts["parentDir"].as_str().unwrap_or_default());
    let slug = slugify(name);
    if !parent.exists() {
        return Err("The parent folder does not exist.".into());
    }
    let path = parent.join(&slug);
    if path.exists() {
        return Err(format!("A folder named \"{slug}\" already exists there."));
    }
    let mut notes: Vec<String> = vec![];
    let err = |e: std::io::Error| e.to_string();

    if opts["template"] == "web" {
        write_files(&path, &web_files(name, &slug, description))?;
        fs::write(path.join("CLAUDE.md"), claude_md(name, customer, description, true)).map_err(err)?;
    } else {
        npx(&["--yes", "create-expo-app@latest", &slug, "--template", "blank-typescript", "--no-install", "--yes"], parent)?;
        // Expo writes its own CLAUDE.md with Expo guidance; add this project's context on top.
        let file = path.join("CLAUDE.md");
        let ours = claude_md(name, customer, description, false);
        match fs::read_to_string(&file) {
            Ok(theirs) => fs::write(&file, format!("{ours}\n---\n\n{theirs}")),
            Err(_) => fs::write(&file, ours),
        }
        .map_err(err)?;
        let gi = path.join(".gitignore");
        if !fs::read_to_string(&gi).unwrap_or_default().lines().any(|l| l == ".env") {
            OpenOptions::new().create(true).append(true).open(&gi).and_then(|mut f| f.write_all(b"\n# secrets\n.env\n.env.*\n!.env.example\n")).map_err(err)?;
        }
    }

    // git: first commit
    let git = |args: &[&str]| util::run("git", args, Some(&path), None);
    let committed = git(&["init", "-b", "main"])
        .or_else(|_| git(&["init"]))
        .and_then(|_| git(&["add", "-A"]))
        .and_then(|_| git(&["commit", "-m", "Initial commit from Vibeloft template"]));
    if let Err(e) = committed {
        notes.push(format!(
            "Git repository created, but the first commit failed: {}. Set your name and email with \"git config --global user.name\" and \"user.email\".",
            first_line(&e)
        ));
    }

    // GitHub: private repository
    let mut repo: Option<String> = None;
    if opts["createGithubRepo"] == true {
        let path_s = path.to_string_lossy().into_owned();
        let created = util::run("gh", &["api", "user", "--jq", ".login"], None, None).and_then(|user| {
            let full = format!("{}/{slug}", user.trim());
            util::run("gh", &["repo", "create", &full, "--private", "--source", &path_s, "--remote", "origin", "--push"], Some(&path), None).map(|_| full)
        });
        match created {
            Ok(r) => repo = Some(r),
            Err(e) => notes.push(format!("The GitHub repository could not be created: {}", first_line(&e))),
        }
    }

    Ok(json!({ "path": path.to_string_lossy(), "repo": repo, "installCommand": "npm install", "notes": notes }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slugs_and_web_files() {
        assert_eq!(slugify("  My Café App!! "), "my-caf-app");
        assert_eq!(slugify("***"), "new-app");
        for (rel, text) in web_files("Shop", "shop", "A \"quoted\" shop") {
            if rel.ends_with(".json") {
                let v: Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{rel}: {e}"));
                assert!(text.ends_with("}\n"));
                if rel == "package.json" {
                    assert_eq!(v["description"], "A \"quoted\" shop");
                }
            }
        }
    }
}
