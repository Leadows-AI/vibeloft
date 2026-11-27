import { FitAddon } from '@xterm/addon-fit'
import { isDarkColor, MONO, MONO_SIZE, MONO_WEIGHT, monoReady, monoSizeSetting, TERM_BG, termColors } from './fonts'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useSyncExternalStore } from 'react'
import type { CheckpointChange, TerminalInfo } from '../../shared/types'
import { setProjectWaiting } from './attention'
import { scanForUrls } from './previewUrls'
import { clearNotices, clearTransient, noticeFromFailure, noticeFromHook, scanClaudeOutput, setClaudeStatus } from './claudeNotices'
import { markDone } from './help/progress'
import { api } from './ui'

// Each terminal's xterm instance lives here for the whole app session, so its
// screen and scrollback survive switching tabs and projects. The visible
// panel just moves the terminal's element into place.

interface Session {
  info: TerminalInfo
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
  /** Claude Code finished or is waiting for you, and you haven't looked yet. */
  waiting: boolean
  busy: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  search: SearchAddon
  /** What you've typed since the last Enter (to label checkpoints). */
  typed: string
  /** The current Claude turn: started when you send a prompt. */
  turn: { checkpoint: string | null; prompt: string; sawOutput: boolean; timer: ReturnType<typeof setTimeout> | null } | null
  /** Files Claude changed in its last finished turn. */
  lastTurn: TurnSummary | null
  /** When this terminal started (to find which conversation it writes to). */
  startedAt: number
  /** You renamed the tab yourself: don't replace it with the conversation's title. */
  userRenamed: boolean
  /** Claude Code's hooks are reporting for this terminal: use them instead of guessing from silence. */
  hooked: boolean
  /** Claude is working on a prompt right now (from the hooks: prompt sent until finished). */
  working: boolean
}

export interface TurnSummary {
  terminalId: string
  projectId: string
  checkpoint: string
  prompt: string
  changes: CheckpointChange[]
  at: number
  dismissed: boolean
}

// A Claude tab stops counting as one once Claude Code has ended in it (the shell stays).
const isClaude = (info: TerminalInfo): boolean => /^claude\b/.test(info.command ?? '') && !info.claudeEnded

/** Terminals currently on screen (two in split view; none when the Terminal tab isn't showing). */
const visible = new Set<string>()
const projectRoots = new Map<string, string>()
const projectNames = new Map<string, string>()

export function setProjectInfo(projectId: string, root: string, name: string): void {
  projectRoots.set(projectId, root.replace(/\\/g, '/').replace(/\/+$/, ''))
  projectNames.set(projectId, name)
}

export function detachVisible(id?: string): void {
  if (id) visible.delete(id)
  else visible.clear()
}

function onScreen(id: string): boolean {
  return visible.has(id) && document.hasFocus() && document.visibilityState === 'visible'
}

function refreshProjectWaiting(projectId: string): void {
  setProjectWaiting(projectId, [...sessions.values()].some((s) => s.info.projectId === projectId && s.waiting))
}

/** Claude Code went quiet (finished, or needs an answer) while you weren't looking. */
function raiseWaiting(s: Session): void {
  if (onScreen(s.info.id) || s.waiting) return
  s.waiting = true
  refreshProjectWaiting(s.info.projectId)
  notify()
  api.requestAttention()
  try {
    const name = projectNames.get(s.info.projectId) ?? 'a project'
    const changed = s.lastTurn && !s.lastTurn.dismissed ? s.lastTurn.changes.length : 0
    const n = new Notification(`Claude Code needs you — ${name}`, {
      body: `"${s.info.title}" finished or is waiting for your answer.${changed ? ` ${changed} file${changed === 1 ? '' : 's'} changed.` : ''}`,
      silent: false
    })
    n.onclick = () => {
      api.focusWindow()
      active.set(s.info.projectId, s.info.id)
      notify()
      window.dispatchEvent(new CustomEvent('vibeloft:goto-terminal', { detail: { projectId: s.info.projectId } }))
    }
  } catch {
    /* notifications unavailable */
  }
}

function clearWaiting(s: Session): void {
  if (!s.waiting) return
  s.waiting = false
  refreshProjectWaiting(s.info.projectId)
  notify()
}

// When you come back to the window, the visible terminal counts as seen.
window.addEventListener('focus', () => {
  for (const id of visible) {
    const s = sessions.get(id)
    if (s) clearWaiting(s)
  }
})

