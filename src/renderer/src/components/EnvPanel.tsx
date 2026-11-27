import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { EnvFile } from '../../../shared/types'
import type { AppCtx } from '../App'
import { monaco, monoOptions, setEditorTheme } from '../monaco'
import { api, Empty } from '../ui'

// Shows the project's .env files. Values are secrets, so they stay masked
// until you reveal one, and they are never sent to Claude.

const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

export function EnvPanel({ ctx, projectId }: { ctx: AppCtx; projectId: string }): ReactNode {
  const project = ctx.db.projects.find((p) => p.id === projectId)!
  const [files, setFiles] = useState<EnvFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    api.envFiles(projectId).then(setFiles, (e) => setError((e as Error).message))
  }, [projectId])

  useEffect(() => {
    if (project.localPath) load()
  }, [load, project.localPath])

  // Hide everything again when leaving the tab.
  useEffect(() => () => setRevealed(new Set()), [])

  if (!project.localPath) {
    return <Empty title="No local folder" text="Edit the project and choose its folder to see its environment files." />
  }

  const toggle = (id: string): void =>
    setRevealed((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const copy = (id: string, value: string): void => {
    navigator.clipboard.writeText(value)
    setCopied(id)
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500)
  }

  async function addToGitignore(rel: string): Promise<void> {
    if (!confirm(`Add "${rel}" to the project's .gitignore so it is never committed?`)) return
    try {
      await api.ignoreInGit(projectId, rel)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div>
      <div className="toolbar">
        <p className="muted">
          Values are hidden until you reveal them, and they are never sent to Claude.
        </p>
        <div className="grow" />
        {files && files.some((f) => f.entries.length) && (
          <button
            className="btn"
            onClick={() =>
              setRevealed((s) =>
                s.size ? new Set() : new Set(files.flatMap((f) => f.entries.map((e) => `${f.rel}#${e.line}`)))
              )
            }
          >
            {revealed.size ? 'Hide all' : 'Reveal all'}
          </button>
        )}
        <button className="btn" onClick={load}>
          <Icon name="refresh" size={15} /> Refresh
        </button>
      </div>

      {error && <div className="notice bad">{error}</div>}
      {files === null && !error && <p className="muted">Looking for .env files…</p>}
      {files && files.length === 0 && (
        <Empty
          title="No .env files"
          text="Looked in the project folder and in client/, server/, api/, app/, mobile/ and similar sub-folders."
        />
      )}

      {files?.map((f) => {
        const example = files.find((x) => x.isExample && dirOf(x.rel) === dirOf(f.rel))
        const keys = new Set(f.entries.map((e) => e.key))
        const missing = !f.isExample && example ? example.entries.map((e) => e.key).filter((k) => !keys.has(k)) : []
        const empty = f.entries.filter((e) => e.value === '').map((e) => e.key)
        return (
          <section key={f.rel} className="card env-card">
            <div className="card-head">
              <div className="row gap-s">
                <h3 className="mono">{f.rel}</h3>
                {f.isExample ? (
                  <span className="badge">Example</span>
                ) : f.gitIgnored === true ? (
                  <span className="pill ok" title="git ignores this file, so it won't be committed"><Icon name="check" size={12} /> Ignored by git</span>
                ) : f.gitIgnored === false ? (
                  <span className="pill bad">Not ignored by git</span>
                ) : (
                  <span className="pill warn" title="This folder is not a git repository">No git</span>
                )}
                <span className="muted small">
                  {f.entries.length} variable{f.entries.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="row gap-s">
                {editing !== f.rel && (
                  <button className="btn small-btn" onClick={() => setEditing(f.rel)} title="Edit this file here (values become visible)">
                    Edit
                  </button>
                )}
                <button className="icon-btn" title="Show in folder" onClick={() => api.revealFile(projectId, f.rel)}>
                  <Icon name="external" size={15} />
                </button>
              </div>
            </div>

            {!f.isExample && f.tracked && (
              <div className="notice bad">
                This file is already committed to git, so its secrets are in the repository history. Remove it from git
                (<code>git rm --cached {f.rel}</code>), add it to .gitignore, and change (rotate) the keys it contains.
              </div>
            )}
            {!f.isExample && !f.tracked && f.gitIgnored === false && (
              <div className="notice warn row between">
                <span>This file is not in .gitignore, so it could be committed and pushed to GitHub.</span>
                <button className="btn small-btn" onClick={() => addToGitignore(f.rel)}>
                  Add to .gitignore
                </button>
              </div>
            )}
            {missing.length > 0 && (
              <div className="notice warn">
                Missing compared to <code>{example!.rel}</code>: {missing.map((k) => <code key={k} className="env-chip">{k}</code>)}
              </div>
            )}

            {editing === f.rel ? (
              <EnvEditor
                projectId={projectId}
                rel={f.rel}
                theme={ctx.theme}
                onDone={(saved) => {
                  setEditing(null)
                  if (saved) load()
                }}
              />
            ) : f.entries.length === 0 ? (
              <p className="muted small">No variables in this file.</p>
            ) : (
              <table className="env-table">
                <tbody>
                  {f.entries.map((e) => {
                    const id = `${f.rel}#${e.line}`
                    const shown = revealed.has(id) || f.isExample
                    return (
                      <tr key={id}>
                        <td className="env-key mono">{e.key}</td>
                        <td className="env-value mono">
                          {e.value === '' ? (
                            <span className="muted">(empty)</span>
                          ) : shown ? (
                            <span className="env-revealed">{e.value}</span>
                          ) : (
                            <span className="env-masked" title={`${e.value.length} characters`}>
                              {'•'.repeat(Math.min(Math.max(e.value.length, 6), 24))}
                            </span>
                          )}
                        </td>
                        <td className="env-actions">
                          {e.value !== '' && !f.isExample && (
                            <button className="icon-btn" onClick={() => toggle(id)} title={shown ? 'Hide' : 'Reveal'}>
                              {shown ? 'Hide' : 'Show'}
                            </button>
                          )}
                          {e.value !== '' && (
                            <button className="icon-btn" onClick={() => copy(id, e.value)} title="Copy value">
                              {copied === id ? <><Icon name="check" size={13} /> Copied</> : 'Copy'}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {!f.isExample && empty.length > 0 && (
              <p className="muted small">Empty values: {empty.join(', ')}</p>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** Edit a .env file in place with the built-in editor. */
function EnvEditor(props: { projectId: string; rel: string; theme: 'dark' | 'light'; onDone: (saved: boolean) => void }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modified = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setEditorTheme(props.theme)
  }, [props.theme])

  useEffect(() => {
    let disposed = false
    api.readFile(props.projectId, props.rel).then(
      (c) => {
        if (disposed || !host.current || c.kind !== 'text') return
        modified.current = c.modified
        editor.current = monaco.editor.create(host.current, {
          value: c.text,
          language: 'ini',
          automaticLayout: true,
          minimap: { enabled: false },
          ...monoOptions(),
          scrollBeyondLastLine: false,
          wordWrap: 'on'
        })
        editor.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())
        editor.current.focus()
        setReady(true)
      },
      (e) => setError(String((e as Error).message))
    )
    return () => {
      disposed = true
      editor.current?.dispose()
    }
  }, [props.projectId, props.rel])

  async function save(): Promise<void> {
    if (!editor.current) return
    try {
      await api.writeFile(props.projectId, props.rel, editor.current.getValue(), modified.current)
      props.onDone(true)
    } catch (e) {
      setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div className="env-editor">
      <p className="muted small">Values are visible while you edit. Ctrl+S saves.</p>
      {error && <div className="notice bad">{error}</div>}
      <div className="env-editor-host" ref={host} />
      <div className="row gap-s env-editor-actions">
        <button className="btn small-btn" onClick={() => props.onDone(false)}>
          Cancel
        </button>
        <button className="btn small-btn primary" onClick={save} disabled={!ready}>
          Save
        </button>
      </div>
    </div>
  )
}
