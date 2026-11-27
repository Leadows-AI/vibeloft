import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Checkpoint, GitStatus } from '../../../../shared/types'
import { onCheckpointsChanged } from '../../termStore'
import { markDone } from '../../help/progress'
import { api, relTime } from '../../ui'
import { Icon } from '../../icons'
import { Dropdown } from './Dropdown'
import { RepoPicker, onRepoPicked } from '../RepoPicker'

// The footer under the terminal: branch, changes, ahead/behind, what Claude
// just changed, Claude's meters, one-click Commit & Push (Claude writes the
// message) and Undo to a checkpoint.

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function GitBar(props: {
  projectId: string
  commitOpen: boolean
  setCommitOpen: (open: boolean) => void
  onShowChanges: () => void
  goGit: () => void
  /** Called when nothing is left to commit (the turn summary is then done). */
  onClean: () => void
  /** Ask before undoing; returns true when the undo went ahead. */
  onUndo: (cp: Checkpoint) => Promise<boolean>
  /** What Claude changed in its last reply. */
  turn?: ReactNode
  /** Claude's model, context and usage meters. */
  meters?: ReactNode
}): ReactNode {
  const [st, setSt] = useState<GitStatus | null>(null)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  const refresh = useCallback(() => {
    api.gitStatus(props.projectId).then(setSt, () => setSt(null))
  }, [props.projectId])
  const loadCheckpoints = useCallback(() => {
    api.checkpointList(props.projectId).then(setCheckpoints, () => setCheckpoints([]))
  }, [props.projectId])

  useEffect(() => {
    refresh()
    loadCheckpoints()
  }, [refresh, loadCheckpoints])
  useEffect(() => onCheckpointsChanged((id) => id === props.projectId && loadCheckpoints()), [props.projectId, loadCheckpoints])
  // Another repository picked: a commit message written for the old one doesn't fit.
  useEffect(
    () =>
      onRepoPicked(props.projectId, () => {
        props.setCommitOpen(false)
        refresh()
      }),
    [props.projectId, refresh]
  )
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const off = api.onFilesChanged((e) => {
      if (e.projectId !== props.projectId) return
      if (t) clearTimeout(t)
      t = setTimeout(refresh, 400)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [props.projectId, refresh])

  // Committed (here, in the Git tab, or by Claude in the terminal): nothing left to review.
  const clean = !!st?.isRepo && st.files.length === 0
  useEffect(() => {
    if (clean) props.onClean()
  }, [clean])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), notice.tone === 'ok' ? 5000 : 12000)
    return () => clearTimeout(t)
  }, [notice])

  async function run(label: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    setBusy(label)
    try {
      await fn()
      setNotice({ tone: 'ok', text: ok })
      return true
    } catch (e) {
      setNotice({ tone: 'bad', text: errText(e) })
      return false
    } finally {
      setBusy(null)
      refresh()
    }
  }

  if (!st) return null
  if (!st.isRepo) {
    return (
      <div className="git-bar">
        <span className="muted small">Not a git repository. Undo checkpoints and Commit & Push need git.</span>
        <div className="grow" />
        {props.meters}
        <button className="btn small-btn" onClick={props.goGit}>
          Set up git…
        </button>
      </div>
    )
  }

  const n = st.files.length
  const canPushNew = st.hasCommits && !!st.branch && !!st.hasRemote && !st.upstream

  return (
    <div className="git-bar">
      <RepoPicker projectId={props.projectId} className="repo-pick-bar" />
      <span className="git-bar-branch" title="Current branch">
        <Icon name="branch" size={14} /> {st.branch ?? 'detached'}
      </span>
      <button className={`git-bar-count ${n ? 'dirty' : ''}`} onClick={props.onShowChanges} title="Show changed files">
        {n ? `${n} change${n === 1 ? '' : 's'}` : 'No changes'}
      </button>
      {st.ahead > 0 && <span className="git-bar-sync" title={`${st.ahead} commit(s) not on GitHub yet`}><Icon name="arrowUp" size={12} />{st.ahead}</span>}
      {st.behind > 0 && <span className="git-bar-sync" title={`${st.behind} new commit(s) on GitHub`}><Icon name="arrowDown" size={12} />{st.behind}</span>}
      {notice && (
        <span className={`git-bar-notice ${notice.tone}`} onClick={() => setNotice(null)} title={notice.text}>
          {notice.text}
        </span>
      )}
      {props.turn}
      <div className="grow" />
      {props.meters}

      <Dropdown
        label={
          <>
            <Icon name="undo" size={15} /> Undo
          </>
        } title="Put files back the way they were before a Claude prompt" up width={400} onOpen={loadCheckpoints}>
        {(close) => (
          <div className="undo-menu">
            <div className="menu-label">Put files back as they were…</div>
            {checkpoints.length === 0 && (
              <div className="muted small history-empty">No checkpoints yet. Vibeloft saves one each time you send Claude Code a prompt.</div>
            )}
            <div className="undo-list">
              {checkpoints.map((c) => (
                <button
                  key={c.id}
                  role="menuitem"
                  onClick={async () => {
                    close()
                    if (await props.onUndo(c)) {
                      loadCheckpoints()
                      refresh()
                    }
                  }}
                >
                  <b>{c.label}</b>
                  <span>{relTime(c.at)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Dropdown>
      {st.behind > 0 && (
        <button className="btn small-btn" disabled={!!busy} onClick={() => run('pull', () => api.gitPull(props.projectId), 'Pulled.')}>
          <Icon name="arrowDown" size={14} /> Pull {st.behind}
        </button>
      )}
      {n === 0 && (st.ahead > 0 || canPushNew) && (
        <button className="btn small-btn primary" disabled={!!busy} onClick={() => run('push', () => api.gitPush(props.projectId), 'Pushed to GitHub.')}>
          {busy !== 'push' && <Icon name="arrowUp" size={14} />} {busy === 'push' ? 'Pushing…' : `Push${st.ahead ? ` ${st.ahead}` : ''}`}
        </button>
      )}
      {n > 0 && (
        <button className="btn small-btn primary" disabled={!!busy} onClick={() => props.setCommitOpen(!props.commitOpen)}>
          <Icon name="sparkle" size={15} /> Commit{st.hasRemote ? ' & Push' : ''}
        </button>
      )}
      <button className="icon-btn" title="Open the Git tab" aria-label="Open the Git tab" onClick={props.goGit}>
        <Icon name="branch" size={16} />
      </button>

      {props.commitOpen && n > 0 && (
        <CommitPopover
          projectId={props.projectId}
          files={n}
          canPush={!!st.hasRemote && !!st.branch}
          onClose={() => props.setCommitOpen(false)}
          onDone={(text) => {
            props.setCommitOpen(false)
            setNotice({ tone: 'ok', text })
            refresh()
          }}
          onError={(text) => setNotice({ tone: 'bad', text })}
        />
      )}
    </div>
  )
}

/** Stage everything, let Claude write the message, then commit (and push). */
function CommitPopover(props: {
  projectId: string
  files: number
  canPush: boolean
  onClose: () => void
  onDone: (text: string) => void
  onError: (text: string) => void
}): ReactNode {
  const [message, setMessage] = useState('')
  const [writing, setWriting] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await api.gitStageAll(props.projectId)
        const m = await api.gitCommitMessage(props.projectId)
        if (!cancelled) setMessage((cur) => cur || m)
      } catch (e) {
        if (!cancelled) props.onError(`Claude couldn't write the message: ${errText(e)}`)
      } finally {
        if (!cancelled) {
          setWriting(false)
          box.current?.focus()
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.projectId])

  async function go(push: boolean): Promise<void> {
    if (!message.trim()) return
    setBusy(push ? 'push' : 'commit')
    try {
      await api.gitStageAll(props.projectId)
      const hash = await api.gitCommit(props.projectId, message.trim())
      if (push) {
        try {
          await api.gitPush(props.projectId)
        } catch (e) {
          props.onError(`Committed ${hash}, but the push failed: ${errText(e)}`)
          props.onClose()
          return
        }
      }
      markDone('committed')
      props.onDone(push ? `Committed ${hash} and pushed to GitHub.` : `Committed ${hash}.`)
    } catch (e) {
      props.onError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="commit-pop" role="dialog" aria-label="Commit">
      <div className="commit-pop-head">
        <b>
          Commit {props.files} file{props.files === 1 ? '' : 's'}
        </b>
        <button className="icon-btn" onClick={props.onClose} title="Close">
          <Icon name="close" size={14} />
        </button>
      </div>
      <textarea
        ref={box}
        className="input"
        rows={4}
        placeholder={writing ? 'Claude is writing the commit message…' : 'Commit message'}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void go(props.canPush)
          if (e.key === 'Escape') props.onClose()
        }}
      />
      <div className="row gap-s">
        <span className="muted small">{writing ? 'Claude is writing the message…' : 'All changes are included. Ctrl+Enter to commit.'}</span>
        <div className="grow" />
        {props.canPush && (
          <button className="btn small-btn" disabled={!!busy || !message.trim()} onClick={() => go(false)}>
            Commit only
          </button>
        )}
        <button className="btn small-btn primary" disabled={!!busy || !message.trim()} onClick={() => go(props.canPush)}>
          {busy === 'push' ? 'Pushing…' : busy === 'commit' ? 'Committing…' : props.canPush ? 'Commit & Push' : 'Commit'}
        </button>
      </div>
    </div>
  )
}