// ---------- font size ----------
// The size comes from Settings (code font size). Ctrl+/Ctrl− zoom is for this
// session only; Ctrl+0 goes back to the Settings size. Before that setting
// existed the zoom was saved here, so it stays the size until one is picked.
let legacySize: number | null = null
try {
  const saved = Number(localStorage.getItem('vibeloft.terminalFontSize'))
  if (saved >= 9 && saved <= 28) legacySize = saved
} catch {
  /* storage unavailable */
}
const baseSize = (): number => monoSizeSetting ?? legacySize ?? MONO_SIZE
let fontSize = baseSize()

export function terminalFontSize(): number {
  return fontSize
}

/** delta 0 resets to the Settings size. */
export function zoomTerminals(delta: number): void {
  fontSize = delta === 0 ? baseSize() : Math.min(28, Math.max(9, fontSize + delta))
  for (const s of sessions.values()) s.term.options.fontSize = fontSize
  for (const id of visible) refit(id)
  notify()
}

// ---------- clickable file paths ----------

const fileLists = new Map<string, Promise<Set<string>>>()
api.onFilesChanged((e) => {
  if (e.paths.some((p) => !p.startsWith('.git/'))) fileLists.delete(e.projectId)
})
function projectFiles(projectId: string): Promise<Set<string>> {
  let f = fileLists.get(projectId)
  if (!f) {
    f = api.listAllFiles(projectId).then((l) => new Set(l), () => new Set<string>())
    fileLists.set(projectId, f)
  }
  return f
}

// Paths like src/app.ts, ./src/app.ts:42, C:\\proj\\src\\app.ts:42:7, (src/app.ts)
const PATH_RE = /(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)*\.[A-Za-z0-9]{1,10}(?::(\d+))?(?::(\d+))?/g

function toProjectPath(projectId: string, raw: string): string {
  let p = raw.replace(/\\/g, '/')
  const root = projectRoots.get(projectId)
  if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) p = p.slice(root.length + 1)
  return p.replace(/^\.\//, '')
}

const sessions = new Map<string, Session>()
const active = new Map<string, string>() // projectId -> terminal id
const listeners = new Set<() => void>()
let version = 0
let currentTheme: 'dark' | 'light' = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
new MutationObserver(() => setTerminalTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')).observe(
  document.documentElement,
  { attributes: true, attributeFilter: ['data-theme'] }
)

const isMac = api.platform === 'darwin'

const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#111418',
    foreground: '#ede8de',
    cursor: '#e8a23b',
    cursorAccent: '#111418',
    selectionBackground: 'rgba(127, 185, 138, 0.3)',
    black: '#1b1f2a',
    brightBlack: '#5c6477',
    red: '#f2555a',
    brightRed: '#ff7b7f',
    green: '#34c38f',
    brightGreen: '#5ee0ad',
    yellow: '#f0b429',
    brightYellow: '#ffd166',
    blue: '#4aa3ff',
    brightBlue: '#7dbcff',
    magenta: '#c792ea',
    brightMagenta: '#ddb6f2',
    cyan: '#2ed3b7',
    brightCyan: '#6ee7d3',
    white: '#c9cdd8',
    brightWhite: '#ffffff'
  },
  light: {
    background: '#fffdf8',
    foreground: '#14171c',
    cursor: '#3a6b44',
    cursorAccent: '#fffdf8',
    selectionBackground: 'rgba(79, 138, 91, 0.2)',
    black: '#1b1f2a',
    brightBlack: '#6a7285',
    red: '#d1343a',
    brightRed: '#e5484d',
    green: '#178a5f',
    brightGreen: '#1fa774',
    yellow: '#a86b00',
    brightYellow: '#c98500',
    blue: '#1f6fd1',
    brightBlue: '#3b88e8',
    magenta: '#7b3fa0',
    brightMagenta: '#9a5cc0',
    cyan: '#0f8f7c',
    brightCyan: '#14a891',
    white: '#c9cdd8',
    brightWhite: '#f6f7f9'
  }
}

function notify(): void {
  version++
  for (const l of listeners) l()
}

