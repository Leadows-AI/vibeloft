// Publish the version in package.json as a GitHub release of Leadows-AI/vibeloft,
// which installed copies update to by themselves.
//
//   npm run release
//   NOTES="- line…" npm run release    your own release notes
//
// Each feature or fix raises the version in its own pull request (minor for a
// feature, patch for a fix), so a release publishes what's on main as it is.
// Builds the Tauri app (src-tauri) and uploads, as release v<version> tagged on
// the current commit (which must be pushed):
//   - the Windows installer and the portable .exe
//   - latest.json, the signed manifest Vibeloft's updater reads
// Release notes list the pull requests merged since the previous release.
// Normally run by the Release workflow (.github/workflows/release.yml), which
// passes the signing key and a GitHub token in the environment. Run locally, it
// uses your GitHub CLI login (gh auth login) and the key in ~/.tauri/vibeloft-rust.key.

import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = 'Leadows-AI/vibeloft'

const env = { ...process.env }
try {
  env.GH_TOKEN = env.GH_TOKEN || execSync('gh auth token', { encoding: 'utf8' }).trim()
} catch {
  console.error('Sign in to GitHub first: gh auth login')
  process.exit(1)
}
const out = (file, args) => execFileSync(file, args, { encoding: 'utf8', env }).trim()
const gh = (...args) => out('gh', args)
const git = (...args) => out('git', args)
const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${version}`

// One version everywhere: the app reports Cargo.toml's, the bundle uses tauri.conf.json's.
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
const cargoVersion = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]*)"/m)?.[1]
if (conf.version !== version || cargoVersion !== version) {
  fail(`Versions differ: package.json ${version}, tauri.conf.json ${conf.version}, Cargo.toml ${cargoVersion}. Make them the same and commit.`)
}

// The release is tagged on this commit, so it must be committed and on GitHub.
if (git('status', '--porcelain')) fail('Commit or stash your changes first.')
git('fetch', '--tags', 'origin')
const head = git('rev-parse', 'HEAD')
if (!git('branch', '-r', '--contains', head)) fail('Push this commit to GitHub first.')

// The updater only installs builds signed with this key (its public half is in tauri.conf.json).
// Keep a backup: without it, installed copies can never be updated again.
const keyFile = join(homedir(), '.tauri', 'vibeloft-rust.key')
const key = process.env.TAURI_SIGNING_PRIVATE_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : '')
if (!key) fail(`The updater signing key is missing: set TAURI_SIGNING_PRIVATE_KEY or put it in ${keyFile}`)

let previous = ''
try {
  previous = gh('release', 'view', '-R', repo, '--json', 'tagName', '--jq', '.tagName')
} catch {
  /* no release yet */
}
if (previous === tag) fail(`${tag} is already published. Raise the version first.`)

const custom = process.env.NOTES?.trim()
if (!custom && !previous) fail('This is the first release: write its notes with NOTES="- …" npm run release')
const changes = custom
  ? []
  : git('log', '--first-parent', '--format=%s', `${previous}..HEAD`)
      .split('\n')
      .filter(Boolean)
      .map((subject) => {
        const pr = subject.match(/^Merge pull request #(\d+)/)
        return pr ? gh('pr', 'view', pr[1], '-R', repo, '--json', 'title', '--jq', '.title') : subject
      })
      .filter((title) => !/^(Version|Release) \d/.test(title))
const notes = custom || (changes.length ? changes : ['Maintenance and small fixes.']).map((c) => `- ${c}`).join('\n')
console.log(`\nRelease notes for ${version}:\n${notes}\n`)

console.log(`Building and publishing Vibeloft ${version} to ${repo}…\n`)
const signing = { ...env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' }
execSync('npx tauri build', { stdio: 'inherit', env: signing })
const built = `src-tauri/target/release/bundle/nsis/Vibeloft_${version}_x64-setup.exe`
if (!existsSync(built) || !existsSync(`${built}.sig`)) fail(`The build didn't produce ${built} and its .sig. Nothing was published.`)

// Plain file names (GitHub turns spaces into dots).
const dir = 'dist/release'
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const setupName = `Vibeloft-Setup-${version}.exe`
const installer = join(dir, setupName)
const portable = join(dir, `Vibeloft-Portable-${version}.exe`)
copyFileSync(built, installer)
copyFileSync('src-tauri/target/release/vibeloft.exe', portable)

const latestJson = join(dir, 'latest.json')
const url = `https://github.com/${repo}/releases/download/${tag}/${setupName}`
const signature = readFileSync(`${built}.sig`, 'utf8').trim()
writeFileSync(latestJson, JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms: { 'windows-x86_64': { signature, url } } }, null, 2))

const notesFile = join(tmpdir(), `vibeloft-${version}-notes.md`)
writeFileSync(notesFile, notes)
execFileSync('gh', ['release', 'create', tag, '-R', repo, '--target', head, '--title', version, '--notes-file', notesFile, installer, portable, latestJson], { stdio: 'inherit', env })

console.log(`\nPublished Vibeloft ${version}: https://github.com/${repo}/releases/tag/${tag}`)
console.log('Installed copies pick it up within a few hours, or at once via Settings → About & updates → Check now.')
