import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../../icons'
import type { Checkpoint, CheckpointChange } from '../../../../shared/types'
import { requestOpen } from '../../filesBridge'
import { onCheckpointsChanged } from '../../termStore'
import { markDone } from '../../help/progress'
import { api, relTime } from '../../ui'

const DiffModal = lazy(() => import('./DiffModal').then((m) => ({ default: m.DiffModal })))

// Live list of files that changed, next to the terminal. By default it shows
// what changed since your last prompt to Claude; you can also compare with the
// last commit or any earlier checkpoint.

export function ChangesPanel(props: {
  projectId: string
  theme: 'dark' | 'light'
  /** Checkpoint to compare with ('' = the latest one). */
  base: string
  setBase: (b: string) => void
  onClose: () => void
  goFiles: () => void
}): ReactNode {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [changes, setChanges] = useState<CheckpointChange[] | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveBase = props.base || checkpoints[0]?.id || 'HEAD'
  const baseLabel =
    effectiveBase === 'HEAD'
      ? 'last commit'
      : (() => {
          const c = checkpoints.find((x) => x.id === effectiveBase)
          return c ? `before "${c.label.replace(/^Before: /, '')}"` : 'checkpoint'
        })()

  const loadCheckpoints = useCallback(() => {
    api.checkpointList(props.projectId).then(setCheckpoints, () => setCheckpoints([]))
  }, [props.projectId])

  const refresh = useCallback(() => {
    api.checkpointChanges(props.projectId, effectiveBase).then(
      (c) => {
        setChanges(c)
        setError(null)
      },
      (e) => setError(String(e?.message ?? e))
    )
  }, [props.projectId, effectiveBase])

  useEffect(loadCheckpoints, [loadCheckpoints])
  useEffect(() => markDone('changesViewed'), [])
  useEffect(() => onCheckpointsChanged((id) => id === props.projectId && loadCheckpoints()), [props.projectId, loadCheckpoints])
  useEffect(refresh, [refresh])
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const off = api.onFilesChanged((e) => {
      if (e.projectId !== props.projectId) return
      if (t) clearTimeout(t)
      t = setTimeout(refresh, 700)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [props.projectId, refresh])

  const letter = (s: CheckpointChange['status']): string => (s === 'added' ? 'A' : s === 'deleted' ? 'D' : 'M')

  return (
    <aside className="changes-panel">
      <div className="changes-head">
        <b>Changed files</b>
        <button className="icon-btn" title="Hide" onClick={props.onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <select className="input changes-base" value={props.base} onChange={(e) => props.setBase(e.target.value)} title="Compare with">
        <option value="">Since my last prompt{checkpoints[0] ? ` (${relTime(checkpoints[0].at)})` : ''}</option>
        <option value="HEAD">Since the last commit</option>
        {checkpoints.slice(1).map((c) => (
          <option key={c.id} value={c.id}>
            {relTime(c.at)} · {c.label.replace(/^Before: /, '').slice(0, 50)}
          </option>
        ))}
      </select>
      {error && <div className="notice bad small">{error}</div>}
      <div className="changes-list">
        {changes === null && <div className="muted small changes-empty">Checking…</div>}
        {changes?.length === 0 && (
          <div className="muted small changes-empty">
            {checkpoints.length === 0 && !props.base
              ? 'Send Claude a prompt and the files it changes appear here.'
              : 'No files changed.'}
          </div>
        )}
        {changes?.map((c) => {
          const slash = c.path.lastIndexOf('/')
          return (
            <button key={c.path} className="changes-file" onClick={() => setDiff(c.path)} title={`${c.path}: click to see the diff`}>
              <span className="tree-name">
                {c.path.slice(slash + 1)}
                <span className="tree-path">{slash > 0 ? c.path.slice(0, slash) : ''}</span>
              </span>
              <span className={`git-letter ${c.status === 'added' ? 'add' : c.status === 'deleted' ? 'del' : 'mod'}`}>{letter(c.status)}</span>
            </button>
          )
        })}
      </div>
      {diff && (
        <Suspense fallback={null}>
          <DiffModal
            projectId={props.projectId}
            base={effectiveBase}
            baseLabel={baseLabel}
            path={diff}
            theme={props.theme}
            onClose={() => setDiff(null)}
            onOpenFile={() => {
              requestOpen(props.projectId, diff)
              setDiff(null)
              props.goFiles()
            }}
          />
        </Suspense>
      )}
    </aside>
  )
}