function makeSession(info: TerminalInfo): Session {
  const term = new Terminal({
    fontFamily: MONO,
    fontSize,
    fontWeight: MONO_WEIGHT,
    fontWeightBold: 700,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: termTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openUrl(uri)))
  const search = new SearchAddon()
  term.loadAddon(search)
  // Correct widths for emoji and symbols in Claude Code's interface.
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  // File paths printed by Claude, git or compilers open in the built-in editor.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      const found: { start: number; text: string; rel: string; line?: number; col?: number }[] = []
      PATH_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = PATH_RE.exec(line))) {
        if (line.slice(Math.max(0, m.index - 3), m.index).endsWith('://')) continue // a URL
        const pathPart = m[0].replace(/(:\d+){1,2}$/, '')
        found.push({ start: m.index, text: m[0], rel: toProjectPath(info.projectId, pathPart), line: m[1] ? Number(m[1]) : undefined, col: m[2] ? Number(m[2]) : undefined })
      }
      if (!found.length) return callback(undefined)
      projectFiles(info.projectId).then((files) => {
        const links = found
          .filter((f) => files.has(f.rel))
          .map((f) => ({
            range: { start: { x: f.start + 1, y }, end: { x: f.start + f.text.length, y } },
            text: f.text,
            decorations: { pointerCursor: true, underline: true },
            activate: () =>
              window.dispatchEvent(new CustomEvent('vibeloft:open-file', { detail: { projectId: info.projectId, rel: f.rel, line: f.line, col: f.col } }))
          }))
        callback(links.length ? links : undefined)
      })
    }
  })

  term.onData((d) => {
    api.termWrite(info.id, d)
    trackTyping(session, d)
  })
  term.onResize(({ cols, rows }) => api.termResize(info.id, cols, rows))

  // Copy/paste the way people expect: Ctrl/Cmd+C copies when text is selected
  // (otherwise it interrupts), Ctrl/Cmd+V pastes.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    const mod = isMac ? e.metaKey : e.ctrlKey
    const key = e.key.toLowerCase()
    if (mod && key === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection())
      term.clearSelection()
      return false
    }
    // Shift+Enter: new line in Claude Code's prompt instead of sending it.
    // (Sends the same sequence as Alt+Enter, which Claude Code reads as "newline".)
    if (key === 'enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      api.termWrite(info.id, '\x1b\r')
      e.preventDefault()
      return false
    }
    // Ctrl+K: the project switcher (handled by the app window).
    if (mod && key === 'k' && !e.shiftKey && !e.altKey) return false
    // Find, and font size.
    if (mod && key === 'f') {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('vibeloft:terminal-find', { detail: { id: info.id } }))
      return false
    }
    if (mod && (key === '=' || key === '+')) {
      e.preventDefault()
      zoomTerminals(1)
      return false
    }
    if (mod && key === '-') {
      e.preventDefault()
      zoomTerminals(-1)
      return false
    }
    if (mod && key === '0') {
      e.preventDefault()
      zoomTerminals(0)
      return false
    }
    if (mod && key === 'v' && !e.shiftKey) {
      e.preventDefault()
      void (async () => {
        const text = await api.clipboardText().catch(() => '')
        if (text) return term.paste(text)
        // A screenshot: let Claude Code read it from the clipboard itself
        // (its image-paste key is Alt+V on Windows, Ctrl+V on macOS).
        if (await api.clipboardHasImage().catch(() => false)) api.termWrite(info.id, isMac ? '\x16' : '\x1bv')
      })()
      return false
    }
    return true
  })

  const el = document.createElement('div')
  el.className = 'xterm-host'
  const session: Session = { info, term, fit, el, opened: false, waiting: false, busy: false, idleTimer: null, search, typed: '', turn: null, lastTurn: null, startedAt: Date.now(), userRenamed: false, hooked: false, working: false }
  term.onBell(() => isClaude(info) && raiseWaiting(session))
  // Resumed a known conversation: show its title on the tab.
  if (info.sessionId) void nameFromSession(session, info.sessionId)
  return session
}

