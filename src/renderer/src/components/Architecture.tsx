import { useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { AppCtx } from '../App'
import { api, Empty, relTime } from '../ui'
import { Markdown } from './Markdown'

export function Architecture({ ctx, projectId }: { ctx: AppCtx; projectId: string }): ReactNode {
  const { db, setDb } = ctx
  const p = db.projects.find((x) => x.id === projectId)!
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(p.architecture)

  async function generate(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const next = await api.generateArchitecture(projectId)
      setDb(next)
      setDraft(next.projects.find((x) => x.id === projectId)?.architecture ?? '')
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  async function saveDraft(): Promise<void> {
    setDb(await api.saveProject({ ...p, architecture: draft }))
    setEditing(false)
  }

  async function exportDoc(): Promise<void> {
    try {
      const file = await api.exportArchitecture(projectId)
      setNote(`Saved to ${file}. Commit it to keep the doc with the code.`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div>
      <div className="toolbar">
        <p className="muted">
          {p.architectureUpdatedAt ? `Generated ${relTime(p.architectureUpdatedAt)}` : 'Claude reads the repository (read-only) and writes the overview.'}
        </p>
        <div className="grow" />
        {p.architecture && !editing && (
          <>
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn" onClick={exportDoc} title="Write docs/ARCHITECTURE.md into the repository">
              Save to repo
            </button>
          </>
        )}
        {editing && (
          <>
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={saveDraft}>
              Save
            </button>
          </>
        )}
        {!editing && (
          <button className="btn primary" onClick={generate} disabled={busy}>
            {!busy && <Icon name="sparkle" size={15} />} {busy ? 'Claude is reading the code…' : p.architecture ? 'Regenerate' : 'Generate with Claude'}
          </button>
        )}
      </div>
      {error && <div className="notice bad">{error}</div>}
      {note && (
        <div className="notice ok" onClick={() => setNote(null)}>
          {note}
        </div>
      )}
      {busy && <div className="notice">This takes a minute or two on larger repositories. You can keep working in other tabs.</div>}
      {editing ? (
        <textarea className="input mono arch-editor" value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : p.architecture ? (
        <div className="card">
          <Markdown text={p.architecture} theme={ctx.theme} />
        </div>
      ) : (
        !busy && (
          <Empty
            title="No architecture doc yet"
            text="Generate one to get the stack, folder structure, a diagram, the data model and key flows of this project."
          />
        )
      )}
    </div>
  )
}
