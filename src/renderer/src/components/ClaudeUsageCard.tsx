import { useEffect, useState, type ReactNode } from 'react'
import type { ClaudeUsage, UsageTotals } from '../../../shared/types'
import { api } from '../ui'

// How much Claude Code has been used in this project: cost and tokens for
// today / 7 days / 30 days / all time, a 30-day chart, and the models used.
// Read from Claude Code's own conversation files (see main/claudeUsage.ts).

type Period = 'today' | 'week' | 'month' | 'all'
const PERIODS: { id: Period; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 days' },
  { id: 'month', label: '30 days' },
  { id: 'all', label: 'All time' }
]

export const money = (usd: number): string => (usd >= 100 ? `$${usd.toFixed(0)}` : usd >= 0.995 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`)

export const tokens = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)

const modelName = (id: string): string =>
  id
    .replace(/^claude-/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-(\d+)$/, ' $1')
    .replace(/^\w/, (c) => c.toUpperCase())

const dayLabel = (iso: string): string => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/** Every day of the last 30, including days with no use (so the chart's spacing means time). */
function last30(days: ClaudeUsage['days']): ClaudeUsage['days'] {
  const by = new Map(days.map((d) => [d.date, d]))
  const out: ClaudeUsage['days'] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push(by.get(key) ?? { date: key, costUsd: 0, tokens: 0, replies: 0 })
  }
  return out
}

function Chart(props: { days: ClaudeUsage['days'] }): ReactNode {
  const days = last30(props.days)
  const max = Math.max(...days.map((d) => d.costUsd), 0)
  const [hover, setHover] = useState<number | null>(null)
  const h = hover !== null ? days[hover] : null
  return (
    <div className="usage-chart" onMouseLeave={() => setHover(null)}>
      <div className="usage-bars" role="img" aria-label="Cost per day, last 30 days">
        {days.map((d, i) => (
          // The whole column is the hover target, not just the bar.
          <div key={d.date} className={`usage-col ${hover === i ? 'on' : ''}`} onMouseEnter={() => setHover(i)}>
            {d.costUsd > 0 && <div className="usage-bar" style={{ height: `${Math.max(4, (d.costUsd / (max || 1)) * 100)}%` }} />}
          </div>
        ))}
      </div>
      <div className="usage-axis muted small">
        <span>30 days ago</span>
        <span>{h ? `${dayLabel(h.date)}: ${money(h.costUsd)} · ${tokens(h.tokens)} tokens · ${h.replies} replies` : `Busiest day ${money(max)}`}</span>
        <span>Today</span>
      </div>
    </div>
  )
}

function Totals(props: { t: UsageTotals }): ReactNode {
  const { t } = props
  const input = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens
  return (
    <div className="usage-totals">
      <div className="usage-hero">
        <span className="usage-cost">{money(t.costUsd)}</span>
        <span className="muted small">
          {t.conversations} conversation{t.conversations === 1 ? '' : 's'} · {t.replies} repl{t.replies === 1 ? 'y' : 'ies'}
        </span>
      </div>
      <dl className="usage-tokens">
        <dt>Tokens read</dt>
        <dd title={`${input.toLocaleString()} tokens: ${t.cacheReadTokens.toLocaleString()} from cache, ${t.cacheWriteTokens.toLocaleString()} written to cache, ${t.inputTokens.toLocaleString()} new`}>
          {tokens(input)}
          {input > 0 && <span className="muted small"> ({Math.round((t.cacheReadTokens / input) * 100)}% from cache)</span>}
        </dd>
        <dt>Tokens written</dt>
        <dd>{tokens(t.outputTokens)}</dd>
      </dl>
    </div>
  )
}

export function ClaudeUsageCard({ projectId }: { projectId: string }): ReactNode {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('month')

  useEffect(() => {
    setUsage(null)
    const load = (): void => void api.claudeUsage(projectId).then(setUsage, (e) => setError((e as Error).message))
    load()
    // Keep it current while Claude works (files only re-read when they change).
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [projectId])

  const t = usage?.[period]
  return (
    <section className="card usage-card">
      <div className="card-head">
        <h3>Claude usage</h3>
        <div className="segmented" role="tablist">
          {PERIODS.map((p) => (
            <button key={p.id} role="tab" aria-selected={period === p.id} className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <p className="muted small">{error}</p>
      ) : !usage || !t ? (
        <p className="muted small">Adding up…</p>
      ) : usage.all.replies === 0 ? (
        <p className="muted small">No Claude Code use in this project folder yet.</p>
      ) : (
        <>
          <Totals t={t} />
          <Chart days={usage.days} />
          {usage.byModel.length > 0 && (
            <p className="muted small usage-models">
              All time by model:{' '}
              {usage.byModel
                .filter((m) => m.costUsd >= 0.005)
                .map((m) => `${modelName(m.model)} ${money(m.costUsd)}`)
                .join(' · ')}
              {usage.editorShareUsd >= 0.01 && ` · ${money(usage.editorShareUsd)} of it from VS Code`}
            </p>
          )}
          <p className="muted small usage-note">
            Cost at Anthropic’s API prices. On a Claude plan (Pro, Max, Team) you don’t pay per token: it shows how much was used.
          </p>
        </>
      )}
    </section>
  )
}
