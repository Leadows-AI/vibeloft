import { lazy, Suspense, useState, type ReactNode } from 'react'
import { AppTools } from './AppTools'
import type { Customer } from '../../../shared/types'
import type { AppCtx } from '../App'
import { fmtHours, startOfMonth, totalBetween } from '../time'
import { Icon } from '../icons'
import { api, Empty, Field, KindBadge, Modal, projectStats, uid } from '../ui'

const ReportModal = lazy(() => import('./ReportModal').then((m) => ({ default: m.ReportModal })))

export function Customers({ ctx }: { ctx: AppCtx }): ReactNode {
  const { db, setDb, go } = ctx
  const [editing, setEditing] = useState<Customer | null>(null)
  const [reportFor, setReportFor] = useState<Customer | null>(null)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Customers</h1>
          <p className="muted">Who each project is for</p>
        </div>
        <div className="row gap-s">
          <button className="btn primary" onClick={() => setEditing({ id: uid(), name: '', contact: '', notes: '' })}>
            <Icon name="plus" size={15} /> Customer
          </button>
          <AppTools ctx={ctx} />
        </div>
      </header>
      {db.customers.length === 0 && <Empty title="No customers yet" text="Add a customer, or create one while adding a project." />}
      <div className="grid">
        {db.customers.map((c) => {
          const projects = db.projects.filter((p) => p.customerId === c.id)
          const bugs = projects.reduce((n, p) => n + projectStats(db, p.id).openBugs, 0)
          return (
            <div key={c.id} className="card customer-card">
              <div className="card-head">
                <h3>{c.name}</h3>
                <button className="link" onClick={() => setEditing(c)}>
                  Edit
                </button>
              </div>
              {c.contact && <div className="muted small">{c.contact}</div>}
              <div className="muted small">
                {projects.length} project{projects.length === 1 ? '' : 's'} · {bugs} open bug{bugs === 1 ? '' : 's'} ·{' '}
                {fmtHours(totalBetween(db.timeEntries.filter((t) => projects.some((p) => p.id === t.projectId)), startOfMonth()))} this month
              </div>
              <div className="customer-projects">
                {projects.map((p) => (
                  <button key={p.id} className="project-link" onClick={() => go({ view: 'project', id: p.id })}>
                    <KindBadge kind={p.kind} /> <span className="project-link-name">{p.name}</span>
                  </button>
                ))}
              </div>
              {c.notes && <p className="small">{c.notes}</p>}
              {projects.length > 0 && (
                <button className="btn small-btn customer-report" onClick={() => setReportFor(c)}>
                  <Icon name="report" size={15} /> Status report
                </button>
              )}
            </div>
          )
        })}
      </div>
      {editing && (
        <Modal
          title={db.customers.some((c) => c.id === editing.id) ? 'Edit customer' : 'New customer'}
          onClose={() => setEditing(null)}
          footer={
            <>
              {db.customers.some((c) => c.id === editing.id) && (
                <button
                  className="btn danger ghost"
                  onClick={async () => {
                    if (!confirm(`Delete ${editing.name}? Their projects are kept without a customer.`)) return
                    setDb(await api.deleteCustomer(editing.id))
                    setEditing(null)
                  }}
                >
                  Delete
                </button>
              )}
              <div className="grow" />
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  if (!editing.name.trim()) return
                  setDb(await api.saveCustomer({ ...editing, name: editing.name.trim() }))
                  setEditing(null)
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Name">
              <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
            </Field>
            <Field label="Contact">
              <input className="input" value={editing.contact ?? ''} placeholder="Name, email, phone" onChange={(e) => setEditing({ ...editing, contact: e.target.value })} />
            </Field>
            <Field label="Notes">
              <textarea className="input" rows={4} value={editing.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
      {reportFor && (
        <Suspense fallback={null}>
          <ReportModal
            ctx={ctx}
            projectIds={db.projects.filter((p) => p.customerId === reportFor.id).map((p) => p.id)}
            title={reportFor.name}
            onClose={() => setReportFor(null)}
          />
        </Suspense>
      )}
    </div>
  )
}
