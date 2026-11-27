import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { SearchOptions, TextSearchFile } from '../../../shared/types'
import { api } from '../ui'

// Search inside every file of the project (Ctrl+Shift+F), with replace-all.
// .env files are never searched, so secrets don't show up in results.

const remembered = new Map<string, { query: string; replace: string; opts: SearchOptions }>()

export function SearchPane(props: { projectId: string; onOpen: (rel: string, line: number, col: number) => void }): ReactNode {
  const saved = remembered.get(props.projectId)
  const [query, setQuery] = useState(saved?.query ?? '')
  const [replace, setReplace] = useState(saved?.replace ?? '')
  const [showReplace, setShowReplace] = useState(false)
  const [opts, setOpts] = useState<SearchOptions>(saved?.opts ?? { caseSensitive: false, regex: false, wholeWord: false })
  const [results, setResults] = useState<TextSearchFile[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    remembered.set(props.projectId, { query, replace, opts })
  }, [query, replace, opts, props.projectId])

  useEffect(() => {
    if (!query) {
      setResults(null)
      setError(null)
      return
    }
    if (opts.regex) {
      try {
        new RegExp(query)
      } catch {
        setError('That regular expression is not valid.')
        return
      }
    }
    setError(null)
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        const r = await api.searchText(props.projectId, query, opts)
        setResults(r.results)
        setTruncated(r.truncated)
      } catch (e) {
        setError(String((e as Error).message))
      } finally {
        setBusy(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query, opts, props.projectId])

  const total = results?.reduce((n, f) => n + f.matches.length, 0) ?? 0

  async function replaceAll(): Promise<void> {
    if (!results?.length) return
    const files = results.map((r) => r.rel)
    if (!confirm(`Replace ${total} match${total === 1 ? '' : 'es'} in ${files.length} file${files.length === 1 ? '' : 's'} with "${replace}"?\n\nTip: commit first, so you can undo this in the Git tab.`)) return
    try {
      const changed = await api.replaceText(props.projectId, files, query, replace, opts)
      setNote(`Replaced in ${changed} file${changed === 1 ? '' : 's'}.`)
      const r = await api.searchText(props.projectId, query, opts)
      setResults(r.results)
    } catch (e) {
      setError(String((e as Error).message))
    }
  }

  const toggle = (k: keyof SearchOptions): void => setOpts((o) => ({ ...o, [k]: !o[k] }))

  return (
    <div className="search-pane">
      <div className="search-inputs">
        <div className="row gap-s">
          <button className="icon-btn" title={showReplace ? 'Hide replace' : 'Show replace'} onClick={() => setShowReplace((s) => !s)}>
            <Icon name={showReplace ? 'chevronDown' : 'chevronRight'} size={13} />
          </button>
          <div className="search-box">
            <input className="input" autoFocus placeholder="Search in files" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="search-flags">
              <button className={opts.caseSensitive ? 'on' : ''} title="Match case" onClick={() => toggle('caseSensitive')}>
                Aa
              </button>
              <button className={opts.wholeWord ? 'on' : ''} title="Whole word" onClick={() => toggle('wholeWord')}>
                ab
              </button>
              <button className={opts.regex ? 'on' : ''} title="Regular expression" onClick={() => toggle('regex')}>
                .*
              </button>
            </div>
          </div>
        </div>
        {showReplace && (
          <div className="row gap-s replace-row">
            <input className="input" placeholder="Replace with" value={replace} onChange={(e) => setReplace(e.target.value)} />
            <button className="btn small-btn" disabled={!results?.length} onClick={replaceAll} title="Replace in all files">
              Replace all
            </button>
          </div>
        )}
      </div>

      <div className="search-summary muted small">
        {error ? (
          <span className="bad-text">{error}</span>
        ) : busy ? (
          'Searching…'
        ) : results ? (
          `${total} result${total === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}${truncated ? ' (first 2,000 shown)' : ''}`
        ) : (
          'Type to search. .env files are skipped.'
        )}
        {note && <span className="ok-text"> · {note}</span>}
      </div>

      <div className="search-results">
        {results?.map((f) => {
          const open = !collapsed.has(f.rel)
          const slash = f.rel.lastIndexOf('/')
          return (
            <div key={f.rel}>
              <button
                className="search-file"
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c)
                    if (n.has(f.rel)) n.delete(f.rel)
                    else n.add(f.rel)
                    return n
                  })
                }
                title={f.rel}
              >
                <span className="tree-icon"><Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} /></span>
                <span className="tree-name">{f.rel.slice(slash + 1)}</span>
                <span className="tree-path">{slash > 0 ? f.rel.slice(0, slash) : ''}</span>
                <span className="count">{f.matches.length}</span>
              </button>
              {open &&
                f.matches.map((m, i) => {
                  const start = Math.max(0, m.col - 1 - 12)
                  const before = m.text.slice(start, m.col - 1)
                  const hit = m.text.slice(m.col - 1, m.col - 1 + m.length)
                  const after = m.text.slice(m.col - 1 + m.length, m.col - 1 + m.length + 80)
                  return (
                    <button key={i} className="search-hit" onClick={() => props.onOpen(f.rel, m.line, m.col)} title={`Line ${m.line}`}>
                      <span className="search-line">{m.line}</span>
                      <span className="search-text">
                        {start > 0 && '…'}
                        {before.trimStart()}
                        <mark>{hit}</mark>
                        {after}
                      </span>
                    </button>
                  )
                })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