api.onTermData(({ id, data }) => {
  const s = sessions.get(id)
  if (!s) return
  s.term.write(data)
  scanForUrls(s.info.projectId, data)
  if (isClaude(s.info)) scanClaudeOutput(id, data)
  // With hooks, Claude Code says exactly when it finishes or needs you (see the
  // hook handler below). Without them, fall back to watching for silence.
  if (s.hooked) return
  if (s.turn) {
    s.turn.sawOutput = true
    if (s.turn.timer) clearTimeout(s.turn.timer)
    s.turn.timer = setTimeout(() => void finishTurn(s), TURN_IDLE_MS)
  }
  // Claude Code animates while it works; ~3 s of silence means it's done or asking something.
  if (isClaude(s.info) && !onScreen(id)) {
    s.busy = true
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = setTimeout(() => {
      if (s.busy && !s.info.exited) raiseWaiting(s)
      s.busy = false
    }, 3000)
  }
})
api.onTermExit(({ id, code }) => {
  const s = sessions.get(id)
  if (!s) return
  s.info = { ...s.info, exited: true }
  s.working = false
  if (s.idleTimer) clearTimeout(s.idleTimer)
  if (s.turn?.timer) clearTimeout(s.turn.timer)
  if (s.turn?.sawOutput) void finishTurn(s)
  s.term.write(`\r\n\x1b[2m[Process exited with code ${code}. Close this tab or open a new one.]\x1b[0m\r\n`)
  notify()
})

/** Pick up terminals that are still running in the main process (e.g. after a UI reload). */
export async function loadTerminals(projectId: string): Promise<void> {
  const list = await api.termList(projectId)
  let changed = false
  for (const info of list) {
    if (sessions.has(info.id)) continue
    const s = makeSession(info)
    sessions.set(info.id, s)
    s.term.write(await api.termBacklog(info.id))
    changed = true
  }
  if (changed) {
    if (!active.has(projectId) && list.length) active.set(projectId, list[list.length - 1].id)
    notify()
  }
}

/** "Claude Code", then "Claude Code 2", "Claude Code 3"… among this project's open tabs. */
function uniqueTitle(projectId: string, title: string): string {
  const taken = new Set([...sessions.values()].filter((s) => s.info.projectId === projectId && !s.info.exited).map((s) => s.info.title))
  if (!taken.has(title)) return title
  for (let n = 2; ; n++) if (!taken.has(`${title} ${n}`)) return `${title} ${n}`
}

export async function openTerminal(projectId: string, opts: { title?: string; command?: string } = {}): Promise<string> {
  if (/^claude\b/.test(opts.command ?? '')) markDone('claudeStarted')
  if (opts.title) opts = { ...opts, title: uniqueTitle(projectId, opts.title) }
  const info = await api.termCreate(projectId, opts)
  sessions.set(info.id, makeSession(info))
  active.set(projectId, info.id)
  notify()
  return info.id
}

export async function openClaudeTask(projectId: string, opts: { title: string; prompt: string; plan: boolean; addDirs?: string[] }): Promise<string> {
  markDone('claudeStarted')
  markDone('promptSent')
  const info = await api.termClaudeTask(projectId, opts)
  sessions.set(info.id, makeSession(info))
  active.set(projectId, info.id)
  notify()
  return info.id
}

export async function closeTerminal(id: string): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  await api.termKill(id)
  if (s.idleTimer) clearTimeout(s.idleTimer)
  if (s.turn?.timer) clearTimeout(s.turn.timer)
  visible.delete(id)
  s.waiting = false
  refreshProjectWaiting(s.info.projectId)
  s.term.dispose()
  s.el.remove()
  sessions.delete(id)
  clearNotices(id)
  const projectId = s.info.projectId
  if (active.get(projectId) === id) {
    const rest = [...sessions.values()].filter((x) => x.info.projectId === projectId)
    if (rest.length) active.set(projectId, rest[rest.length - 1].info.id)
    else active.delete(projectId)
  }
  notify()
}

export function setActive(projectId: string, id: string): void {
  active.set(projectId, id)
  notify()
}

export function isWaiting(id: string): boolean {
  return sessions.get(id)?.waiting ?? false
}

/** Put the terminal's element into `host` and size it to fit. */
export function attach(id: string, host: HTMLElement, focus = true): void {
  const s = sessions.get(id)
  if (!s) return
  if (s.el.parentElement !== host) {
    host.replaceChildren(s.el)
  }
  if (!s.opened) {
    s.term.open(s.el)
    s.opened = true
  }
  refit(id)
  if (focus) s.term.focus()
  visible.add(id)
  s.busy = false
  if (s.idleTimer) clearTimeout(s.idleTimer)
  clearWaiting(s)
}

