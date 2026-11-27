import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { GitCommit, GitFileChange, GitStatus } from '../../../shared/types'
import type { AppCtx } from '../App'
import { monaco, monoOptions, setEditorTheme } from '../monaco'
import { markDone } from '../help/progress'
import { api, relTime } from '../ui'
import { requestOpen } from '../filesBridge'
import type { ProjectTab } from './ProjectView'
import { RepoPicker, onRepoPicked } from './RepoPicker'

// Source control: review what changed (side-by-side diff), stage, commit,
// push and pull, switch branches. Updates by itself when files change.

const errText = (e: unknown): string => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const drafts = new Map<string, string>() // unsent commit messages per project

const LETTER: Record<string, { label: string; cls: string; title: string }> = {
  M: { label: 'M', cls: 'mod', title: 'Modified' },
  A: { label: 'A', cls: 'add', title: 'Added' },
  D: { label: 'D', cls: 'del', title: 'Deleted' },
  R: { label: 'R', cls: 'mod', title: 'Renamed' },
  C: { label: 'C', cls: 'add', title: 'Copied' },
  U: { label: '!', cls: 'del', title: 'Conflict' },
  '?': { label: 'U', cls: 'add', title: 'New file (untracked)' }
}

function letterFor(f: GitFileChange, staged: boolean): { label: string; cls: string; title: string } {
  if (f.conflicted) return LETTER.U
  const c = staged ? f.index : f.untracked ? '?' : f.worktree
  return LETTER[c] ?? { label: c, cls: 'mod', title: c }
}

