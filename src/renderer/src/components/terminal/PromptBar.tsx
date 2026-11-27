import { useState, type ReactNode } from 'react'
import type { QuickPrompt, WorkItem } from '../../../../shared/types'
import type { AppCtx } from '../../App'
import { api, Field, Modal, uid } from '../../ui'
import { DEFAULT_PROMPTS, workPrompt } from '../../workPrompts'
import { Icon } from '../../icons'
import { Dropdown } from './Dropdown'

// One-click prompts for the running Claude Code session, plus a picker that
// sends one of the project's open bugs or features.

export function PromptBar(props: {
  ctx: AppCtx
  projectId: string
  /** Send a prompt to Claude (the panel picks or starts the Claude terminal). */
  onSend: (text: string, title: string) => void
  hasClaude: boolean
}): ReactNode {
  const { db, setDb } = props.ctx
  // Saved lists from before the rename still say "Continue" for the built-in chip.
  const prompts = (db.settings.quickPrompts ?? DEFAULT_PROMPTS).map((p) =>
    p.id === 'continue' && p.label === 'Continue' ? { ...p, label: 'Keep going' } : p
  )
  const [editing, setEditing] = useState<QuickPrompt[] | null>(null)
  const items = db.workItems.filter((w) => w.projectId === props.projectId && w.status !== 'done')
  const bugs = items.filter((w) => w.kind === 'bug')
  const features = items.filter((w) => w.kind === 'feature')

  const itemRow = (w: WorkItem, close: () => void): ReactNode => (
    <div key={w.id} className="work-pick">
      <span className="work-pick-title" title={w.body}>
        <span className={`kind-dot ${w.kind}`} /> {w.title}
      </span>
      <button
        className="btn small-btn"
        onClick={() => {
          close()
          props.onSend(workPrompt(w, 'plan'), `Plan: ${w.title}`)
        }}
      >
        Plan
      </button>
      <button
        className="btn small-btn primary"
        onClick={() => {
          close()
          if (w.status === 'backlog' || w.status === 'todo') void api.saveWorkItem({ ...w, status: 'in_progress' }).then(setDb)
          props.onSend(workPrompt(w, 'build'), `${w.kind === 'bug' ? 'Fix' : 'Build'}: ${w.title}`)
        }}
      >
        {w.kind === 'bug' ? 'Fix' : 'Build'}
      </button>
    </div>
  )

  return (
    <div className="prompt-bar">
      <Dropdown
        label={
          <>
            <Icon name="bug" size={15} /> Bugs &amp; features{items.length ? ` (${items.length})` : ''}
          </>
        } title="Send an open bug or feature to Claude" align="left" width={440}>
        {(close) => (
          <div className="work-menu">
            {items.length === 0 && <div className="muted small history-empty">No open bugs or features for this project.</div>}
            {bugs.length > 0 && <div className="menu-label">Bugs</div>}
            {bugs.map((w) => itemRow(w, close))}
            {features.length > 0 && <div className="menu-label">Features</div>}
            {features.map((w) => itemRow(w, close))}
          </div>
        )}
      </Dropdown>
      <div className="prompt-chips">
        {prompts.map((p) => (
          <button
            key={p.id}
            className="chip-btn prompt-chip"
            title={`${props.hasClaude ? 'Send to Claude' : 'Start Claude Code with'}: ${p.text}`}
            onClick={() => props.onSend(p.text, p.label)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <button className="icon-btn" title="Edit quick prompts" aria-label="Edit quick prompts" onClick={() => setEditing(prompts.map((p) => ({ ...p })))}>
        <Icon name="edit" size={15} />
      </button>

      {editing && (
        <Modal
          title="Quick prompts"
          wide
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setEditing(DEFAULT_PROMPTS.map((p) => ({ ...p })))}>
                Reset to defaults
              </button>
              <div className="grow" />
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  const clean = editing.filter((p) => p.label.trim() && p.text.trim()).map((p) => ({ ...p, label: p.label.trim(), text: p.text.trim() }))
                  setDb(await api.saveSettings({ ...db.settings, quickPrompts: clean }))
                  setEditing(null)
                }}
              >
                Save
              </button>
            </>
          }
        >
          <p className="muted small">Each button types its prompt into the Claude Code session that's open (or starts one) and sends it.</p>
          <div className="prompt-edit-list">
            {editing.map((p, i) => (
              <div key={p.id} className="prompt-edit">
                <Field label="Button">
                  <input className="input" value={p.label} onChange={(e) => setEditing(editing.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                </Field>
                <Field label="Prompt">
                  <textarea className="input" rows={2} value={p.text} onChange={(e) => setEditing(editing.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                </Field>
                <div className="prompt-edit-actions">
                  <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => setEditing(move(editing, i, -1))}>
                    <Icon name="arrowUp" size={14} />
                  </button>
                  <button className="icon-btn" title="Move down" disabled={i === editing.length - 1} onClick={() => setEditing(move(editing, i, 1))}>
                    <Icon name="arrowDown" size={14} />
                  </button>
                  <button className="icon-btn" title="Remove" onClick={() => setEditing(editing.filter((_, j) => j !== i))}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button className="btn" onClick={() => setEditing([...editing, { id: uid(), label: '', text: '' }])}>
            <Icon name="plus" size={15} /> Add prompt
          </button>
        </Modal>
      )}
    </div>
  )
}

function move<T>(list: T[], i: number, d: number): T[] {
  const next = [...list]
  const [x] = next.splice(i, 1)
  next.splice(i + d, 0, x)
  return next
}
