import { useSyncExternalStore } from 'react'

// Important things Claude Code tells you (usage limits, sign-in problems,
// server errors, context nearly full), collected per terminal so the Terminal
// tab can keep showing them in one place instead of letting them scroll away.
//
// Sources: Claude Code's own output (recognised phrases), its hook
// notifications, and its status-line data when available.

export type NoticeKind = 'limit' | 'auth' | 'billing' | 'error' | 'context' | 'info'

export interface ClaudeNotice {
  id: string
  kind: NoticeKind
  text: string
  /** When a usage limit resets (ms since epoch), if Claude Code said. */
  resetsAt?: number
  /** Raw reset wording, e.g. "5pm (Asia/Calcutta)", when it couldn't be turned into a time. */
  resetText?: string
  at: number
  dismissed: boolean
}

export interface ClaudeStatus {
  model?: string
  /** Share of the context window in use, 0-100. */
  contextPct?: number
  /** Usage-limit windows, e.g. 5-hour and weekly, as reported by Claude Code. */
  limits?: { label: string; usedPct: number; resetsAt?: number }[]
  costUsd?: number
}

interface Entry {
  notices: ClaudeNotice[]
  status: ClaudeStatus
}

const byTerminal = new Map<string, Entry>()
const listeners = new Set<() => void>()
let version = 0
const bump = (): void => {
  version++
  for (const l of listeners) l()
}
const entry = (id: string): Entry => {
  let e = byTerminal.get(id)
  if (!e) {
    e = { notices: [], status: {} }
    byTerminal.set(id, e)
  }
  return e
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g

/** Recognised phrases in Claude Code's output. First match per chunk wins. */
const APOS = `(?:'|’)`
const PATTERNS: { kind: NoticeKind; re: RegExp; text: (m: RegExpMatchArray) => string }[] = [
  // "You've hit your session limit · resets 3:45pm", "… weekly limit · resets Mon 12:00am", "… Opus limit …"
  { kind: 'limit', re: new RegExp(`you${APOS}ve (?:hit|reached) your [\\w-]+ ?(?:spend )?limit[^\\n]*`, 'i'), text: (m) => tidy(m[0]) },
  { kind: 'limit', re: /(?:usage limit reached|(?:individual|monthly) spend limit)[^\n]*/i, text: (m) => tidy(m[0]) },
  // "You've used 85% of your session limit · resets 3:45pm"
  { kind: 'limit', re: new RegExp(`you${APOS}ve used \\d{1,3}% of your [\\w-]+ limit[^\\n]*`, 'i'), text: (m) => tidy(m[0]) },
  {
    kind: 'billing',
    re: /(?:credit balance is too low|usage credits ran out)[^\n]*/i,
    text: () => 'Out of credits. Add credits to your account to keep going.'
  },
  {
    kind: 'auth',
    re: /(?:please run \/login|login expired|not logged in|authentication required|oauth token (?:has )?expired|invalid authentication credentials|invalid api key)/i,
    text: () => 'Claude Code needs you to sign in again.'
  },
  {
    kind: 'context',
    re: /(?:context limit reached|prompt is too long)/i,
    text: () => 'The conversation is full. Compact it or start a new one to continue.'
  },
  {
    kind: 'error',
    re: /(?:repeated 529 overloaded|overloaded_error|is experiencing high load)/i,
    text: () => 'Claude’s servers are busy. Claude Code retries by itself.'
  },
  {
    kind: 'error',
    re: /(?:server is temporarily limiting requests|request rejected \(429\)|rate_limit_error)/i,
    text: () => 'Requests are being limited for now. Claude Code retries by itself.'
  }
]

const tidy = (s: string): string => s.replace(/\s+/g, ' ').replace(/[\s·.]+$/, '').trim()

const CONTEXT_RE = /context (?:left )?until auto-compact:?\s*(\d{1,3})%/i
const RESET_RE = /resets?\s+(?:at\s+)?((?:(?:mon|tue|wed|thu|fri|sat|sun)\w*\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s*\(([^)]+)\))?/i
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Turn "5pm" / "17:30" / "Mon 12:00am" into the next such time (local time). */
function parseReset(text: string): number | undefined {
  const m = text.match(/^(?:([a-z]{3})\w*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) return undefined
  let h = Number(m[2])
  const min = Number(m[3] ?? 0)
  const ap = m[4]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return undefined
  const d = new Date()
  d.setHours(h, min, 0, 0)
  const day = m[1] ? DAYS.indexOf(m[1].toLowerCase()) : -1
  if (day >= 0) {
    d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7))
    if (d.getTime() < Date.now() - 60_000) d.setDate(d.getDate() + 7)
  } else if (d.getTime() < Date.now() - 60_000) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * Which notices are "the same thing": one per kind, and for usage limits one
 * per limit (session, weekly, Opus, spend). A newer message replaces the older
 * one instead of adding another bar.
 */
function keyOf(n: { kind: NoticeKind; text: string }): string {
  if (n.kind !== 'limit') return n.kind
  const w = n.text.toLowerCase().match(/\b(session|5-hour|weekly|opus|sonnet|spend|monthly)\b/)?.[1]
  return `limit:${w === '5-hour' ? 'session' : w === 'monthly' ? 'spend' : (w ?? 'usage')}`
}

function add(terminalId: string, n: Omit<ClaudeNotice, 'id' | 'at' | 'dismissed'>): void {
  const e = entry(terminalId)
  const key = keyOf(n)
  // A limit with no name ("You've hit a usage limit") is the same as the named one already shown.
  const twin = e.notices.find((x) => keyOf(x) === key || (key === 'limit:usage' && x.kind === 'limit' && !x.dismissed))
  // Less information than what's shown (cut off mid-line on screen, or an unnamed
  // limit): keep the fuller one, just remember a reset time if this one has it.
  const lessInfo = !!twin && !twin.dismissed && (twin.text.startsWith(n.text.replace(/[\s·.…]+$/, '')) || (key === 'limit:usage' && keyOf(twin) !== key))
  if (twin && lessInfo) {
    if (!twin.resetsAt && n.resetsAt) {
      twin.resetsAt = n.resetsAt
      twin.resetText = n.resetText
      bump()
    }
    return
  }
  if (twin && twin.text !== n.text) {
    // Newer wording for the same thing: replace it, keeping a known reset time.
    const resetsAt = n.resetsAt ?? twin.resetsAt
    const resetText = n.resetText ?? twin.resetText
    const age = Date.now() - twin.at
    // You dismissed it: stay quiet unless it's been a while (or it got worse: hit after "used 85%").
    const worse = n.kind === 'limit' && /hit|reached/i.test(n.text) && !/hit|reached/i.test(twin.text)
    if (twin.dismissed && age < 10 * 60_000 && !worse) return
    // "You've hit…" isn't replaced by an older-style "you've used 85%…" redraw.
    if (!twin.dismissed && n.kind === 'limit' && /used \d/i.test(n.text) && /hit|reached/i.test(twin.text)) return
    Object.assign(twin, n, { resetsAt, resetText, at: Date.now(), dismissed: false })
    e.notices = [twin, ...e.notices.filter((x) => x !== twin)]
    bump()
    return
  }
  // The same notice again (Claude Code redraws its screen often): just refresh it.
  const same = twin
  if (same) {
    // Dismissed: stay quiet while the same text is merely redrawn on screen.
    const age = Date.now() - same.at
    if (same.dismissed ? age > 10 * 60_000 : age > 60_000) {
      same.at = Date.now()
      if (n.kind !== 'info') same.dismissed = false
      Object.assign(same, n)
      bump()
    }
    return
  }
  e.notices.unshift({ ...n, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), dismissed: false })
  e.notices = e.notices.slice(0, 20)
  bump()
}

