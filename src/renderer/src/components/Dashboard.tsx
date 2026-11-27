import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppTools } from './AppTools'
import { Icon } from '../icons'
import type { ProjectKind, RepoInfo } from '../../../shared/types'
import type { AppCtx } from '../App'
import { api, customerName, dueLabel, Empty, fmtDate, KindBadge, projectStats, relTime } from '../ui'

export function Dashboard({ ctx }: { ctx: AppCtx }): ReactNode {
  const { db, go } = ctx
  const [kind, setKind] = useState<ProjectKind | 'all'>('all')
  const [showDelivered, setShowDelivered] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const archived = new Set(db.projects.filter((p) => p.archivedAt).map((p) => p.id))
  const [repoInfos, setRepoInfos] = useState<Record<string, RepoInfo>>({})

  useEffect(() => {
    for (const p of db.projects) {
      if (p.localPath) api.repoInfo(p.localPath).then((info) => setRepoInfos((r) => ({ ...r, [p.id]: info })))
    }
  }, [db.projects.length])

  const projects = db.projects.filter(
    (p) => (kind === 'all' || p.kind === kind) && (showDelivered || p.status !== 'delivered') && (showArchived || !p.archivedAt)
  )

  const totals = useMemo(() => {
    const active = db.projects.filter((p) => p.status === 'active' && !p.archivedAt)
    const open = db.workItems.filter((w) => w.status !== 'done' && !archived.has(w.projectId))
    const soon = db.milestones.filter((m) => m.status !== 'delivered' && !archived.has(m.projectId) && dueLabel(m.dueDate).tone !== 'ok')
    return {
      active: active.length,
      bugs: open.filter((w) => w.kind === 'bug').length,
      building: open.filter((w) => w.kind === 'feature' && (w.status === 'in_progress' || w.status === 'review')).length,
      soon: soon.length
    }
  }, [db])

  const upcoming = db.milestones
    .filter((m) => m.status !== 'delivered' && !archived.has(m.projectId))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 6)

  if (db.projects.length === 0) {
    return (
      <div className="page">
        <Empty
          title="Welcome to Vibeloft"
          text="Add your first project: pick a folder on this computer or clone a repository from GitHub. The studio detects whether it's a web or React Native app and reads its tech stack."
          action={
            <button className="btn primary" onClick={ctx.newProject}>
              Add a project
            </button>
          }
        />
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">All customer projects at a glance</p>
        </div>
        <div className="row gap-s">
          <button className="btn primary" onClick={ctx.newProject}>
            <Icon name="plus" size={15} /> New project
          </button>
          <AppTools ctx={ctx} />
        </div>
      </header>

      <section className="tiles">
        <Tile label="Active projects" value={totals.active} />
        <Tile label="Open bugs" value={totals.bugs} tone={totals.bugs > 0 ? 'bad' : undefined} />
        <Tile label="Features in progress" value={totals.building} />
        <Tile label="Deliveries due ≤ 7 days" value={totals.soon} tone={totals.soon > 0 ? 'warn' : undefined} />
      </section>

      {upcoming.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h3>Upcoming deliveries</h3>
            <button className="link" onClick={() => go({ view: 'timeline' })}>
              View all →
            </button>
          </div>
          <div className="upcoming">
            {upcoming.map((m) => {
              const p = db.projects.find((x) => x.id === m.projectId)
              const due = dueLabel(m.dueDate)
              return (
                <button key={m.id} className="upcoming-row" onClick={() => p && go({ view: 'project', id: p.id, tab: 'timeline' })}>
                  <span className="upcoming-title">{m.title}</span>
                  <span className="muted">
                    {p?.name} · {p ? customerName(db, p) : ''}
                  </span>
                  <span className="muted">{fmtDate(m.dueDate)}</span>
                  <span className={`pill ${due.tone}`}>{due.text}</span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      <div className="toolbar">
        <div className="segmented">
          {(['all', 'web', 'mobile', 'other'] as const).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : k === 'web' ? 'Web' : k === 'mobile' ? 'Mobile' : 'Other'}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={showDelivered} onChange={(e) => setShowDelivered(e.target.checked)} />
          Show delivered
        </label>
        {archived.size > 0 && (
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived ({archived.size})
          </label>
        )}
      </div>

      <section className="grid">
        {projects.map((p) => {
          const s = projectStats(db, p.id)
          const info = repoInfos[p.id]
          const [commitAt, commitMsg] = info?.lastCommit?.split('|') ?? []
          const progress = s.totalItems ? Math.round((s.doneItems / s.totalItems) * 100) : 0
          const due = s.nextMilestone ? dueLabel(s.nextMilestone.dueDate) : null
          return (
            <button key={p.id} className="project-card" onClick={() => go({ view: 'project', id: p.id })}>
              <div className="project-card-top">
                <div>
                  <div className="project-card-name">{p.name}</div>
                  <div className="muted small">{customerName(db, p)}</div>
                </div>
                <div className="row gap-s">
                  {p.status !== 'active' && <span className="badge">{p.status}</span>}
                  {p.archivedAt && <span className="badge">archived</span>}
                  <KindBadge kind={p.kind} />
                </div>
              </div>
              {p.techStack.length > 0 && (
                <div className="chips">
                  {p.techStack.slice(0, 5).map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="stats">
                <Stat label="Bugs" value={s.openBugs} tone={s.criticalBugs > 0 ? 'bad' : undefined} />
                <Stat label="Features" value={s.openFeatures} />
                <Stat label="Building" value={s.featuresInProgress} />
              </div>
              <div className="progress" title={`${progress}% of items done`}>
                <div style={{ width: `${progress}%` }} />
              </div>
              <div className="project-card-foot">
                {s.nextMilestone && due ? (
                  <span className={`pill ${due.tone}`} title={s.nextMilestone.title}>
                    <Icon name="flag" size={12} /> {s.nextMilestone.title} · {due.text}
                  </span>
                ) : (
                  <span className="muted small">No upcoming delivery</span>
                )}
                <span className="muted small" title={commitMsg}>
                  {commitAt ? `Commit ${relTime(commitAt)}` : p.repo ?? ''}
                </span>
              </div>
            </button>
          )
        })}
      </section>
    </div>
  )
}

function Tile(props: { label: string; value: number; tone?: 'bad' | 'warn' }): ReactNode {
  return (
    <div className="tile">
      <div className={`tile-value ${props.tone ?? ''}`}>{props.value}</div>
      <div className="tile-label">{props.label}</div>
    </div>
  )
}

function Stat(props: { label: string; value: number; tone?: 'bad' }): ReactNode {
  return (
    <div className="stat">
      <span className={`stat-value ${props.tone ?? ''}`}>{props.value}</span>
      <span className="stat-label">{props.label}</span>
    </div>
  )
}