export function refit(id: string): void {
  const s = sessions.get(id)
  if (!s || !s.opened || !s.el.isConnected) return
  try {
    s.fit.fit()
  } catch {
    /* element not laid out yet */
  }
}

// Once JetBrains Mono has loaded, terminals that opened before it re-measure
// their character size so columns (and Claude Code's boxes) line up.
// The same when the code font, size or weight is changed in Settings.
const useMono = (): void => {
  fontSize = baseSize()
  for (const s of sessions.values()) {
    s.term.options.fontFamily = MONO
    s.term.options.fontSize = fontSize
    s.term.options.fontWeight = MONO_WEIGHT
    if (s.opened) refit(s.info.id)
  }
}
void monoReady.then(useMono)
window.addEventListener('vibeloft:mono-font', useMono)

/** The app theme's palette, with the Settings background and text colour on top (ANSI colours suit the background). */
function termTheme(): ITheme {
  const base = THEMES[TERM_BG ? (isDarkColor(TERM_BG) ? 'dark' : 'light') : currentTheme]
  const { bg, fg } = termColors(currentTheme)
  return { ...base, background: bg, foreground: fg, cursorAccent: bg }
}

export function setTerminalTheme(theme: 'dark' | 'light'): void {
  currentTheme = theme
  const t = termTheme()
  for (const s of sessions.values()) s.term.options.theme = t
}
window.addEventListener('vibeloft:term-colors',() => setTerminalTheme(currentTheme))

export function focusTerminal(id: string): void {
  sessions.get(id)?.term.focus()
}

export function useTerminals(projectId: string): { list: TerminalInfo[]; activeId: string | null } {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
  return {
    list: [...sessions.values()].filter((s) => s.info.projectId === projectId).map((s) => s.info),
    activeId: active.get(projectId) ?? null
  }
}

export function runningCount(projectId: string): number {
  return [...sessions.values()].filter((s) => s.info.projectId === projectId && !s.info.exited).length
}

// ---------- Claude turns: checkpoint before, summary after ----------

/** Claude Code animates while it works; this much silence means the turn is over (or it's asking you). */
const TURN_IDLE_MS = 3500