/** Look at a chunk of Claude Code output for important notices. */
export function scanClaudeOutput(terminalId: string, chunk: string): void {
  if (chunk.length < 6) return
  const text = chunk.replace(ANSI, ' ').replace(/[│╭╮╰╯─]/g, ' ')
  const ctx = text.match(CONTEXT_RE)
  if (ctx) {
    const left = Number(ctx[1])
    const e = entry(terminalId)
    const used = 100 - left
    if (e.status.contextPct !== used) {
      e.status.contextPct = used
      bump()
    }
  }
  for (const p of PATTERNS) {
    const m = text.match(p.re)
    if (!m || m.index === undefined) continue
    // Only Claude Code's own messages: the phrase must start its line (after
    // UI marks or "API Error:"), not sit inside code or a diff being shown.
    const lineStart = text.lastIndexOf('\n', m.index) + 1
    const before = text.slice(lineStart, m.index)
    if (!/^[\s⎿●✗✘⚠·*>\-]*(?:api error:?\s*(?:\d{3}\s*)?)?$/i.test(before)) continue
    const r = m[0].match(RESET_RE)
    add(terminalId, {
      kind: p.kind,
      text: p.text(m).replace(/\s+/g, ' ').slice(0, 200),
      resetsAt: r ? parseReset(r[1].trim()) : undefined,
      resetText: r ? `${r[1].trim()}${r[2] ? ` (${r[2]})` : ''}` : undefined
    })
    break
  }
}

