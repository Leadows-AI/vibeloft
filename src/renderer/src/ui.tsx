import { useEffect, type ReactNode } from 'react'
import { Icon } from './icons'
import type { Database, Milestone, Project, WorkItem } from '../../shared/types'

export const api = window.vibe

export const uid = (): string => crypto.randomUUID()
export const nowIso = (): string => new Date().toISOString()
export const today = (): string => new Date().toISOString().slice(0, 10)

export function daysUntil(date: string): number {
  const d = new Date(`${date}T00:00:00`)
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - t.getTime()) / 86_400_000)
}

export function dueLabel(date: string): { text: string; tone: 'bad' | 'warn' | 'ok' } {
  const d = daysUntil(date)
  if (d < 0) return { text: `${-d}d overdue`, tone: 'bad' }
  if (d === 0) return { text: 'Due today', tone: 'bad' }
  if (d <= 7) return { text: `${d}d left`, tone: 'warn' }
  return { text: `${d}d left`, tone: 'ok' }
}

export function relTime(iso: string | null): string {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export function fmtDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export interface ProjectStats {
  openBugs: number
  criticalBugs: number
  featuresInProgress: number
  openFeatures: number
  doneItems: number
  totalItems: number
  nextMilestone: Milestone | null
}

export function projectStats(db: Database, projectId: string): ProjectStats {
  const items = db.workItems.filter((w) => w.projectId === projectId)
  const open = (w: WorkItem): boolean => w.status !== 'done'
  const next =
    db.milestones
      .filter((m) => m.projectId === projectId && m.status !== 'delivered')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null
  return {
    openBugs: items.filter((w) => w.kind === 'bug' && open(w)).length,
    criticalBugs: items.filter((w) => w.kind === 'bug' && open(w) && (w.priority === 'critical' || w.priority === 'high')).length,
    featuresInProgress: items.filter((w) => w.kind === 'feature' && (w.status === 'in_progress' || w.status === 'review')).length,
    openFeatures: items.filter((w) => w.kind === 'feature' && open(w)).length,
    doneItems: items.filter((w) => !open(w)).length,
    totalItems: items.length,
    nextMilestone: next
  }
}

export function customerName(db: Database, p: Project): string {
  return db.customers.find((c) => c.id === p.customerId)?.name ?? 'No customer'
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-label={props.title}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function Field(props: { label: string; children: ReactNode; hint?: string }): ReactNode {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  )
}

export function KindBadge({ kind }: { kind: Project['kind'] }): ReactNode {
  const label = kind === 'web' ? 'Web' : kind === 'mobile' ? 'Mobile' : 'Other'
  return <span className={`badge kind-${kind}`}>{label}</span>
}

export function Empty(props: { title: string; text?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="empty">
      <h3>{props.title}</h3>
      {props.text && <p>{props.text}</p>}
      {props.action}
    </div>
  )
}