export function GitPanel(props: { ctx: AppCtx; projectId: string; goTab: (t: ProjectTab) => void }): ReactNode {
  const { projectId, ctx } = props
  const project = ctx.db.projects.find((p) => p.id === projectId)!
  const [st, setSt] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<{ current: string | null; local: string[]; remote: string[] } | null>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [message, setMessage] = useState(drafts.get(projectId) ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null)
  const [mi, setMi] = useState<{ defaultBranch: string | null; current: string | null; unmerged: number } | null>(null)
  const messageBox = useRef<HTMLTextAreaElement>(null)
  const [inline, setInline] = useState(false)
  const [showLog, setShowLog] = useState(true)
  const [newBranch, setNewBranch] = useState<string | null>(null)

  const diffHost = useRef<HTMLDivElement>(null)
  const diffEditor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await api.gitStatus(projectId)
      setSt(s)
      if (s.isRepo) {
        api.gitBranches(projectId).then(setBranches)
        api.gitLog(projectId).then(setCommits)
        api.gitMergeInfo(projectId).then(setMi, () => setMi(null))
      }
    } catch (e) {
      setNotice({ tone: 'bad', text: errText(e) })
    }
  }, [projectId])

  useEffect(() => {
    if (!project.localPath) return
    refresh()
    // Update ahead/behind counts from the remote in the background.
    api.gitFetch(projectId).then(refresh, () => {})
  }, [projectId])

  // Refresh when files or git's index change on disk (debounced by the watcher).
  // Git operations (merge, rebase, push) can write in several steps, so a change
  // inside .git gets a second look a moment later.
  useEffect(() => {
    let later: ReturnType<typeof setTimeout> | null = null
    const off = api.onFilesChanged((e) => {
      if (e.projectId !== projectId) return
      refresh()
      if (e.paths.some((p) => /(^|\/)\.git\//.test(p))) {
        if (later) clearTimeout(later)
        later = setTimeout(refresh, 1500)
      }
    })
    return () => {
      off()
      if (later) clearTimeout(later)
    }
  }, [projectId, refresh])

  // Coming back to the window (e.g. after pushing from another app), and every
  // few minutes, check the remote too so ahead/behind stays right.
  useEffect(() => {
    if (!project.localPath) return
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    const t = setInterval(() => api.gitFetch(projectId).then(refresh, () => {}), 3 * 60_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(t)
    }
  }, [projectId, refresh])

  useEffect(
    () =>
      onRepoPicked(projectId, () => {
        setSelected(null)
        setBranches(null)
        setCommits([])
        setMi(null)
        refresh()
        api.gitFetch(projectId).then(refresh, () => {})
      }),
    [projectId, refresh]
  )

  useEffect(() => {
    drafts.set(projectId, message)
  }, [message, projectId])

  // Keep the selection on the file when it moves between Staged and Changes.
  useEffect(() => {
    if (!st || !selected) return
    const inStaged = st.files.some((f) => f.path === selected.path && f.staged)
    const inChanges = st.files.some((f) => f.path === selected.path && (f.unstaged || f.untracked))
    if (selected.staged ? inStaged : inChanges) return
    if (inStaged || inChanges) setSelected({ path: selected.path, staged: inStaged && !inChanges ? true : !selected.staged })
    else setSelected(null)
  }, [st])

  // ---------- diff editor ----------
  useEffect(() => setEditorTheme(ctx.theme), [ctx.theme])

  useEffect(() => {
    if (!diffHost.current) return
    const ed = monaco.editor.createDiffEditor(diffHost.current, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: !inline,
      useInlineViewWhenSpaceIsLimited: true,
      ...monoOptions(),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true
    })
    diffEditor.current = ed
    return () => {
      const m = ed.getModel()
      ed.dispose()
      m?.original.dispose()
      m?.modified.dispose()
      diffEditor.current = null
    }
  }, [projectId])

  useEffect(() => {
    diffEditor.current?.updateOptions({ renderSideBySide: !inline })
  }, [inline])

  // Load the selected file's diff (and reload it when the status changes).
  useEffect(() => {
    const ed = diffEditor.current
    if (!ed) return
    let cancelled = false
    const old = ed.getModel()
    if (!selected) {
      ed.setModel(null)
      old?.original.dispose()
      old?.modified.dispose()
      return
    }
    api.gitDiff(projectId, selected.path, selected.staged).then(
      ({ original, modified }) => {
        if (cancelled || !diffEditor.current) return
        const uri = (side: string): monaco.Uri =>
          monaco.Uri.from({ scheme: 'gitdiff', path: `/${projectId}/${selected.path}`, query: `${side}-${Date.now()}` })
        // Create both with the file's language (taken from its extension).
        const lang = monaco.editor.createModel('', undefined, monaco.Uri.from({ scheme: 'probe', path: `/${selected.path}`, query: String(Date.now()) }))
        const language = lang.getLanguageId()
        lang.dispose()
        const next = {
          original: monaco.editor.createModel(original, language, uri('a')),
          modified: monaco.editor.createModel(modified, language, uri('b'))
        }
        diffEditor.current.setModel(next)
        old?.original.dispose()
        old?.modified.dispose()
      },
      (e) => setNotice({ tone: 'bad', text: errText(e) })
    )
    return () => {
      cancelled = true
    }
  }, [selected?.path, selected?.staged, st])

  // ---------- actions ----------
  async function act(label: string, fn: () => Promise<unknown>, success?: string): Promise<boolean> {
    setBusy(label)
    setNotice(null)
    try {
      const out = await fn()
      if (success) setNotice({ tone: 'ok', text: typeof out === 'string' && out.length < 300 && label !== 'commit' ? out || success : success })
      await refresh()
      return true
    } catch (e) {
      setNotice({ tone: 'bad', text: errText(e) })
      await refresh()
      return false
    } finally {
      setBusy(null)
    }
  }

  const staged = st?.files.filter((f) => f.staged) ?? []
  const changes = st?.files.filter((f) => f.unstaged || f.untracked) ?? []

  async function commit(): Promise<void> {
    if (!message.trim()) return setNotice({ tone: 'warn', text: 'Write a commit message first (or let Claude write one).' })
    if (staged.length === 0) {
      if (changes.length === 0) return
      if (!confirm(`Nothing is staged. Stage all ${changes.length} changed file${changes.length === 1 ? '' : 's'} and commit them?`)) return
      if (!(await act('stage', () => api.gitStageAll(projectId)))) return
    }
    const ok = await act('commit', () => api.gitCommit(projectId, message.trim()), 'Committed.')
    if (ok) {
      markDone('committed')
      setMessage('')
      setSelected(null)
    }
  }

  async function writeMessage(): Promise<void> {
    if (staged.length === 0 && changes.length > 0) {
      if (!confirm('Claude describes staged changes. Stage all changes now?')) return
      await api.gitStageAll(projectId)
      await refresh()
    }
    setBusy('message')
    setNotice(null)
    try {
      setMessage(await api.gitCommitMessage(projectId))
    } catch (e) {
      setNotice({ tone: 'bad', text: errText(e) })
    } finally {
      setBusy(null)
    }
  }

  async function discard(f: GitFileChange): Promise<void> {
    const what = f.untracked ? `Delete the new file "${f.path}"?` : `Discard your changes to "${f.path}"? This can't be undone.`
    if (!confirm(what)) return
    if (selected?.path === f.path) setSelected(null)
    await act('discard', () => api.gitDiscard(projectId, [f.path]))
  }

  async function switchBranch(value: string): Promise<void> {
    if (value === '__new') return setNewBranch('') // shows the inline name field
    if (st?.files.length && !confirm('You have uncommitted changes. Git will carry them over to the other branch if it can. Switch anyway?')) return
    await act('switch', () => api.gitSwitch(projectId, value, false), `Switched to ${value}.`)
  }

  async function merge(): Promise<void> {
    if (!mi?.current || !mi.defaultBranch) return
    if (!confirm(`Merge ${mi.current} into ${mi.defaultBranch}?

Vibeloft switches to ${mi.defaultBranch}, brings it up to date, and merges your branch. If the two changed the same lines, nothing is changed and you stay on ${mi.current}.`)) return
    await act('merge', () => api.gitMergeIntoDefault(projectId), 'Merged.')
  }

  // ---------- what to do next ----------
  type Step = { tone: 'ok' | 'warn' | 'info'; text: string; short: string; action?: { label: string; run: () => void; primary?: boolean } }
  const steps: Step[] = []
  if (st?.isRepo) {
    const n = st.files.length
    const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`
    if (st.merging) {
      steps.push({
        tone: 'warn',
        short: 'finish the merge',
        text: 'A merge is in progress. Resolve the conflicted files (marked !), stage them, then commit. Or ask Claude Code in the Terminal to resolve them.',
        action: { label: 'Open Terminal', run: () => props.goTab('terminal') }
      })
    } else if (st.hasCommits && !st.branch) {
      steps.push({ tone: 'warn', short: 'pick a branch', text: "You're not on a branch (detached HEAD). Pick a branch above before committing." })
    }
    if (n > 0 && !st.merging) {
      steps.push({
        tone: 'warn',
        short: 'commit',
        text: `${plural(n, 'file')} changed and not saved in git yet. Write a message (or let Claude write it) and commit.`,
        action: { label: 'Commit…', run: () => messageBox.current?.focus(), primary: true }
      })
    }
    if (st.behind > 0) {
      steps.push({
        tone: 'warn',
        short: 'pull',
        text: `GitHub has ${plural(st.behind, 'newer commit')} that you don't have yet.`,
        action: { label: `Pull ${st.behind}`, run: () => void act('pull', () => api.gitPull(projectId), 'Pulled.'), primary: n === 0 }
      })
    }
    if (mi && mi.unmerged > 0 && mi.defaultBranch && !st.merging && !st.upstream) {
      steps.push({
        tone: 'info',
        short: `merge into ${mi.defaultBranch}`,
        text: `${plural(mi.unmerged, 'commit')} on ${mi.current} ${mi.unmerged === 1 ? "isn't" : "aren't"} in ${mi.defaultBranch} yet. Merge when this work is finished.`,
        action: { label: `Merge into ${mi.defaultBranch}`, run: () => void merge(), primary: steps.length === 0 }
      })
    }
    if (st.hasCommits && st.branch && st.hasRemote && !st.upstream) {
      steps.push({
        tone: 'warn',
        short: 'push',
        text: `Branch ${st.branch} isn't on GitHub yet.`,
        action: { label: 'Push', run: () => void act('push', () => api.gitPush(projectId), 'Pushed.'), primary: n === 0 }
      })
    } else if (st.ahead > 0) {
      steps.push({
        tone: 'warn',
        short: 'push',
        text: `${plural(st.ahead, 'commit')} saved on this computer but not on GitHub yet.`,
        action: { label: `Push ${st.ahead}`, run: () => void act('push', () => api.gitPush(projectId), 'Pushed.'), primary: n === 0 && st.behind === 0 }
      })
    }
    if (mi && mi.unmerged > 0 && mi.defaultBranch && !st.merging && st.upstream) {
      steps.push({
        tone: 'info',
        short: `merge into ${mi.defaultBranch}`,
        text: `${plural(mi.unmerged, 'commit')} on ${mi.current} ${mi.unmerged === 1 ? "isn't" : "aren't"} in ${mi.defaultBranch} yet. Merge when this work is finished.`,
        action: { label: `Merge into ${mi.defaultBranch}`, run: () => void merge(), primary: steps.length === 0 }
      })
    }
    if (steps.length === 0) {
      steps.push(
        st.hasCommits
          ? st.hasRemote
            ? { tone: 'ok', short: '', text: 'Everything is committed and on GitHub.' }
            : { tone: 'ok', short: '', text: 'Everything is committed. This project has no GitHub remote, so nothing to push.' }
          : { tone: 'info', short: '', text: 'No commits yet. Stage your files and make the first commit.' }
      )
    }
  }
  const next = steps[0]

  // ---------- render ----------
  if (!project.localPath) {
    return (
      <div className="empty">
        <h3>No local folder</h3>
        <p>Edit the project and choose its folder to use source control.</p>
      </div>
    )
  }
  if (st && !st.isRepo) {
    return (
      <div className="empty">
        <h3>Not a git repository</h3>
        <p>This folder isn't tracked by git yet. Start tracking it to see changes, commit and push.</p>
        <button className="btn primary" onClick={() => act('init', () => api.gitInit(projectId), 'Git repository created.')}>
          Initialize git
        </button>
      </div>
    )
  }

  const row = (f: GitFileChange, isStaged: boolean): ReactNode => {
    const l = letterFor(f, isStaged)
    const slash = f.path.lastIndexOf('/')
    const on = selected?.path === f.path && selected.staged === isStaged
    return (
      <div key={`${isStaged}-${f.path}`} className={`git-file ${on ? 'on' : ''}`} onClick={() => setSelected({ path: f.path, staged: isStaged })} title={f.path}>
        <span className="tree-name">
          {f.path.slice(slash + 1)}
          <span className="tree-path">{slash > 0 ? f.path.slice(0, slash) : ''}</span>
        </span>
        <span className="git-actions" onClick={(e) => e.stopPropagation()}>
          {!isStaged && (
            <button className="icon-btn" title={f.untracked ? 'Delete new file' : 'Discard changes'} onClick={() => discard(f)}>
              <Icon name="undo" size={14} />
            </button>
          )}
          {!isStaged && (
            <button className="icon-btn" title="Open in editor" onClick={() => (requestOpen(projectId, f.path), props.goTab('files'))}>
              <Icon name="edit" size={14} />
            </button>
          )}
          {isStaged ? (
            <button className="icon-btn" title="Unstage" onClick={() => act('unstage', () => api.gitUnstage(projectId, [f.path]))}>
              −
            </button>
          ) : (
            <button className="icon-btn" title="Stage" onClick={() => act('stage', () => api.gitStage(projectId, [f.path]))}>
              <Icon name="plus" size={15} />
            </button>
          )}
        </span>
        <span className={`git-letter ${l.cls}`} title={l.title}>
          {l.label}
        </span>
      </div>
    )
  }

  return (
    <div className="git-panel">
      <aside className="git-side">
        <RepoPicker projectId={projectId} className="repo-pick-panel" />
        {next && (
          <div className={`git-next ${next.tone}`}>
            <div className="git-next-text">
              {next.tone === 'ok' && <Icon name="check" size={14} />} {next.text}
              {steps.length > 1 && <span className="git-next-then"> Then: {steps.slice(1).map((x) => x.short).join(' → ')}.</span>}
            </div>
            {next.action && (
              <button className={`btn small-btn ${next.action.primary !== false ? 'primary' : ''}`} disabled={!!busy} onClick={next.action.run}>
                {next.action.label}
              </button>
            )}
          </div>
        )}
        <div className="git-branch">
          {newBranch === null ? (
            <select className="input" value={branches?.current ?? st?.branch ?? ''} onChange={(e) => switchBranch(e.target.value)} disabled={!!busy} title="Branch">
              {(branches?.local.length ? branches.local : [st?.branch ?? '']).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
              {branches?.remote.filter((r) => !branches.local.includes(r.slice(r.indexOf('/') + 1))).length ? (
                <optgroup label="Remote branches">
                  {branches.remote
                    .filter((r) => !branches.local.includes(r.slice(r.indexOf('/') + 1)))
                    .map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                </optgroup>
              ) : null}
              <option value="__new">+ New branch…</option>
            </select>
          ) : (
            <div className="row gap-s grow">
              <input
                className="input"
                autoFocus
                placeholder="new-branch-name"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value.replace(/\s+/g, '-'))}
                onKeyDown={async (e) => {
                  if (e.key === 'Escape') setNewBranch(null)
                  if (e.key === 'Enter' && newBranch.trim()) {
                    const name = newBranch.trim()
                    if (await act('switch', () => api.gitSwitch(projectId, name, true), `Created and switched to ${name}.`)) setNewBranch(null)
                  }
                }}
              />
              <button className="icon-btn" onClick={() => setNewBranch(null)} title="Cancel">
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          <button className="btn small-btn" disabled={!!busy} onClick={() => act('pull', () => api.gitPull(projectId), 'Pulled.')} title="Pull (fast-forward only)">
            <Icon name="arrowDown" size={14} /> Pull{st?.behind ? ` ${st.behind}` : ''}
          </button>
          <button
            className={`btn small-btn ${st?.ahead ? 'primary' : ''}`}
            disabled={!!busy || !st?.hasCommits}
            onClick={() => act('push', () => api.gitPush(projectId), 'Pushed.')}
            title={st?.upstream ? `Push to ${st.upstream}` : 'Push and set up the remote branch'}
          >
            <Icon name="arrowUp" size={14} /> Push{st?.ahead ? ` ${st.ahead}` : ''}
          </button>
        </div>

        <div className="git-commit">
          <textarea
            ref={messageBox}
            className="input"
            rows={3}
            placeholder={`Commit message (Ctrl+Enter to commit on ${st?.branch ?? 'this branch'})`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                commit()
              }
            }}
          />
          <div className="row gap-s">
            <button className="btn small-btn" disabled={!!busy || !st?.files.length} onClick={writeMessage} title="Claude reads the staged diff (.env files excluded) and writes a message">
              {busy !== 'message' && <Icon name="sparkle" size={14} />} {busy === 'message' ? 'Writing…' : 'Write with Claude'}
            </button>
            <div className="grow" />
            <button className="btn small-btn primary" disabled={!!busy || !st?.files.length} onClick={commit}>
              {busy === 'commit' ? 'Committing…' : staged.length ? `Commit ${staged.length}` : 'Commit all'}
            </button>
          </div>
        </div>

        {notice && (
          <div className={`notice ${notice.tone} git-notice`} onClick={() => setNotice(null)}>
            {notice.text}
          </div>
        )}
        {busy && busy !== 'message' && busy !== 'commit' && <div className="muted small pad">Working…</div>}

        <div className="git-lists">
          {staged.length > 0 && (
            <section>
              <div className="git-section-head">
                <span>Staged changes</span>
                <span className="count">{staged.length}</span>
                <button className="icon-btn" title="Unstage all" onClick={() => act('unstage', () => api.gitUnstage(projectId, staged.map((f) => f.path)))}>
                  −
                </button>
              </div>
              {staged.map((f) => row(f, true))}
            </section>
          )}
          <section>
            <div className="git-section-head">
              <span>Changes</span>
              <span className="count">{changes.length}</span>
              {changes.length > 0 && (
                <button className="icon-btn" title="Stage all" onClick={() => act('stage', () => api.gitStageAll(projectId))}>
                  <Icon name="plus" size={15} />
                </button>
              )}
            </div>
            {changes.map((f) => row(f, false))}
            {st && st.files.length === 0 && <p className="muted small pad">No changes. Everything is committed.</p>}
          </section>

          <section>
            <button className="git-section-head as-button" onClick={() => setShowLog((v) => !v)}>
              <span><Icon name={showLog ? 'chevronDown' : 'chevronRight'} size={12} /> Recent commits</span>
            </button>
            {showLog &&
              commits.map((c) => (
                <div key={c.hash} className="git-commit-row" title={`${c.hash} · ${c.author}`}>
                  <span className="git-commit-subject">{c.subject}</span>
                  <span className="muted small">
                    {c.author} · {relTime(c.date)}
                  </span>
                </div>
              ))}
            {showLog && commits.length === 0 && <p className="muted small pad">No commits yet.</p>}
          </section>
        </div>
      </aside>

      <section className="git-diff">
        {selected ? (
          <div className="file-bar">
            <div className="file-crumbs" title={selected.path}>
              <span className="last">{selected.path}</span>
              <span className="muted small file-meta">{selected.staged ? 'Staged vs last commit' : 'Your changes vs staged / last commit'}</span>
            </div>
            <div className="row gap-s">
              <button className="btn small-btn" onClick={() => setInline((v) => !v)}>
                {inline ? 'Side by side' : 'Inline'}
              </button>
              <button className="btn small-btn" onClick={() => (requestOpen(projectId, selected.path), props.goTab('files'))}>
                Open in editor
              </button>
            </div>
          </div>
        ) : null}
        <div className="editor-host" ref={diffHost} style={{ display: selected ? 'block' : 'none' }} />
        {!selected && (
          <div className="term-empty">
            <h3>Review changes</h3>
            <p className="muted">
              Click a changed file to see exactly what changed, side by side. Stage the files you want with +, write a message (or let Claude
              write it), then Commit and Push.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
