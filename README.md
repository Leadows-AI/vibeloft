# Vibeloft

**A room for every project.**

Vibeloft is a desktop workspace for Claude Code projects. It keeps all your projects (web and React Native) in one place, grouped by client: architecture, features, bugs, delivery dates, and real terminals running the Claude Code CLI inside each repo.

Built with Tauri (Rust) and React + TypeScript. Windows today; macOS is not packaged yet.

## Install

Download `Vibeloft-Setup-<version>.exe` (installs and updates itself) or `Vibeloft-Portable-<version>.exe` (runs without installing, doesn't update) from [Releases](https://github.com/Leadows-AI/vibeloft/releases).

The builds are not code-signed yet, so Windows SmartScreen shows "Windows protected your PC" on first launch: click **More info → Run anyway**.

You also need:

- [Claude Code](https://claude.com/claude-code), signed in (run `claude` once). Vibeloft uses that login and the Claude Code installed on your computer; set `CLAUDE_CODE_PATH` to use a different `claude` executable.
- [GitHub CLI](https://cli.github.com), signed in (`gh auth login`), for cloning and issue sync.

## Build from source

Requirements: Node.js 20+, [Rust](https://rustup.rs) (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (on Windows: Microsoft C++ Build Tools and WebView2).

```bash
npm install
npm run dev        # development, with hot reload
npm run typecheck  # TypeScript check
npm run build      # installer in src-tauri/target/release/bundle/
cd src-tauri && cargo test
```

## What it does

| Area | Details |
|---|---|
| Dashboard | All projects grouped by customer, open bugs, features in progress, next delivery, last commit |
| Layout | In a project, collapse the sidebar to an icon rail, and use the project's file tree on the right of every tab (click to open in Files, drag onto the terminal for the path); both collapse and are remembered. **Open folder** (File Explorer / Finder) from the tree, the project's … menu or Overview. |
| Archive & delete | Archive a project to hide it and close its terminals (restore any time from the dashboard), or delete it, optionally moving its folder to the Recycle Bin / Trash |
| Features & bugs | Kanban board (Backlog → Done), priorities, milestone links, drag and drop |
| GitHub sync | Two-way with GitHub Issues: imports issues, creates issues for new items, syncs title, body, open/closed, assignees, board column and priority (as `status:…` and `priority:…` labels), so a team sharing the repo shares one board. Bugs use the `bug` label, features use `enhancement`. |
| Timeline | Milestones per project and a cross-customer Deliveries view with overdue warnings. Milestones sync both ways with GitHub milestones, and issues are linked to them. |
| Time | Start/stop timer (one at a time, shown in the sidebar, survives restarts), manual entries, totals for today/week/month, CSV export, optional hourly rate. |
| Preview | Live preview of the running app (web, or Expo web) next to your work, with desktop/tablet/phone widths. Dev server addresses printed in terminals are picked up automatically. |
| Reports | 📄 Report on a project (or a whole customer): completed work, in progress, open bugs, upcoming deliveries, optional commits and time. Claude can write the summary. Save as PDF, copy as text or email. |
| Templates | New project → New from template: Web app (React + Vite + Express, TypeScript) or Mobile app (Expo, TypeScript), with CLAUDE.md, .gitignore for secrets, a first commit, an optional private GitHub repo, and npm install in a terminal. |
| Architecture | Claude reads the repo (read-only) and writes an overview with a Mermaid diagram. Can be saved to `docs/ARCHITECTURE.md`. |
| Files | Project tree with right-click New file / New folder / Rename / Delete (to the Recycle Bin), search across all files with replace, Ctrl+P quick open, and a built-in Monaco editor: tabs, find/replace, Ctrl+S, Prettier formatting (Shift+Alt+F, and on save in projects that use Prettier). The tree and open files refresh by themselves when files change on disk. |
| Git | A banner says what to do next (commit, pull, push, merge). Changed files, side-by-side diffs, stage/unstage/discard, commit (Claude can write the message; .env files are never shown to Claude), push, pull, branches, **Merge into main** and recent commits. |
| Environment | All `.env` files with values hidden until revealed, git-safety warnings, missing keys vs `.env.example`, and an inline editor. Values are never sent to Claude. |
| Terminal | Real terminals in each project folder (PowerShell on Windows, your login shell on macOS). One click starts the full **Claude Code CLI**, or **↺ Continue** resumes the last conversation (`claude --continue`). Shift+Enter adds a new line in Claude's prompt, Ctrl/⌘+V pastes text or a screenshot, file paths in the output open in the editor at the right line, and a pulsing dot (plus a desktop notification) tells you when Claude finishes or needs an answer while you're elsewhere. Several tabs per project, an npm-script runner, and terminals keep running while you switch projects. |
| Terminal extras | **Undo what Claude did**: a checkpoint of your files is saved each time you send Claude Code a prompt (hidden git refs under `refs/vibeloft/`, never pushed; your index and branches are untouched; ignored files like `.env` are never changed); one click puts the files back, byte for byte. A **Changed files** panel with diffs, a **"Claude changed N files"** bar after each turn (Review / Undo / Commit & Push), a **git bar** with one-click Commit & Push (Claude writes the message), **quick prompts** you can edit, a **bugs & features** picker, **History** to resume any past Claude Code conversation, **split view**, find (Ctrl+F), text size (Ctrl +/−), double-click to rename a tab, drag files in to insert their path, and a ▾ menu to start Claude Code with a chosen model and mode (Normal, Auto-accept edits, Plan). |
| Settings | Light/dark theme, interface and code fonts from Google Fonts (downloaded once, then embedded), Claude account and model, GitHub sign-in, and automatic updates (can be turned off). |

## Updates

The installed app reads the signed `latest.json` from the newest release (`https://github.com/Leadows-AI/vibeloft/releases/latest/download/latest.json`) shortly after it starts and every 4 hours, checks the installer's signature, and installs it when the app closes or on **Restart to update**. Turn this off in **Settings › About & updates**; **Check now** still works. Development runs and the portable copy never update themselves. Builds you make yourself are not signed with the release key, so official releases won't replace them.

## Safety

Closing the app with unsaved editor changes or running terminals asks first (Save all / Don't save / Cancel).

## Data

Stored in one JSON file in the app-data folder (`%APPDATA%/Vibeloft/studio.json` on Windows). Back it up by copying that file.

## Layout

```
src-tauri     Rust backend: store, git, GitHub sync, terminals, Claude Code, updates
src/renderer  React UI
src/shared    Types and IPC channel names shared by the UI and the backend
scripts       Release script
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue, see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Leadows Technologies.

## About

Vibeloft is an independent project built on Claude Code. It is not an Anthropic product and is not affiliated with or endorsed by Anthropic.
