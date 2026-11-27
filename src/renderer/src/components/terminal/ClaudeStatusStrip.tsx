import { useEffect, useState, type ReactNode } from 'react'
import { activeNotices, dismissNotice, useClaudeNotices, type ClaudeNotice } from '../../claudeNotices'
import { Icon } from '../../icons'
import { money } from '../ClaudeUsageCard'
import { sendToTerminal } from '../../termStore'

// Keeps Claude Code's important messages (usage limits, sign-in, credits,
// server trouble, full context) on screen above the terminal, so they don't
// scroll away. ClaudeMeters shows context use and usage limits in the footer,
// when Claude Code reports them.

/** "in 2h 10m" / "in 4m" / "in 3d 2h". */
function until(ms: number, now: number): string {
  const m = Math.max(0, Math.round((ms - now) / 60_000))
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  return `in ${Math.floor(h / 24)}d ${h % 24}h`
}

const clock = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

const level = (pct: number): string => (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok')

function Meter(props: { label: string; pct: number; title: string }): ReactNode {
  return (
    <span className={`cs-meter ${level(props.pct)}`} title={props.title}>
      <span className="cs-meter-label">{props.label}</span>
      <span className="cs-meter-bar">
        <span style={{ width: `${props.pct}%` }} />
      </span>
      <span className="cs-meter-pct">{props.pct}%</span>
    </span>
  )
}

function NoticeRow(props: { terminalId: string; n: ClaudeNotice; now: number }): ReactNode {
  const { n, now, terminalId } = props
  const reset = n.resetsAt ? `Resets ${until(n.resetsAt, now)} (${clock(n.resetsAt)})` : n.resetText ? `Resets ${n.resetText}` : ''
  return (
    <div className={`cs-notice ${n.kind}`} role="status">
      <Icon name={n.kind === 'limit' ? 'timer' : n.kind === 'context' ? 'gauge' : n.kind === 'info' ? 'check' : 'alert'} size={15} />
      <span className="cs-text">
        {n.text}
        {reset && !n.text.toLowerCase().includes('resets') && <span className="cs-reset"> · {reset}</span>}
        {reset && n.text.toLowerCase().includes('resets') && n.resetsAt && <span className="cs-reset"> ({until(n.resetsAt, now)})</span>}
      </span>
      {n.kind === 'auth' && (
        <button className="btn small-btn" onClick={() => sendToTerminal(terminalId, '/login')} title="Run /login in this terminal">
          Sign in
        </button>
      )}
      {n.kind === 'context' && (
        <button className="btn small-btn" onClick={() => sendToTerminal(terminalId, '/compact')} title="Run /compact in this terminal">
          Compact
        </button>
      )}
      {n.kind === 'limit' && (
        <button className="btn small-btn" onClick={() => sendToTerminal(terminalId, '/usage')} title="Show your usage (/usage)">
          Usage
        </button>
      )}
      <button className="icon-btn" title="Dismiss" onClick={() => dismissNotice(terminalId, n.id)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}

export function ClaudeStatusStrip(props: { terminalId: string | null }): ReactNode {
  const { notices } = useClaudeNotices(props.terminalId)
  const now = useNow(30_000)
  if (!props.terminalId) return null
  const shown = activeNotices(notices, now).slice(0, 3)
  if (!shown.length) return null
  return (
    <div className="claude-status">
      {shown.map((n) => (
        <NoticeRow key={n.id} terminalId={props.terminalId!} n={n} now={now} />
      ))}
    </div>
  )
}

/** Model, context and usage-limit meters; shown in the footer under the terminal. */
export function ClaudeMeters(props: { terminalId: string | null }): ReactNode {
  const { status } = useClaudeNotices(props.terminalId)
  const now = useNow(30_000)
  if (!props.terminalId) return null
  const limits = (status.limits ?? []).filter((l) => !(l.resetsAt && l.resetsAt < now))
  if (status.contextPct === undefined && !limits.length) return null
  return (
    <div className="cs-meters">
      {status.model && <span className="cs-model">{status.model}</span>}
      {status.costUsd !== undefined && status.costUsd > 0 && (
        <span className="cs-cost" title="This conversation so far, at Anthropic's API prices (as Claude Code's /cost reports it). The project's totals are on Overview → Claude usage.">
          {money(status.costUsd)}
        </span>
      )}
      {status.contextPct !== undefined && (
        <Meter
          label="Context"
          pct={status.contextPct}
          title={`This conversation uses ${status.contextPct}% of Claude's context window. Near full, Claude Code compacts it (or run /compact).`}
        />
      )}
      {limits.map((l) => (
        <Meter
          key={l.label}
          label={l.label}
          pct={l.usedPct}
          title={`${l.label} usage limit: ${l.usedPct}% used${l.resetsAt ? `. Resets ${until(l.resetsAt, now)} (${clock(l.resetsAt)})` : ''}.`}
        />
      ))}
    </div>
  )
}
