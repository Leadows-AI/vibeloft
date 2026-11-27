import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../ui'

// Ctrl+P: type part of a file name to jump to it. Matching is fuzzy, so
// "chkts" finds "routes/checkout.ts". The file list is cached per project and
// refreshed when files change on disk.

const cache = new Map<string, Promise<string[]>>()
const watching = new Set<string>()

function allFiles(projectId: string): Promise<string[]> {
  let list = cache.get(projectId)
  if (!list) {
    list = api.listAllFiles(projectId).catch(() => [])
    cache.set(projectId, list)
  }
  if (!watching.has(projectId)) {
    watching.add(projectId)
    api.onFilesChanged((e) => {
      if (e.projectId === projectId && e.paths.some((p) => !p.startsWith('.git/'))) cache.delete(projectId)
    })
  }
  return list
}

/** Score a path against the query; higher is better, -1 means no match. */
function score(path: string, q: string): number {
  const p = path.toLowerCase()
  const name = p.slice(p.lastIndexOf('/') + 1)
  if (name === q) return 1000
  if (name.startsWith(q)) return 800 - name.length
  if (name.includes(q)) return 600 - name.length
  if (p.includes(q)) return 400 - p.length
  // In-order characters (fuzzy), favouring matches in the file name.
  let i = 0
  let s = 200
  for (const ch of q) {
    const j = p.indexOf(ch, i)
    if (j < 0) return -1
    s -= j - i
    i = j + 1
  }
  return s - p.length / 10
}

export function QuickOpen(props: { projectId: string; onClose: () => void; onPick: (rel: string) => void }): ReactNode {
  const [files, setFiles] = useState<string[] | null>(null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    allFiles(props.projectId).then(setFiles)
  }, [props.projectId])

  const matches = useMemo(() => {
    if (!files) return []
    const query = q.trim().toLowerCase().replace(/\\/g, '/')
    if (!query) return files.slice(0, 50)
    return files
      .map((f) => ({ f, s: score(f, query) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.f)
  }, [files, q])

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.qo-row.on')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  return (
    <div className="modal-backdrop qo-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="quick-open" role="dialog" aria-label="Go to file">
        <input
          className="input"
          autoFocus
          placeholder={files ? `Go to file… (${files.length} files)` : 'Loading files…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') props.onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, matches.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter' && matches[sel]) props.onPick(matches[sel])
          }}
        />
        <div className="qo-list" ref={listRef}>
          {matches.map((f, i) => {
            const slash = f.lastIndexOf('/')
            return (
              <button key={f} className={`qo-row ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => props.onPick(f)}>
                <span className="qo-name">{f.slice(slash + 1)}</span>
                <span className="qo-dir">{slash > 0 ? f.slice(0, slash) : ''}</span>
              </button>
            )
          })}
          {files && matches.length === 0 && <p className="muted small pad">No matching files.</p>}
        </div>
      </div>
    </div>
  )
}
