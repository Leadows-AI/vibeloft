import { useState, type ReactNode } from 'react'
import { AppTools } from './AppTools'
import { Icon } from '../icons'
import type { Milestone } from '../../../shared/types'
import type { AppCtx } from '../App'
import { api, customerName, dueLabel, Empty, Field, fmtDate, Modal, today, uid } from '../ui'

const STATUS_LABEL: Record<Milestone['status'], string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  delivered: 'Delivered'
}

/** Milestones for one project, with progress from linked features and bugs. */
export function ProjectTimeline({ ctx, projectId }: { ctx: AppCtx; projectId: string }): ReactNode {
  const { db } = ctx
  const [editing, setEditing] = useState<Milestone | null>(null)
  const list = db.milestones.filter((m) => m.projectId === projectId).sort((a, b) => a.dueDate.localeCompare(b.dueDate))

  const blank = (): Milestone => ({ id: uid(), projectId, title: '', dueDate: today(), status: 'planned', notes: '' })

  return (
    <div>
      <div className="toolbar">
        <p className="muted">Delivery milestones. Link features and bugs to a milestone to track its progress.</p>
        <div className="grow" />
        <button className="btn primary" onClick={() => setEditing(blank())}>
          <Icon name="plus" size={15} /> Milestone
        </button>
      </div>
      {list.length === 0 ? (
        <Empty title="No milestones yet" text="Add the delivery dates you've agreed with the customer." />
      ) : (
        <div className="timeline">
          {list.map((m) => {
            const items = db.workItems.filter((w) => w.milestoneId === m.id)
            const done = items.filter((w) => w.status === 'done').length
            const pct = items.length ? Math.round((done / items.length) * 100) : 0
            const due = dueLabel(m.dueDate)
            return (
              <button key={m.id} className={`milestone ${m.status}`} onClick={() => setEditing(m)}>
                <span className="milestone-dot" />
                <div className="milestone-body">
                  <div className="row between">
                    <strong>{m.title}</strong>
                    {m.status === 'delivered' ? <span className="pill ok">Delivered</span> : <span className={`pill ${due.tone}`}>{due.text}</span>}
                  </div>
                  <div className="muted small">
                    {fmtDate(m.dueDate)} · {STATUS_LABEL[m.status]} · {done}/{items.length} items done
                  </div>
                  <div className="progress">
                    <div style={{ width: `${pct}%` }} />
                  </div>
                  {m.notes && <p className="small">{m.notes}</p>}
                </div>
              </button>
            )
          })}
        </div>
      )}
      {editing && <MilestoneForm ctx={ctx} milestone={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

/** Every project's deliveries in one list, grouped by month. */
export function TimelineAll({ ctx }: { ctx: AppCtx }): ReactNode {
  const { db, go } = ctx
  const [showDelivered, setShowDelivered] = useState(false)
  const list = db.milestones
    .filter((m) => (showDelivered || m.status !== 'delivered') && !db.projects.find((p) => p.id === m.projectId)?.archivedAt)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const months = new Map<string, Milestone[]>()
  for (const m of list) {
    const key = new Date(`${m.dueDate}T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    months.set(key, [...(months.get(key) ?? []), m])
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Deliveries</h1>
          <p className="muted">Milestones across all customers</p>
        </div>
        <div className="row gap-s">
          <label className="check">
            <input type="checkbox" checked={showDelivered} onChange={(e) => setShowDelivered(e.target.checked)} />
            Show delivered
          </label>
          <AppTools ctx={ctx} />
        </div>
      </header>
      {list.length === 0 && <Empty title="Nothing scheduled" text="Open a project and add milestones on its Timeline tab." />}
      {[...months.entries()].map(([month, ms]) => (
        <section key={month} className="card">
          <h3>{month}</h3>
          <div className="upcoming">
            {ms.map((m) => {
              const p = db.projects.find((x) => x.id === m.projectId)
              const due = dueLabel(m.dueDate)
              const items = db.workItems.filter((w) => w.milestoneId === m.id)
              const done = items.filter((w) => w.status === 'done').length
              return (
                <button key={m.id} className="upcoming-row" onClick={() => p && go({ view: 'project', id: p.id, tab: 'timeline' })}>
                  <span className="upcoming-title">{m.title}</span>
                  <span className="muted">
                    {p?.name} · {p ? customerName(db, p) : ''}
                  </span>
                  <span className="muted">
                    {fmtDate(m.dueDate)} · {done}/{items.length} done
                  </span>
                  {m.status === 'delivered' ? <span className="pill ok">Delivered</span> : <span className={`pill ${due.tone}`}>{due.text}</span>}
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function MilestoneForm(props: { ctx: AppCtx; milestone: Milestone; onClose: () => void }): ReactNode {
  const { db, setDb } = props.ctx
  const [m, setM] = useState(props.milestone)
  const isNew = !db.milestones.some((x) => x.id === m.id)
  const set = <K extends keyof Milestone>(k: K, v: Milestone[K]): void => setM((x) => ({ ...x, [k]: v }))
  return (
    <Modal
      title={isNew ? 'New milestone' : 'Milestone'}
      onClose={props.onClose}
      footer={
        <>
          {!isNew && (
            <button
              className="btn danger ghost"
              onClick={async () => {
                setDb(await api.deleteMilestone(m.id))
                props.onClose()
              }}
            >
              Delete
            </button>
          )}
          <div className="grow" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              if (!m.title.trim()) return
              setDb(await api.saveMilestone({ ...m, title: m.title.trim() }))
              props.onClose()
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Title">
          <input className="input" value={m.title} placeholder="e.g. Beta release to customer" onChange={(e) => set('title', e.target.value)} autoFocus />
        </Field>
        <Field label="Due date">
          <input className="input" type="date" value={m.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
        </Field>
        <Field label="Status">
          <select className="input" value={m.status} onChange={(e) => set('status', e.target.value as Milestone['status'])}>
            <option value="planned">Planned</option>
            <option value="in_progress">In progress</option>
            <option value="delivered">Delivered</option>
          </select>
        </Field>
        <Field label="Notes">
          <textarea className="input" rows={4} value={m.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
