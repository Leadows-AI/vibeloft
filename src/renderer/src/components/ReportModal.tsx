import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { Database, GitCommit, Milestone, Project, WorkItem } from '../../../shared/types'
import type { AppCtx } from '../App'
import { entryMs, fmtHours } from '../time'
import { api, daysUntil, Modal } from '../ui'
import { reportFont } from '../fonts'

// A status report for the customer: what got done, what's in progress, open
// bugs, upcoming deliveries, optional commits and time. Saved as PDF, copied
// as text, or sent by email. Only project data goes into it, never code.

interface Options {
  days: number
  completed: boolean
  inProgress: boolean
  bugs: boolean
  milestones: boolean
  commits: boolean
  time: boolean
  cost: boolean
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const fmtDay = (iso: string): string => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const prioRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

interface Section {
  project: Project
  completed: WorkItem[]
  inProgress: WorkItem[]
  bugs: WorkItem[]
  milestones: Milestone[]
  commits: GitCommit[]
  timeMs: number
  progress: number
}

function gather(db: Database, project: Project, since: Date, commits: GitCommit[]): Section {
  const items = db.workItems.filter((w) => w.projectId === project.id)
  const done = items.filter((w) => w.status === 'done')
  return {
    project,
    completed: done.filter((w) => new Date(w.doneAt ?? w.updatedAt) >= since),
    inProgress: items.filter((w) => w.status === 'in_progress' || w.status === 'review'),
    bugs: items.filter((w) => w.kind === 'bug' && w.status !== 'done').sort((a, b) => prioRank[a.priority] - prioRank[b.priority]),
    milestones: db.milestones.filter((m) => m.projectId === project.id && m.status !== 'delivered').sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    commits,
    timeMs: db.timeEntries.filter((t) => t.projectId === project.id && new Date(t.start) >= since).reduce((n, t) => n + entryMs(t), 0),
    progress: items.length ? Math.round((done.length / items.length) * 100) : 0
  }
}

function dueText(m: Milestone): string {
  const d = daysUntil(m.dueDate)
  return d < 0 ? `${-d} days overdue` : d === 0 ? 'due today' : `in ${d} days`
}

function buildHtml(title: string, customer: string, since: Date, sections: Section[], o: Options, summary: string, rate: number | null, currency: string, font: { css: string; family: string }): string {
  const money = (ms: number): string =>
    rate ? (ms / 3_600_000 * rate).toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }) : ''
  const list = (items: WorkItem[], empty: string): string =>
    items.length
      ? `<ul>${items.map((w) => `<li><span class="tag ${w.kind}">${w.kind === 'bug' ? 'Fix' : 'Feature'}</span>${esc(w.title)}</li>`).join('')}</ul>`
      : `<p class="none">${empty}</p>`
  const body = sections
    .map((s) => {
      const parts: string[] = []
      if (sections.length > 1) parts.push(`<h2>${esc(s.project.name)}</h2>`)
      parts.push(`<div class="stats"><div><b>${s.completed.length}</b><span>completed</span></div><div><b>${s.inProgress.length}</b><span>in progress</span></div><div><b>${s.bugs.length}</b><span>open bugs</span></div><div><b>${s.progress}%</b><span>overall done</span></div>${o.time ? `<div><b>${fmtHours(s.timeMs)}</b><span>time spent${o.cost && rate ? ` · ${money(s.timeMs)}` : ''}</span></div>` : ''}</div>`)
      if (o.completed) parts.push(`<h3>Completed</h3>${list(s.completed, 'Nothing was completed in this period.')}`)
      if (o.inProgress) parts.push(`<h3>In progress</h3>${list(s.inProgress, 'Nothing is in progress right now.')}`)
      if (o.bugs) parts.push(`<h3>Open bugs</h3>${s.bugs.length ? `<ul>${s.bugs.map((b) => `<li><span class="prio ${b.priority}">${b.priority}</span>${esc(b.title)}</li>`).join('')}</ul>` : '<p class="none">No open bugs.</p>'}`)
      if (o.milestones) parts.push(`<h3>Upcoming deliveries</h3>${s.milestones.length ? `<table>${s.milestones.map((m) => `<tr><td>${esc(m.title)}</td><td>${fmtDay(m.dueDate)}</td><td class="${daysUntil(m.dueDate) < 0 ? 'late' : ''}">${dueText(m)}</td></tr>`).join('')}</table>` : '<p class="none">No upcoming deliveries scheduled.</p>'}`)
      if (o.commits && s.commits.length) parts.push(`<h3>Recent changes</h3><ul class="commits">${s.commits.slice(0, 15).map((c) => `<li>${esc(c.subject)} <span>${fmtDay(c.date)}</span></li>`).join('')}</ul>`)
      return `<section>${parts.join('')}</section>`
    })
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${font.css}
  *{box-sizing:border-box} body{font:14px/1.55 ${font.family};color:#1c2622;margin:0;padding:36px 44px;background:#fff}
  header{border-top:4px solid #244b3f;padding-top:18px;margin-bottom:22px}
  .eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#244b3f;font-weight:700}
  h1{font-size:26px;margin:6px 0 4px;letter-spacing:-.02em} .meta{color:#5f6b66}
  .summary{background:#f4f6f5;border-left:3px solid #244b3f;padding:14px 16px;margin:0 0 22px;border-radius:4px}
  h2{font-size:19px;margin:26px 0 8px;padding-bottom:6px;border-bottom:1px solid #dce3df}
  h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#244b3f;margin:20px 0 6px}
  .stats{display:flex;gap:10px;margin:10px 0 4px;flex-wrap:wrap} .stats div{border:1px solid #dce3df;border-radius:6px;padding:8px 14px;min-width:110px}
  .stats b{display:block;font-size:22px;color:#244b3f} .stats span{font-size:12px;color:#5f6b66}
  ul{margin:4px 0;padding-left:0;list-style:none} li{padding:5px 0;border-bottom:1px solid #eef2f0}
  .tag,.prio{display:inline-block;font-size:10.5px;font-weight:700;text-transform:uppercase;padding:1px 6px;border-radius:4px;margin-right:8px;background:#e9f1ed;color:#244b3f}
  .tag.bug{background:#fbe9e9;color:#a52323} .prio.critical,.prio.high{background:#fbe9e9;color:#a52323} .prio.low{background:#f0f2f1;color:#5f6b66}
  table{border-collapse:collapse;width:100%} td{padding:6px 0;border-bottom:1px solid #eef2f0} td:nth-child(2),td:nth-child(3){color:#5f6b66;width:22%} td.late{color:#a52323;font-weight:600}
  .commits span{color:#8a958f;font-size:12px;margin-left:6px} .none{color:#8a958f;margin:4px 0}
  footer{margin-top:34px;padding-top:12px;border-top:1px solid #dce3df;color:#8a958f;font-size:12px}
  section{break-inside:avoid-page}
</style></head><body>
<header><div class="eyebrow">Project status report</div><h1>${esc(title)}</h1><div class="meta">${customer ? `For ${esc(customer)} · ` : ''}${fmtDay(since.toISOString())} – ${fmtDay(new Date().toISOString())}</div></header>
${summary.trim() ? `<div class="summary">${esc(summary.trim()).replace(/\n+/g, '<br>')}</div>` : ''}
${body}
<footer>Prepared with Vibeloft · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</footer>
</body></html>`
}

function buildText(title: string, customer: string, since: Date, sections: Section[], o: Options, summary: string): string {
  const out: string[] = [`${title} — status report`, `${customer ? `For ${customer}, ` : ''}${fmtDay(since.toISOString())} – ${fmtDay(new Date().toISOString())}`, '']
  if (summary.trim()) out.push(summary.trim(), '')
  for (const s of sections) {
    if (sections.length > 1) out.push(`== ${s.project.name} ==`)
    out.push(`Completed: ${s.completed.length} · In progress: ${s.inProgress.length} · Open bugs: ${s.bugs.length} · Overall: ${s.progress}% done${o.time ? ` · Time: ${fmtHours(s.timeMs)}` : ''}`)
    if (o.completed && s.completed.length) out.push('', 'Completed:', ...s.completed.map((w) => `  ✓ ${w.title}`))
    if (o.inProgress && s.inProgress.length) out.push('', 'In progress:', ...s.inProgress.map((w) => `  • ${w.title}`))
    if (o.bugs && s.bugs.length) out.push('', 'Open bugs:', ...s.bugs.map((b) => `  • [${b.priority}] ${b.title}`))
    if (o.milestones && s.milestones.length) out.push('', 'Upcoming deliveries:', ...s.milestones.map((m) => `  • ${m.title} — ${fmtDay(m.dueDate)} (${dueText(m)})`))
    out.push('')
  }
  return out.join('\n')
}

/** Facts for Claude's summary: counts and titles only. */
function buildFacts(sections: Section[], since: Date): string {
  return sections
    .map((s) =>
      [
        `Project: ${s.project.name} (${s.progress}% of all tracked items done). Period starts ${fmtDay(since.toISOString())}.`,
        `Completed in period: ${s.completed.map((w) => w.title).join('; ') || 'none'}`,
        `In progress: ${s.inProgress.map((w) => w.title).join('; ') || 'none'}`,
        `Open bugs: ${s.bugs.map((b) => `${b.title} (${b.priority})`).join('; ') || 'none'}`,
        `Upcoming deliveries: ${s.milestones.map((m) => `${m.title} on ${m.dueDate} (${dueText(m)})`).join('; ') || 'none'}`
      ].join('\n')
    )
    .join('\n\n')
}

export function ReportModal(props: { ctx: AppCtx; projectIds: string[]; title: string; onClose: () => void }): ReactNode {
  const { db } = props.ctx
  const projects = props.projectIds.map((id) => db.projects.find((p) => p.id === id)!).filter(Boolean)
  const customer = db.customers.find((c) => c.id === projects[0]?.customerId)
  const rate = db.settings.hourlyRate ?? null
  const currency = db.settings.currency || 'USD'
  const [o, setO] = useState<Options>({ days: 14, completed: true, inProgress: true, bugs: true, milestones: true, commits: false, time: false, cost: false })
  const [summary, setSummary] = useState('')
  const [commits, setCommits] = useState<Record<string, GitCommit[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  // The interface font, embedded so the PDF looks the same on any computer.
  const [font, setFont] = useState({ css: '', family: 'Arial, sans-serif' })
  useEffect(() => {
    reportFont().then(setFont)
  }, [])

  const since = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - o.days)
    return d
  }, [o.days])

  useEffect(() => {
    if (!o.commits) return
    for (const p of projects) {
      if (!p.localPath) continue
      api.gitLogSince(p.id, since.toISOString()).then((c) => setCommits((m) => ({ ...m, [p.id]: c })), () => {})
    }
  }, [o.commits, since])

  const sections = projects.map((p) => gather(db, p, since, commits[p.id] ?? []))
  const html = buildHtml(props.title, customer?.name ?? '', since, sections, o, summary, rate, currency, font)
  const text = buildText(props.title, customer?.name ?? '', since, sections, o, summary)
  const email = customer?.contact?.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? ''
  const set = (k: keyof Options, v: boolean | number): void => setO((x) => ({ ...x, [k]: v }))
  const errText = (e: unknown): string => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

  async function writeSummary(): Promise<void> {
    setBusy('summary')
    setNote(null)
    try {
      setSummary(await api.reportSummary(buildFacts(sections, since)))
    } catch (e) {
      setNote({ tone: 'bad', text: errText(e) })
    } finally {
      setBusy(null)
    }
  }

  async function savePdf(): Promise<void> {
    setBusy('pdf')
    try {
      const path = await api.reportPdf(html, `${props.title} - status report ${new Date().toISOString().slice(0, 10)}`)
      if (path) setNote({ tone: 'ok', text: `Saved to ${path}` })
    } catch (e) {
      setNote({ tone: 'bad', text: errText(e) })
    } finally {
      setBusy(null)
    }
  }

  function openEmail(): void {
    navigator.clipboard.writeText(text)
    const subject = `${props.title} — status update`
    // Email links can't carry long bodies, so the full report goes on the clipboard.
    const body = text.length > 1500 ? `${text.slice(0, 1500)}\n…\n\n(Full report attached / pasted below.)` : text
    api.openUrl(`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`)
    setNote({ tone: 'ok', text: 'Opened your email app. The full report text is also on the clipboard.' })
  }

  return (
    <Modal
      title={`Status report — ${props.title}`}
      onClose={props.onClose}
      wide
      footer={
        <>
          {note && <span className={`small ${note.tone === 'ok' ? 'ok-text' : 'bad-text'} grow`}>{note.text}</span>}
          {!note && <div className="grow" />}
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard.writeText(text)
              setNote({ tone: 'ok', text: 'Report copied as text.' })
            }}
          >
            Copy as text
          </button>
          <button className="btn" onClick={openEmail} title={email ? `Email ${email}` : 'Add an email address to the customer to fill this in'}>
            Email{email ? ` ${customer?.name ?? ''}` : '…'}
          </button>
          <button className="btn primary" onClick={savePdf} disabled={busy === 'pdf'}>
            {busy === 'pdf' ? 'Saving…' : 'Save PDF'}
          </button>
        </>
      }
    >
      <div className="report-layout">
        <div className="report-options">
          <label className="field">
            <span className="field-label">Period</span>
            <select className="input" value={o.days} onChange={(e) => set('days', Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
          <div className="field">
            <span className="field-label">Include</span>
            {(
              [
                ['completed', 'Completed work'],
                ['inProgress', 'In progress'],
                ['bugs', 'Open bugs'],
                ['milestones', 'Upcoming deliveries'],
                ['commits', 'Recent commits'],
                ['time', 'Time spent']
              ] as [keyof Options, string][]
            ).map(([k, label]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={!!o[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
              </label>
            ))}
            {o.time && (
              <label className="check" title={rate ? '' : 'Set an hourly rate in Settings'}>
                <input type="checkbox" checked={o.cost} disabled={!rate} onChange={(e) => set('cost', e.target.checked)} /> Show cost
                {!rate && <span className="muted small"> (set a rate in Settings)</span>}
              </label>
            )}
          </div>
          <div className="field">
            <span className="field-label">Summary for the customer</span>
            <textarea className="input" rows={7} placeholder="Optional opening paragraph…" value={summary} onChange={(e) => setSummary(e.target.value)} />
            <button className="btn small-btn" onClick={writeSummary} disabled={busy === 'summary'} title="Claude writes it from the report's facts (titles and dates only, no code)">
              {busy !== 'summary' && <Icon name="sparkle" size={14} />} {busy === 'summary' ? 'Writing…' : 'Write with Claude'}
            </button>
          </div>
        </div>
        <iframe className="report-preview" title="Report preview" sandbox="" srcDoc={html} />
      </div>
    </Modal>
  )
}
