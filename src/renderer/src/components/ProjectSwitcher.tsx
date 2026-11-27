import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppCtx } from '../App'
import { useWaitingProjects } from '../attention'
import { pendingForProject, useLinkStatuses } from '../links'
import { markDone } from '../help/progress'
import { customerName, KindBadge } from '../ui'

// Ctrl+K: jump to any project by typing part of its name. Each project opens
// on the tab you last used there (Terminal the first time).

export function ProjectSwitcher(props: { ctx: AppCtx; currentId: string | null; onClose: () => void }): ReactNode {
  const { db } = props.ctx
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  const waiting = useWaitingProjects()
  const linkMap = useLinkStatuses()
  const box = useRef<HTMLInputElement>(null)

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return db.projects
      .filter((p) => {
        if (p.archivedAt) return false
        const hay = `${p.name} ${customerName(db, p)} ${p.repo ?? ''}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      })
      .sort((a, b) => Number(b.id !== props.currentId) - Number(a.id !== props.currentId) || a.name.localeCompare(b.name))
  }, [q, db, props.currentId])

  useEffect(() => setIndex(0), [q])
  useEffect(() => box.current?.focus(), [])

  const open = (id: string): void => {
    markDone('switched')
    props.onClose()
    props.ctx.go({ view: 'project', id })
  }

  return (
    <div className="modal-backdrop switcher-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="switcher" role="dialog" aria-label="Switch project">
        <input
          ref={box}
          className="input switcher-input"
          placeholder="Switch to project…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') props.onClose()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(list.length - 1, i + 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            }
            if (e.key === 'Enter' && list[index]) open(list[index].id)
          }}
        />
        <div className="switcher-list" role="listbox">
          {list.length === 0 && <div className="muted small switcher-empty">No project matches.</div>}
          {list.map((p, i) => {
            const pending = pendingForProject(db, p.id, linkMap)
            return (
              <button
                key={p.id}
                role="option"
                aria-selected={i === index}
                className={`switcher-item ${i === index ? 'on' : ''}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => open(p.id)}
              >
                <KindBadge kind={p.kind} />
                <span className="switcher-name">{p.name}</span>
                <span className="muted small">{customerName(db, p)}</span>
                <span className="grow" />
                {pending > 0 && (
                  <span className="link-chip-count" title="Its linked API changed">
                    API {pending}
                  </span>
                )}
                {waiting.has(p.id) && <span className="waiting-dot" title="Claude Code is waiting for you" />}
                {p.id === props.currentId && <span className="muted small">current</span>}
              </button>
            )
          })}
        </div>
        <div className="switcher-foot muted small">↑↓ to choose · Enter to open · Esc to close</div>
      </div>
    </div>
  )
}