function trackTyping(s: Session, d: string): void {
  if (!isClaude(s.info)) return
  if (d === '\r') {
    const prompt = s.typed.trim()
    s.typed = ''
    // Enter on its own (answering a menu, approving a tool) continues the current turn.
    if (prompt.length >= 2 && !s.hooked) void startTurn(s, prompt)
    return
  }
  if (d === '\x7f' || d === '\b') s.typed = s.typed.slice(0, -1)
  else if (d === '\x03' || d === '\x1b') {
    s.typed = ''
    // Esc or Ctrl+C while Claude works interrupts it.
    if (s.working) interrupted(s)
  }
  else if (!d.startsWith('\x1b') || d.startsWith('\x1b[200~')) s.typed = (s.typed + d.replace(/\x1b\[20[01]~/g, '')).slice(-2000)
}

async function startTurn(s: Session, prompt: string): Promise<void> {
  markDone('promptSent')
  if (s.turn?.timer) clearTimeout(s.turn.timer)
  const turn: NonNullable<Session['turn']> = { checkpoint: null, prompt, sawOutput: false, timer: null }
  s.turn = turn
  try {
    const cp = await api.checkpointCreate(s.info.projectId, `Before: ${prompt.replace(/\s+/g, ' ').slice(0, 120)}`)
    turn.checkpoint = cp?.id ?? null
  } catch {
    turn.checkpoint = null
  }
  emitCheckpoints(s.info.projectId)
}

async function finishTurn(s: Session): Promise<void> {
  const turn = s.turn
  if (!turn || !turn.sawOutput) return
  turn.sawOutput = false
  // With hooks the exact conversation is already known (SessionStart).
  if (!s.hooked) void detectSession(s)
  if (!turn.checkpoint) return
  const changes = await api.checkpointChanges(s.info.projectId, turn.checkpoint).catch(() => [] as CheckpointChange[])
  // Claude already committed its work (e.g. "commit and push"): nothing left to review.
  // Every repository counts: one project folder can hold several apps.
  const committed = changes.length > 0 && (await api.gitRepos(s.info.projectId).then((g) => g.repos.every((r) => r.changes === 0), () => false))
  s.lastTurn = {
    terminalId: s.info.id,
    projectId: s.info.projectId,
    checkpoint: turn.checkpoint,
    prompt: turn.prompt,
    changes,
    at: Date.now(),
    dismissed: changes.length === 0 || committed
  }
  notify()
}

export function lastTurn(id: string | null): TurnSummary | null {
  return id ? (sessions.get(id)?.lastTurn ?? null) : null
}

/** Hide every "Claude changed N files" bar in a project (e.g. once the changes are committed). */
export function dismissProjectTurns(projectId: string): void {
  let changed = false
  for (const s of sessions.values()) {
    if (s.info.projectId === projectId && s.lastTurn && !s.lastTurn.dismissed) {
      s.lastTurn.dismissed = true
      changed = true
    }
  }
  if (changed) notify()
}

export function dismissTurn(id: string): void {
  const s = sessions.get(id)
  if (s?.lastTurn) {
    s.lastTurn.dismissed = true
    notify()
  }
}

const checkpointListeners = new Set<(projectId: string) => void>()
function emitCheckpoints(projectId: string): void {
  for (const l of checkpointListeners) l(projectId)
}
export function onCheckpointsChanged(fn: (projectId: string) => void): () => void {
  checkpointListeners.add(fn)
  return () => checkpointListeners.delete(fn)
}

// ---------- sending text to Claude ----------

export function isClaudeTerminal(id: string | null): boolean {
  const s = id ? sessions.get(id) : null
  return !!s && isClaude(s.info) && !s.info.exited
}

/** The Claude Code terminal to talk to: the given one if it's Claude, else the newest running one. */
export function claudeTerminalFor(projectId: string, preferred: string | null): string | null {
  if (isClaudeTerminal(preferred)) return preferred
  const list = [...sessions.values()].filter((x) => x.info.projectId === projectId && isClaude(x.info) && !x.info.exited)
  return list.length ? list[list.length - 1].info.id : null
}

/** Type a prompt into a running Claude Code session and send it. */
export function sendToTerminal(id: string, text: string, submit = true): void {
  const s = sessions.get(id)
  if (!s) return
  s.term.paste(text)
  if (submit) setTimeout(() => s.term.input('\r'), 150)
  s.term.focus()
}

/** Insert text (e.g. dropped file paths) without sending. */
export function insertIntoTerminal(id: string, text: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.term.paste(text)
  s.term.focus()
}

// ---------- find ----------

const FIND_COLORS = {
  matchOverviewRuler: '#f0b429',
  activeMatchColorOverviewRuler: '#f2555a',
  matchBackground: '#f0b42966',
  activeMatchBackground: '#f2555a99'
}

export function findInTerminal(id: string, query: string, backwards = false): boolean {
  const s = sessions.get(id)
  if (!s || !query) return false
  const opts = { caseSensitive: false, decorations: FIND_COLORS }
  return backwards ? s.search.findPrevious(query, opts) : s.search.findNext(query, opts)
}

export function clearFind(id: string): void {
  const s = sessions.get(id)
  s?.search.clearDecorations()
  s?.term.clearSelection()
}

// ---------- rename ----------

export function renameTerminal(id: string, title: string): void {
  const s = sessions.get(id)
  if (!s || !title.trim()) return
  s.userRenamed = true
  s.info = { ...s.info, title: title.trim().slice(0, 60) }
  void api.termRename(id, s.info.title)
  notify()
}

export function focusSession(id: string): void {
  sessions.get(id)?.term.focus()
}

// ---------- which Claude conversation each terminal is in ----------

/**
 * After each Claude turn, find the conversation this terminal is writing to
 * (Claude Code saves each one as a file in the project's session folder), so
 * Vibeloft can name the tab after it and reopen it after a restart. Re-checked
 * every turn, because /clear in Claude starts a new conversation.
 */
async function detectSession(s: Session): Promise<void> {
  if (!isClaude(s.info)) return
  const claimed = [...sessions.values()]
    .filter((x) => x !== s && x.info.projectId === s.info.projectId && x.info.sessionId)
    .map((x) => x.info.sessionId!)
  const found = await api.claudeActiveSession(s.info.projectId, s.startedAt, claimed).catch(() => null)
  const sessionId = found ?? s.info.sessionId
  if (sessionId) await nameFromSession(s, sessionId)
}

async function nameFromSession(s: Session, sessionId: string): Promise<void> {
  // Tabs keep a general name ("Claude Code"); the conversation's own name is
  // shown when you hover the tab.
  const list = await api.claudeSessions(s.info.projectId).catch(() => [])
  const hit = list.find((x) => x.id === sessionId)
  const conversation = (hit?.title || hit?.firstPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined
  if (sessionId === s.info.sessionId && conversation === s.info.conversation) return
  const sameSession = sessionId === s.info.sessionId
  s.info = { ...s.info, sessionId, conversation }
  if (!sameSession) void api.termSetSession(s.info.id, sessionId, s.info.title)
  notify()
}

/** Conversations currently open in this project's terminals. */
export function openSessionIds(projectId: string): Set<string> {
  return new Set([...sessions.values()].filter((s) => s.info.projectId === projectId && !s.info.exited && s.info.sessionId).map((s) => s.info.sessionId!))
}

// ---------- Claude Code hooks: exact "prompt sent", "needs you" and "finished" ----------

const NEEDS_YOU = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'agent_needs_input'])