/** A hook notification worth keeping on screen (sign-in, quota). */
export function noticeFromHook(terminalId: string, type: string | undefined, message: string | undefined): void {
  if (!type || !message) return
  if (/^auth_/.test(type)) add(terminalId, { kind: type === 'auth_success' ? 'info' : 'auth', text: message })
  else if (/^quota_/.test(type)) add(terminalId, { kind: 'limit', text: message })
}

/** A turn that ended on an API error (Claude Code's StopFailure hook). */
export function noticeFromFailure(terminalId: string, error: string | undefined, details: string | undefined): void {
  const said = details ? tidy(details).slice(0, 200) : ''
  const r = said.match(RESET_RE)
  const reset = { resetsAt: r ? parseReset(r[1].trim()) : undefined, resetText: r ? r[1].trim() : undefined }
  switch (error) {
    case 'rate_limit':
      return add(terminalId, { kind: 'limit', text: said || 'You’ve hit a usage limit.', ...reset })
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return add(terminalId, { kind: 'auth', text: 'Claude Code needs you to sign in again.' })
    case 'account_on_hold':
      return add(terminalId, { kind: 'auth', text: said || 'Your Claude account is on hold.' })
    case 'billing_error':
      return add(terminalId, { kind: 'billing', text: said || 'Out of credits. Add credits to your account to keep going.' })
    case 'max_output_tokens':
      return add(terminalId, { kind: 'error', text: 'Claude’s reply was cut off (too long). Ask it to continue.' })
    case 'server_error':
      return add(terminalId, { kind: 'error', text: said || 'Claude’s servers had an error. Try again.' })
    case undefined:
      return
    default:
      return add(terminalId, { kind: 'error', text: said || `Claude Code stopped with an error (${error}).` })
  }
}

/** Notices still worth showing: not dismissed, and limits whose reset time hasn't passed. */
export function activeNotices(notices: ClaudeNotice[], now = Date.now()): ClaudeNotice[] {
  return notices.filter((n) => !n.dismissed && !(n.resetsAt && n.resetsAt < now) && !(n.kind === 'info' && now - n.at > 15_000))
}

/** The user sent a new prompt: errors from the last turn are no longer news. */
export function clearTransient(terminalId: string): void {
  const e = byTerminal.get(terminalId)
  if (!e) return
  let changed = false
  for (const n of e.notices)
    if (!n.dismissed && (n.kind === 'error' || n.kind === 'context' || n.kind === 'info')) {
      n.dismissed = true
      changed = true
    }
  if (changed) bump()
}

/** Status-line data from Claude Code (model, context, limits, cost). */
export function setClaudeStatus(terminalId: string, status: ClaudeStatus): void {
  const e = entry(terminalId)
  e.status = { ...e.status, ...status }
  bump()
}

export function dismissNotice(terminalId: string, id: string): void {
  const n = byTerminal.get(terminalId)?.notices.find((x) => x.id === id)
  if (n) {
    n.dismissed = true
    bump()
  }
}

export function clearNotices(terminalId: string): void {
  byTerminal.delete(terminalId)
  bump()
}

export function useClaudeNotices(terminalId: string | null): Entry {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
  return (terminalId && byTerminal.get(terminalId)) || { notices: [], status: {} }
}
