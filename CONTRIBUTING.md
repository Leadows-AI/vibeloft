# Contributing to Vibeloft

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Issues

Search the existing issues first. For a bug, say what you did, what you expected, what happened, and your Vibeloft and Windows versions (Settings › About & updates).

## Pull requests

1. Fork the repo and branch from `main`.
2. Set up as in [Build from source](README.md#build-from-source).
3. Keep the change focused. Before opening the pull request, run:
   ```bash
   npm run typecheck
   cd src-tauri && cargo test
   ```
4. Version: a pull request that adds a feature raises the minor version, a fix raises the patch version (`npm version minor --no-git-tag-version`, and the same number in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`).

By submitting a pull request you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as described in section 5 of the license.

## Releases (maintainers)

On an up-to-date, pushed `main`, run `npm run release` (or `NOTES="- …" npm run release` for your own notes). It builds the installer and the portable `.exe`, signs the update with the release key, and creates the GitHub release `v<version>` on that commit with `latest.json` for the updater and release notes from the pull requests merged since the last release. The signing key is not in this repository.
