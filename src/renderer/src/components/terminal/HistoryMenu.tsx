import { useEffect, useState, type ReactNode } from 'react'
import type { ClaudeSession } from '../../../../shared/types'
import { api, relTime } from '../../ui'

// Past Claude Code conversations in this project; pick one to resume it.
// Shown inside the terminal's + menu.

export function HistoryList(props: { projectId: string; onResume: (s: ClaudeSession) => void }): ReactNode {
  const [list, setList] = useState<ClaudeSession[] | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => void api.claudeSessions(props.projectId).then(setList, () => setList([])), [props.projectId])

  const shown = (list ?? []).filter((s) => !q.trim() || `${s.title ?? ''} ${s.firstPrompt ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))

  return (
    <div className="history-menu">
      <input className="input" placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="history-list">
        {list === null && <div className="muted small history-empty">Loading…</div>}
        {list?.length === 0 && <div className="muted small history-empty">No Claude Code conversations in this project folder yet.</div>}
        {list && list.length > 0 && shown.length === 0 && <div className="muted small history-empty">No match.</div>}
        {shown.map((s) => (
          <button
            key={s.id}
            role="menuitem"
            onClick={() => props.onResume(s)}
            title={s.firstPrompt ?? s.title ?? s.id}
          >
            <b>
              {s.title || s.firstPrompt || 'Untitled conversation'}
              {s.fromEditor && (
                <span className="history-src" title="Started in VS Code. Opening it here carries on the same conversation.">
                  VS Code
                </span>
              )}
            </b>
            <span>
              {s.title && s.firstPrompt ? `${s.firstPrompt.slice(0, 90)} · ` : ''}
              {relTime(s.updatedAt)}
              {s.prompts > 0 ? ` · ${s.prompts}+ message${s.prompts === 1 ? '' : 's'}` : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
