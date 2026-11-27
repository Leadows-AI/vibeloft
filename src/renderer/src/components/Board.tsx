import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { ChatMode } from '../../../shared/types'
import { WORK_STATUSES, type WorkItem, type WorkKind, type WorkStatus } from '../../../shared/types'
import type { AppCtx } from '../App'
import { api, Field, Modal, nowIso, uid } from '../ui'
import type { AskClaude } from './ProjectView'
import { loadTeam } from './TeamCard'

export function Board(props: { ctx: AppCtx; projectId: string; ask: AskClaude }): ReactNode {
  const { db, setDb } = props.ctx
  const [filter, setFilter] = useState<WorkKind | 'all'>('all')
  const [editing, setEditing] = useState<WorkItem | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<WorkStatus | null>(null)
  const [q, setQ] = useState('')

  const items = db.workItems.filter(
    (w) =>
      w.projectId === props.projectId &&
      (filter === 'all' || w.kind === filter) &&
      (!q || w.title.toLowerCase().includes(q.toLowerCase()))
  )
  const milestones = db.milestones.filter((m) => m.projectId === props.projectId)

  const newItem = (kind: WorkKind): WorkItem => ({
    id: uid(),
    projectId: props.projectId,
    kind,
    title: '',
    body: '',
    status: 'backlog',
    priority: kind === 'bug' ? 'high' : 'medium',
    milestoneId: null,
    assignees: [],
    githubNumber: null,
    githubUrl: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    syncedAt: null
  })

  async function move(id: string, status: WorkStatus): Promise<void> {
    const item = db.workItems.find((w) => w.id === id)
    if (item && item.status !== status) setDb(await api.saveWorkItem({ ...item, status }))
  }

  return (
    <div className="board-wrap">
      <div className="toolbar">
        <div className="segmented">
          {(['all', 'feature', 'bug'] as const).map((k) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {k === 'all' ? 'All' : k === 'feature' ? 'Features' : 'Bugs'}
            </button>
          ))}
        </div>
        <input className="input search-inline" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="grow" />
        <button className="btn" onClick={() => setEditing(newItem('bug'))}>
          <Icon name="plus" size={15} /> Bug
        </button>
        <button className="btn primary" onClick={() => setEditing(newItem('feature'))}>
          <Icon name="plus" size={15} /> Feature
        </button>
      </div>

      <div className="board">
        {WORK_STATUSES.map((col) => {
          const colItems = items.filter((w) => w.status === col.id)
          return (
            <div
              key={col.id}
              className={`column ${overCol === col.id ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setOverCol(col.id)
              }}
              onDragLeave={() => setOverCol(null)}
              onDrop={() => {
                if (dragId) move(dragId, col.id)
                setDragId(null)
                setOverCol(null)
              }}
            >
              <div className="column-head">
                <span>{col.label}</span>
                <span className="count">{colItems.length}</span>
              </div>
              <div className="column-body">
                {colItems.map((w) => {
                  const ms = milestones.find((m) => m.id === w.milestoneId)
                  return (
                    <div
                      key={w.id}
                      className={`work-card ${w.kind}`}
                      draggable
                      onDragStart={() => setDragId(w.id)}
                      onClick={() => setEditing(w)}
                    >
                      <div className="work-card-title">{w.title}</div>
                      <div className="work-card-meta">
                        <span className={`kind-tag ${w.kind}`}>{w.kind === 'bug' ? 'Bug' : 'Feature'}</span>
                        <span className={`prio ${w.priority}`}>{w.priority}</span>
                        {w.githubNumber && <span className="muted small">#{w.githubNumber}</span>}
                        {ms && <span className="muted small"><Icon name="flag" size={12} /> {ms.title}</span>}
                        {w.assignees?.map((a) => <span key={a} className="muted small">@{a}</span>)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {editing && (
        <WorkItemForm
          ctx={props.ctx}
          item={editing}
          onClose={() => setEditing(null)}
          ask={(prompt, mode, title) => {
            setEditing(null)
            props.ask(prompt, mode, title)
          }}
        />
      )}
    </div>
  )
}

function WorkItemForm(props: { ctx: AppCtx; item: WorkItem; onClose: () => void; ask: AskClaude }): ReactNode {
  const { db, setDb } = props.ctx
  const [w, setW] = useState<WorkItem>(props.item)
  const isNew = !db.workItems.some((x) => x.id === w.id)
  const milestones = db.milestones.filter((m) => m.projectId === w.projectId)
  const set = <K extends keyof WorkItem>(k: K, v: WorkItem[K]): void => setW((x) => ({ ...x, [k]: v }))
  const [assigneeText, setAssigneeText] = useState((props.item.assignees ?? []).join(', '))
  const [meError, setMeError] = useState('')
  const parseAssignees = (t: string): string[] => [...new Set(t.split(/[\s,]+/).map((a) => a.replace(/^@/, '')).filter(Boolean))]
  const repo = db.projects.find((p) => p.id === w.projectId)?.repo
  const [teammates, setTeammates] = useState<string[]>([])
  useEffect(() => {
    if (repo) loadTeam(repo).then((t) => setTeammates(t.members.map((m) => m.login)), () => {})
  }, [repo])
  const toggleAssignee = (login: string): void =>
    setAssigneeText((t) => {
      const list = parseAssignees(t)
      return (list.includes(login) ? list.filter((a) => a !== login) : [...list, login]).join(', ')
    })

  async function assignMe(): Promise<void> {
    const gh = await api.ghStatus().catch(() => null)
    if (!gh?.ok || !gh.user) return setMeError(gh?.message ?? 'GitHub CLI is not available.')
    setMeError('')
    setAssigneeText((t) => parseAssignees(`${t} ${gh.user}`).join(', '))
  }

  async function save(): Promise<WorkItem | null> {
    if (!w.title.trim()) return null
    // Untouched older items keep "unknown" so a save doesn't clear assignees set on GitHub.
    const typed = parseAssignees(assigneeText)
    const assignees = w.assignees === undefined && typed.length === 0 ? undefined : typed
    const saved = { ...w, title: w.title.trim(), assignees }
    setDb(await api.saveWorkItem(saved))
    return saved
  }

  const planPrompt = (): string =>
    w.kind === 'bug'
      ? `Investigate this bug. Find the root cause in the code and propose a fix, but do not change files yet.

${ref()}`
      : `Turn this requirement into a short spec and an implementation plan for this codebase: acceptance criteria, files to change, risks. Do not change files yet.

${ref()}`
  const buildPrompt = (): string =>
    `${w.kind === 'bug' ? 'Fix this bug' : 'Implement this feature'} in the codebase. Keep changes focused, follow the existing code style, and run the project's tests or type check if there are any. Summarize what you changed at the end. Do not commit.

${ref()}`

  const ref = (): string => `${w.kind === 'bug' ? 'Bug' : 'Feature'}${w.githubNumber ? ` (GitHub #${w.githubNumber})` : ''}: ${w.title}\n\n${w.body}`

  return (
    <Modal
      title={isNew ? (w.kind === 'bug' ? 'New bug' : 'New feature') : w.kind === 'bug' ? 'Bug' : 'Feature'}
      onClose={props.onClose}
      wide
      footer={
        <>
          {!isNew && (
            <button
              className="btn danger ghost"
              onClick={async () => {
                if (!confirm('Delete this item? Its GitHub issue (if any) stays open on GitHub.')) return
                setDb(await api.deleteWorkItem(w.id))
                props.onClose()
              }}
            >
              Delete
            </button>
          )}
          <div className="grow" />
          <ClaudeMenu
            kind={w.kind}
            onPick={async (mode) => {
              const saved = await save()
              if (!saved) return
              if (mode === 'build' && (saved.status === 'backlog' || saved.status === 'todo')) {
                setDb(await api.saveWorkItem({ ...saved, status: 'in_progress' }))
              }
              const title = `${mode === 'plan' ? 'Plan' : w.kind === 'bug' ? 'Fix' : 'Build'}: ${saved.title}`.slice(0, 40)
              props.ask(mode === 'plan' ? planPrompt() : buildPrompt(), mode, title)
            }}
          />
          <button
            className="btn primary"
            onClick={async () => {
              if (await save()) props.onClose()
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Title">
          <input className="input" value={w.title} onChange={(e) => set('title', e.target.value)} autoFocus />
        </Field>
        <Field label="Type">
          <select className="input" value={w.kind} onChange={(e) => set('kind', e.target.value as WorkItem['kind'])}>
            <option value="feature">Feature</option>
            <option value="bug">Bug</option>
          </select>
        </Field>
        <Field label="Status">
          <select className="input" value={w.status} onChange={(e) => set('status', e.target.value as WorkStatus)}>
            {WORK_STATUSES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select className="input" value={w.priority} onChange={(e) => set('priority', e.target.value as WorkItem['priority'])}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </Field>
        <Field label="Delivery milestone">
          <select className="input" value={w.milestoneId ?? ''} onChange={(e) => set('milestoneId', e.target.value || null)}>
            <option value="">None</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assigned to (GitHub usernames)">
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" placeholder="e.g. ana, zoe" value={assigneeText} onChange={(e) => setAssigneeText(e.target.value)} />
            <button className="btn" type="button" onClick={assignMe}>
              Assign to me
            </button>
          </div>
          {teammates.length > 0 && (
            <div className="chips" style={{ marginTop: 6 }}>
              {teammates.map((l) => {
                const on = parseAssignees(assigneeText).includes(l)
                return (
                  <button key={l} type="button" className={`chip-btn ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggleAssignee(l)}>
                    @{l}
                  </button>
                )
              })}
            </div>
          )}
          {meError && <p className="muted small">{meError}</p>}
        </Field>
        <Field label={w.kind === 'bug' ? 'Steps to reproduce, expected vs actual' : 'Requirement details'}>
          <textarea className="input mono" rows={10} value={w.body} onChange={(e) => set('body', e.target.value)} />
        </Field>
        {w.githubUrl && (
          <p className="muted small">
            Linked to{' '}
            <button className="link" onClick={() => api.openUrl(w.githubUrl!)}>
              GitHub issue #{w.githubNumber} <Icon name="external" size={13} />
            </button>
            . Changes go to GitHub on the next sync.
          </p>
        )}
      </div>
    </Modal>
  )
}

function ClaudeMenu(props: { kind: WorkKind; onPick: (mode: ChatMode) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const verb = props.kind === 'bug' ? 'Fix' : 'Build'
  const pick = (mode: ChatMode): void => {
    setOpen(false)
    props.onPick(mode)
  }
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="sparkle" size={15} /> Claude <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => pick('plan')}>
            <b>Plan in Claude Code</b>
            <span>Plan mode: reads the code, proposes an approach</span>
          </button>
          <button role="menuitem" onClick={() => pick('build')}>
            <b>{verb} in Claude Code</b>
            <span>Full CLI, asks before edits and commands</span>
          </button>
        </div>
      )}
    </div>
  )
}