api.onTermHook((e) => {
  const s = sessions.get(e.terminalId)
  if (!s) return
  s.hooked = true
  if (s.idleTimer) clearTimeout(s.idleTimer)
  if (s.turn?.timer) clearTimeout(s.turn.timer)
  switch (e.event) {
    case 'SessionStart':
      if (e.sessionId) void nameFromSession(s, e.sessionId)
      break
    case 'UserPromptSubmit':
      // The checkpoint was saved before Claude started (see main/hooks.ts).
      markDone('promptSent')
      s.typed = ''
      s.turn = { checkpoint: e.checkpoint ?? null, prompt: e.prompt ?? '', sawOutput: true, timer: null }
      setWorking(s, true)
      clearTransient(s.info.id)
      clearWaiting(s)
      emitCheckpoints(s.info.projectId)
      break
    case 'PreToolUse':
      // Claude carried on by itself (no prompt from you) and is about to change
      // files; the undo checkpoint was saved first (see main/hooks.ts).
      s.turn = { checkpoint: e.checkpoint ?? null, prompt: 'Claude carried on by itself', sawOutput: true, timer: null }
      setWorking(s, true)
      emitCheckpoints(s.info.projectId)
      break
    case 'SessionEnd':
      if (e.reason === 'clear') break // /clear: a new conversation starts right away
      setWorking(s, false)
      if (s.turn) {
        s.turn.sawOutput = true
        void finishTurn(s)
      }
      s.info = { ...s.info, claudeEnded: true, sessionId: undefined, conversation: undefined }
      notify()
      break
    case 'Notification':
      noticeFromHook(s.info.id, e.notificationType, e.message)
      if (!e.notificationType || NEEDS_YOU.has(e.notificationType)) raiseWaiting(s)
      break
    case 'StopFailure':
      setWorking(s, false)
      noticeFromFailure(s.info.id, e.error, e.errorDetails)
      if (s.turn) {
        s.turn.sawOutput = true
        void finishTurn(s).then(() => raiseWaiting(s))
      } else raiseWaiting(s)
      break
    case 'Stop':
      setWorking(s, false)
      if (s.turn) {
        s.turn.sawOutput = true
        void finishTurn(s).then(() => raiseWaiting(s))
      } else raiseWaiting(s)
      if (e.sessionId) void nameFromSession(s, e.sessionId)
      break
  }
})

function setWorking(s: Session, on: boolean): void {
  if (s.working === on) return
  s.working = on
  notify()
}

/** Claude was interrupted (Esc): it doesn't report "finished" then, so wrap up the turn here. */
function interrupted(s: Session): void {
  setWorking(s, false)
  if (s.turn) {
    s.turn.sawOutput = true
    void finishTurn(s)
  }
}

/** Whether Claude Code is working on a prompt in this terminal. */
export function isWorking(id: string | null): boolean {
  return !!id && !!sessions.get(id)?.working
}

/** Stop Claude's current reply, like pressing Esc in Claude Code. The conversation stays. */
export function stopClaude(id: string): void {
  const s = sessions.get(id)
  if (!s || s.info.exited) return
  api.termWrite(id, '\x1b')
  interrupted(s)
  s.term.focus()
}

api.onTermStatus((e) => {
  if (!sessions.has(e.terminalId)) return
  const { terminalId, ...status } = e
  setClaudeStatus(terminalId, status)
})
