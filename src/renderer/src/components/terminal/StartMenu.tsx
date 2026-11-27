import { useEffect, useState, type ReactNode } from 'react'
import type { ClaudeSession } from '../../../../shared/types'
import { CONTINUED, type ClaudeStart } from '../../claudeStart'
import { addDirFlags } from '../../links'

// "New conversation with options…" in the terminal's + menu: pick the
// conversation, mode, model and linked folders before starting Claude Code.

const MODES = [
  { id: 'default', label: 'Normal', hint: 'Asks before editing files and running commands' },
  { id: 'acceptEdits', label: 'Auto-accept edits', hint: 'Edits files without asking; still asks before commands' },
  { id: 'plan', label: 'Plan only', hint: 'Reads the code and proposes a plan; changes nothing' }
] as const

const MODELS = [
  { id: '', label: 'Default (from Settings)' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (faster)' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2 (most capable)' }
]

const short = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 34 ? `${t.slice(0, 33).trimEnd()}…` : t
}

export function StartOptions(props: {
  linked?: { name: string; path: string }[]
  /** The conversation "continue" would reopen (null: none, or it's already open). */
  findLast: () => Promise<ClaudeSession | null>
  onStart: (command: string, title: string) => void
  close: () => void
}): ReactNode {
  const [mode, setMode] = useState<(typeof MODES)[number]['id']>('default')
  const [model, setModel] = useState('')
  const [conversation, setConversation] = useState<ClaudeStart>('new')
  const [last, setLast] = useState<ClaudeSession | null | undefined>(undefined)
  useEffect(() => void props.findLast().then(setLast), [])
  const linked = props.linked ?? []
  // Linked projects are readable by default; untick to start Claude with this folder only.
  const [off, setOff] = useState<Set<string>>(new Set())
  const dirs = linked.filter((l) => !off.has(l.path))

  const start = async (m: string, md: string, how: ClaudeStart): Promise<void> => {
    const resume = how === 'continue' ? (last !== undefined ? last : await props.findLast()) : null
    const parts = ['claude']
    if (resume) parts.push('--resume', resume.id)
    if (m) parts.push('--model', m)
    if (md !== 'default') parts.push('--permission-mode', md)
    const tag = md === 'plan' ? ' (Plan)' : md === 'acceptEdits' ? ' (Auto-edit)' : ''
    const name = resume ? CONTINUED : 'Claude Code'
    props.onStart(parts.join(' ') + addDirFlags(dirs.map((d) => d.path)), `${name}${tag}`.slice(0, 48))
  }

  return (
    <div className="start-menu">
      <div className="menu-label">Conversation</div>
      <label className="start-opt">
        <input type="radio" name="conv" checked={conversation === 'continue'} onChange={() => setConversation('continue')} />
        <span>
          <b>Continue the last one</b>
          <small>
            {last === undefined
              ? 'Looking…'
              : last
                ? short(last.title || last.firstPrompt || 'Untitled conversation')
                : 'None to continue (or it’s already open): starts a new one'}
          </small>
        </span>
      </label>
      <label className="start-opt">
        <input type="radio" name="conv" checked={conversation === 'new'} onChange={() => setConversation('new')} />
        <span>
          <b>Start a new one</b>
          <small>Fresh context; earlier ones stay in History</small>
        </span>
      </label>
      <div className="menu-label">Mode</div>
      {MODES.map((m) => (
        <label key={m.id} className="start-opt">
          <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
          <span>
            <b>{m.label}</b>
            <small>{m.hint}</small>
          </span>
        </label>
      ))}
      {linked.length > 0 && (
        <>
          <div className="menu-label">Claude can also read</div>
          {linked.map((l) => (
            <label key={l.path} className="start-opt">
              <input
                type="checkbox"
                checked={!off.has(l.path)}
                onChange={() => {
                  const next = new Set(off)
                  if (next.has(l.path)) next.delete(l.path)
                  else next.add(l.path)
                  setOff(next)
                }}
              />
              <span>
                <b>{l.name}</b>
                <small>Linked project: Claude can read its code (it asks before editing there)</small>
              </span>
            </label>
          ))}
        </>
      )}
      <div className="menu-label">Model</div>
      <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <button
        className="btn primary start-go"
        onClick={() => {
          props.close()
          void start(model, mode, conversation)
        }}
      >
        Start Claude Code
      </button>
    </div>
  )
}
