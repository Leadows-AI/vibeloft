# Contributing to Vibeloft

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Issues

Questions and open-ended ideas go to [Discussions](https://github.com/Leadows-AI/vibeloft/discussions). For bugs and concrete requests, search the existing issues first, then use the **Bug report** or **Feature request** form. Security problems go to [private reporting](SECURITY.md), not issues.

Looking for something to work on? Try issues labelled [`good first issue`](https://github.com/Leadows-AI/vibeloft/labels/good%20first%20issue) or [`help wanted`](https://github.com/Leadows-AI/vibeloft/labels/help%20wanted). For anything bigger than a small fix, comment on the issue (or open one) first, so we agree on the approach before you write the code.

## Pull requests

1. Fork the repo and branch from `main`.
2. Set up as in [Build from source](README.md#build-from-source).
3. Keep the change focused. Before opening the pull request, run:
   ```bash
   npm run typecheck
   cd src-tauri && cargo test
   ```
4. Version: a pull request that adds a feature raises the minor version, a fix raises the patch version (`npm version minor --no-git-tag-version`, and the same number in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`). Docs and CI changes don't need one.
5. Write the title as a release note ("Add split view to terminals"): pull requests are squash-merged, so the title becomes the commit on `main` and a line in the release notes. CI must pass before merging.

By submitting a pull request you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as described in section 5 of the license.

## Releases (maintainers)

1. Merge a pull request that raises the version (title it `Release x.y.z`; it's left out of the release notes).
2. **Actions › Release › Run workflow** on `main`, optionally with your own notes.
3. Approve the run when GitHub asks: the `release` environment holds the updater signing key and needs an approval.

The workflow builds the installer and the portable `.exe` on Windows, signs the update, and creates the GitHub release `v<version>` on that commit with `latest.json` for the updater and release notes from the pull requests merged since the last release. It stops without publishing if the version numbers differ or that version is already released. The signing key is never in this repository; `npm run release` does the same locally for a maintainer who has the key in `~/.tauri/vibeloft-rust.key`.
