import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { TreeIcon } from '../fileIcons'
import { Icon } from '../icons'
import type { FileEntry } from '../../../shared/types'
import type { AppCtx } from '../App'
import { monaco, monoOptions, setEditorTheme } from '../monaco'
import { takeRequests } from '../filesBridge'
import { canFormat, formatCode, projectPrettier, resetPrettierConfig } from '../prettier'
import { addSubproject, projectAt } from '../subproject'
import { api, Field, Modal } from '../ui'
import type { AskClaude, ProjectTab } from './ProjectView'
import { QuickOpen } from './QuickOpen'
import { SearchPane } from './SearchPane'

// The Files tab: explorer + search on the left, a Monaco editor with tabs on
// the right. Open files, unsaved edits and undo history live outside React, so
// they survive switching tabs and projects while the app runs.

type TabKind = 'text' | 'image' | 'binary' | 'too-large' | 'env'

interface EditorTab {
  rel: string
  kind: TabKind
  size: number
  dataUrl?: string
  model?: monaco.editor.ITextModel
  savedVersion?: number
  modified?: number
  viewState?: monaco.editor.ICodeEditorViewState | null
}

interface Session {
  tabs: EditorTab[]
  active: string | null
  expanded: Set<string>
}

const sessions = new Map<string, Session>()
function session(projectId: string): Session {
  let s = sessions.get(projectId)
  if (!s) sessions.set(projectId, (s = { tabs: [], active: null, expanded: new Set() }))
  return s
}

const isEnvName = (name: string): boolean => name === '.env' || name.startsWith('.env.') || name.endsWith('.env')
const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const isDirty = (t: EditorTab): boolean => !!t.model && t.model.getAlternativeVersionId() !== t.savedVersion
const errText = (e: unknown): string => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

// ---------- unsaved-changes tracking (used by the close-window warning) ----------

function dirtyTabs(): { projectId: string; tab: EditorTab }[] {
  const out: { projectId: string; tab: EditorTab }[] = []
  for (const [projectId, s] of sessions) for (const tab of s.tabs) if (isDirty(tab)) out.push({ projectId, tab })
  return out
}

let reportTimer: ReturnType<typeof setTimeout> | null = null
function reportDirty(): void {
  if (reportTimer) clearTimeout(reportTimer)
  reportTimer = setTimeout(() => api.setDirtyCount(dirtyTabs().length), 100)
}

async function writeTab(projectId: string, t: EditorTab, force = false): Promise<void> {
  if (!t.model) return
  const version = t.model.getAlternativeVersionId()
  t.modified = await api.writeFile(projectId, t.rel, t.model.getValue(), force ? -1 : t.modified!)
  t.savedVersion = version
  reportDirty()
}

api.onSaveAllRequest(async () => {
  let ok = true
  for (const { projectId, tab } of dirtyTabs()) {
    try {
      await writeTab(projectId, tab)
    } catch {
      ok = false
    }
  }
  return ok
})


// ---------- component ----------

type Dialog =
  | { kind: 'new'; type: 'file' | 'dir'; dir: string }
  | { kind: 'rename'; rel: string }
  | null

export function FilesPanel(props: { ctx: AppCtx; projectId: string; ask: AskClaude; goTab: (t: ProjectTab) => void }): ReactNode {
  const { projectId, ctx } = props
  const project = ctx.db.projects.find((p) => p.id === projectId)!
  const s = session(projectId)
  const [, rerender] = useReducer((x: number) => x + 1, 0)

  const [mode, setMode] = useState<'explorer' | 'search'>('explorer')
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map())
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const revealAt = useRef<{ rel: string; line: number; col: number } | null>(null)
  const childrenRef = useRef(children)
  childrenRef.current = children

  const active = s.tabs.find((t) => t.rel === s.active) ?? null

  // ---------- tree ----------
  const loadDir = useCallback(
    async (rel: string) => {
      try {
        const list = await api.listDir(projectId, rel)
        setChildren((m) => new Map(m).set(rel, list))
      } catch {
        setChildren((m) => {
          const n = new Map(m)
          n.delete(rel)
          return n
        })
      }
    },
    [projectId]
  )

  const refreshTree = useCallback(async () => {
    await loadDir('')
    for (const rel of s.expanded) await loadDir(rel)
  }, [loadDir])

  useEffect(() => {
    if (project.localPath) refreshTree()
  }, [projectId])

  // Files changed on disk (Claude, a dev server, git): refresh the tree and open files.
  useEffect(() => {
    return api.onFilesChanged((e) => {
      if (e.projectId !== projectId) return
      const dirs = new Set(e.paths.filter((p) => !p.startsWith('.git/')).map(parentOf))
      for (const d of dirs) if (childrenRef.current.has(d)) loadDir(d)
      if (e.paths.some((p) => /(^|\/)(\.prettierrc[^/]*|package\.json|prettier\.config\.[cm]?js)$/.test(p))) resetPrettierConfig(projectId)
      for (const t of s.tabs) if (e.paths.includes(t.rel)) syncFromDisk(t)
    })
  }, [projectId, loadDir])

  useEffect(() => {
    const q = query.trim()
    if (!q) return setResults(null)
    const t = setTimeout(() => api.findFiles(projectId, q).then(setResults), 200)
    return () => clearTimeout(t)
  }, [query, projectId])

  function toggleDir(e: FileEntry): void {
    if (s.expanded.has(e.rel)) s.expanded.delete(e.rel)
    else {
      s.expanded.add(e.rel)
      if (!children.has(e.rel)) loadDir(e.rel)
    }
    rerender()
  }

  // ---------- editor ----------
  useEffect(() => {
    setEditorTheme(ctx.theme)
  }, [ctx.theme])

  useEffect(() => {
    if (!host.current) return
    const editor = monaco.editor.create(host.current, {
      model: null,
      automaticLayout: true,
      ...monoOptions(),
      lineHeight: 1.54, // a multiple of the font size: 20px at 13px
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      padding: { top: 8 },
      bracketPairColorization: { enabled: true },
      fixedOverflowWidgets: true
    })
    editorRef.current = editor
    editor.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }))
    return () => {
      const t = session(projectId).tabs.find((x) => x.model && x.model === editor.getModel())
      if (t) t.viewState = editor.saveViewState()
      editor.dispose()
      editorRef.current = null
    }
  }, [projectId])

  // Requests from other tabs: Git's "Open in editor", Ctrl+P pressed elsewhere.
  useEffect(() => {
    const r = takeRequests(projectId)
    if (r.open) openFile(r.open.rel, r.open.line, r.open.col)
    if (r.quickOpen) setQuickOpen(true)
  })

  // Show the active tab's file in the editor.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (active?.model) {
      if (editor.getModel() !== active.model) {
        const prev = s.tabs.find((x) => x.model && x.model === editor.getModel())
        if (prev) prev.viewState = editor.saveViewState()
        editor.setModel(active.model)
        if (active.viewState) editor.restoreViewState(active.viewState)
      }
      editor.focus()
      jumpIfShown()
      syncFromDisk(active)
    } else if (editor.getModel()) {
      editor.setModel(null)
    }
  }, [active?.rel, active?.model])

  // Editor shortcuts: save, format, quick open. Re-bound each render so they act on the current tab.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const ds = [
      editor.addAction({ id: 'vibeloft.save', label: 'Save file', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => void save() }),
      editor.addAction({
        id: 'vibeloft.format',
        label: 'Format document (Prettier)',
        keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
        contextMenuGroupId: '1_modification',
        run: () => void formatActive()
      }),
      editor.addAction({ id: 'vibeloft.quickOpen', label: 'Go to file…', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP], run: () => setQuickOpen(true) }),
      editor.addAction({
        id: 'vibeloft.searchFiles',
        label: 'Search in all files',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
        run: () => setMode('search')
      })
    ]
    return () => ds.forEach((d) => d.dispose())
  })

  // The same shortcuts when the editor doesn't have focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'p' && !e.shiftKey) {
        e.preventDefault()
        setQuickOpen(true)
      } else if (k === 'f' && e.shiftKey) {
        e.preventDefault()
        setMode('search')
      } else if (k === 's' && !document.activeElement?.closest('.monaco-editor')) {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Re-check the open file when the window regains focus.
  useEffect(() => {
    const onFocus = (): void => {
      if (active) syncFromDisk(active)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  })

  async function openFile(rel: string, line?: number, col?: number): Promise<void> {
    setError(null)
    setConflict(null)
    const existing = s.tabs.find((t) => t.rel === rel)
    if (!existing) {
      const name = rel.split('/').pop()!
      let tab: EditorTab
      if (isEnvName(name)) tab = { rel, kind: 'env', size: 0 }
      else {
        try {
          const c = await api.readFile(projectId, rel)
          if (c.kind === 'text') {
            const uri = monaco.Uri.from({ scheme: 'file', path: `/${projectId}/${rel}` })
            const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(c.text, undefined, uri)
            model.onDidChangeContent(() => {
              reportDirty()
              rerender()
            })
            tab = { rel, kind: 'text', size: c.size, model, savedVersion: model.getAlternativeVersionId(), modified: c.modified }
          } else if (c.kind === 'image') tab = { rel, kind: 'image', size: c.size, dataUrl: c.dataUrl }
          else tab = { rel, kind: c.kind, size: c.size }
        } catch (e) {
          return setError(errText(e))
        }
      }
      s.tabs.push(tab)
    }
    s.active = rel
    rerender()
    if (line) {
      revealAt.current = { rel, line, col: col ?? 1 }
      jumpIfShown()
    }
  }

  /** Jump to a requested line once that file is the one in the editor. */
  function jumpIfShown(): void {
    const target = revealAt.current
    const ed = editorRef.current
    if (!target || !ed) return
    const t = s.tabs.find((x) => x.rel === target.rel)
    if (!t?.model || ed.getModel() !== t.model) return
    revealAt.current = null
    ed.setSelection(new monaco.Range(target.line, target.col, target.line, target.col))
    ed.revealLineInCenter(target.line)
    ed.focus()
  }

  /** If the file changed on disk and has no unsaved edits here, load the new version (undo still works). */
  async function syncFromDisk(t: EditorTab): Promise<void> {
    if (t.kind !== 'text' || !t.model || isDirty(t)) return
    try {
      const c = await api.readFile(projectId, t.rel)
      if (c.kind !== 'text') return
      if (c.modified === t.modified || c.text === t.model.getValue()) {
        t.modified = c.modified
        return
      }
      t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: c.text }], () => null)
      t.savedVersion = t.model.getAlternativeVersionId()
      t.modified = c.modified
      reportDirty()
      rerender()
    } catch {
      /* deleted or unreadable: leave the tab as it is */
    }
  }

  async function shouldFormatOnSave(rel: string): Promise<boolean> {
    if (!canFormat(rel)) return false
    const pref = ctx.db.settings.formatOnSave ?? 'auto'
    if (pref === 'off') return false
    if (pref === 'always') return true
    return (await projectPrettier(projectId)).found
  }

  /** Replace the model's text through an edit, so Ctrl+Z can undo the formatting. */
  function applyText(t: EditorTab, text: string): void {
    if (!t.model || text === t.model.getValue()) return
    const ed = editorRef.current
    const view = ed && ed.getModel() === t.model ? ed.saveViewState() : null
    t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text }], () => null)
    if (ed && view) ed.restoreViewState(view)
  }

  async function formatActive(): Promise<void> {
    const t = s.tabs.find((x) => x.rel === s.active)
    if (!t?.model) return
    if (!canFormat(t.rel)) return flash('Prettier does not support this file type.')
    try {
      applyText(t, await formatCode(projectId, t.rel, t.model.getValue()))
      flash('Formatted')
    } catch (e) {
      flash(`Could not format: ${String((e as Error).message).split('\n')[0]}`)
    }
  }

  function flash(msg: string): void {
    setNote(msg)
    setTimeout(() => setNote((n) => (n === msg ? null : n)), 2500)
  }

  async function save(force = false): Promise<void> {
    const t = s.tabs.find((x) => x.rel === s.active)
    if (!t?.model || (!isDirty(t) && !force)) return
    if (!force && (await shouldFormatOnSave(t.rel))) {
      try {
        applyText(t, await formatCode(projectId, t.rel, t.model.getValue()))
      } catch {
        /* a syntax error stops formatting; still save what the user wrote */
      }
    }
    try {
      await writeTab(projectId, t, force)
      setConflict(null)
      rerender()
    } catch (e) {
      setConflict(errText(e))
    }
  }

  async function reloadFromDisk(): Promise<void> {
    const t = s.tabs.find((x) => x.rel === s.active)
    if (!t?.model) return
    const c = await api.readFile(projectId, t.rel)
    if (c.kind !== 'text') return
    t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: c.text }], () => null)
    t.savedVersion = t.model.getAlternativeVersionId()
    t.modified = c.modified
    setConflict(null)
    reportDirty()
    rerender()
  }

  function closeTab(rel: string, ask = true): void {
    const i = s.tabs.findIndex((t) => t.rel === rel)
    if (i < 0) return
    const t = s.tabs[i]
    if (ask && isDirty(t) && !confirm(`"${rel.split('/').pop()}" has unsaved changes. Close it and lose them?`)) return
    if (editorRef.current && t.model && editorRef.current.getModel() === t.model) editorRef.current.setModel(null)
    t.model?.dispose()
    s.tabs.splice(i, 1)
    if (s.active === rel) s.active = s.tabs[i]?.rel ?? s.tabs[i - 1]?.rel ?? null
    setConflict(null)
    reportDirty()
    rerender()
  }

  // ---------- create / rename / delete ----------

  /** Expand every folder above a path so it's visible in the tree. */
  async function reveal(rel: string): Promise<void> {
    const parts = rel.split('/')
    let dir = ''
    await loadDir('')
    for (const part of parts.slice(0, -1)) {
      dir = dir ? `${dir}/${part}` : part
      s.expanded.add(dir)
      await loadDir(dir)
    }
    rerender()
  }

  async function createEntry(name: string, type: 'file' | 'dir', dir: string): Promise<void> {
    const rel = dir ? `${dir}/${name}` : name
    await api.createEntry(projectId, rel, type)
    await reveal(type === 'dir' ? `${rel}/x` : rel)
    if (type === 'file') openFile(rel)
  }

  async function renameEntry(from: string, toName: string): Promise<void> {
    const to = parentOf(from) ? `${parentOf(from)}/${toName}` : toName
    if (to === from) return
    const affected = s.tabs.filter((t) => t.rel === from || t.rel.startsWith(`${from}/`))
    if (affected.some(isDirty)) throw new Error('Save or close the open files inside it first.')
    await api.renameEntry(projectId, from, to)
    const wasActive = s.active
    for (const t of affected) closeTab(t.rel, false)
    if (s.expanded.delete(from)) s.expanded.add(to)
    await loadDir(parentOf(from))
    await reveal(to)
    if (wasActive && affected.some((t) => t.rel === wasActive)) openFile(to + wasActive.slice(from.length))
  }

  async function deleteEntry(e: FileEntry): Promise<void> {
    const what = e.type === 'dir' ? `the folder "${e.rel}" and everything in it` : `"${e.rel}"`
    if (!confirm(`Move ${what} to the ${api.platform === 'darwin' ? 'Trash' : 'Recycle Bin'}?`)) return
    try {
      await api.deleteEntry(projectId, e.rel)
      for (const t of s.tabs.filter((t) => t.rel === e.rel || t.rel.startsWith(`${e.rel}/`))) closeTab(t.rel, false)
      await loadDir(parentOf(e.rel))
    } catch (err) {
      setError(errText(err))
    }
  }

  // ---------- render ----------
  function onContext(ev: React.MouseEvent, entry: FileEntry | null): void {
    ev.preventDefault()
    ev.stopPropagation()
    setMenu({ x: ev.clientX, y: ev.clientY, entry })
  }

  function renderTree(rel: string, depth: number): ReactNode {
    const list = children.get(rel)
    if (!list) return depth === 0 ? <p className="muted small pad">Loading…</p> : null
    if (list.length === 0) return <div className="tree-empty" style={{ paddingLeft: 12 + depth * 14 }}>empty</div>
    return list.map((e) => {
      const open = s.expanded.has(e.rel)
      const dirty = s.tabs.some((t) => t.rel === e.rel && isDirty(t))
      return (
        <div key={e.rel}>
          <button
            className={`tree-row ${s.active === e.rel ? 'on' : ''} ${e.heavy ? 'heavy' : ''} ${e.type}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => (e.type === 'dir' ? toggleDir(e) : openFile(e.rel))}
            onContextMenu={(ev) => onContext(ev, e)}
            draggable
            onDragStart={(ev) => {
              // Drop onto the Terminal to type this path.
              ev.dataTransfer.setData('text/vibeloft-path', e.rel)
              ev.dataTransfer.setData('text/plain', e.rel)
              ev.dataTransfer.effectAllowed = 'copy'
            }}
            title={e.heavy ? `${e.rel} (generated or dependency folder)` : e.rel}
          >
            <TreeIcon name={e.name} type={e.type} open={open} env={e.env} />
            <span className="tree-name">{e.name}</span>
            {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          </button>
          {e.type === 'dir' && open && renderTree(e.rel, depth + 1)}
        </div>
      )
    })
  }

  if (!project.localPath) {
    return (
      <div className="empty">
        <h3>No local folder</h3>
        <p>Edit the project and choose its folder to browse its files.</p>
      </div>
    )
  }

  const name = active?.rel.split('/').pop() ?? ''
  const dirty = active ? isDirty(active) : false
  const menuDir = menu?.entry ? (menu.entry.type === 'dir' ? menu.entry.rel : parentOf(menu.entry.rel)) : ''

  return (
    <div className="files-panel" onClick={() => menu && setMenu(null)}>
      <aside className="file-tree">
        <div className="side-switch" role="tablist">
          <button className={mode === 'explorer' ? 'on' : ''} onClick={() => setMode('explorer')} title="Explorer">
            Explorer
          </button>
          <button className={mode === 'search' ? 'on' : ''} onClick={() => setMode('search')} title="Search in files (Ctrl+Shift+F)">
            Search
          </button>
        </div>

        {mode === 'search' ? (
          <SearchPane projectId={projectId} onOpen={(rel, line, col) => openFile(rel, line, col)} />
        ) : (
          <>
            <div className="file-tree-head">
              <input className="input" placeholder="Find a file… (Ctrl+P)" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button className="icon-btn" title="New file" aria-label="New file" onClick={() => setDialog({ kind: 'new', type: 'file', dir: '' })}>
                <Icon name="plus" size={16} />
              </button>
              <button className="icon-btn" title="New folder" aria-label="New folder" onClick={() => setDialog({ kind: 'new', type: 'dir', dir: '' })}>
                <Icon name="folderPlus" size={16} />
              </button>
              <button className="icon-btn" title="Refresh" aria-label="Refresh" onClick={refreshTree}>
                <Icon name="refresh" size={16} />
              </button>
            </div>
            <div className="file-tree-body" onContextMenu={(ev) => onContext(ev, null)}>
              {error && (
                <div className="notice bad" onClick={() => setError(null)}>
                  {error}
                </div>
              )}
              {results
                ? results.length === 0
                  ? <p className="muted small pad">No files match.</p>
                  : results.map((e) => (
                      <button key={e.rel} className={`tree-row file ${s.active === e.rel ? 'on' : ''}`} onClick={() => openFile(e.rel)} title={e.rel}>
                        <TreeIcon name={e.name} type="file" env={e.env} />
                        <span className="tree-name">
                          {e.name}
                          <span className="tree-path">{e.rel.slice(0, -e.name.length - 1)}</span>
                        </span>
                      </button>
                    ))
                : renderTree('', 0)}
            </div>
          </>
        )}
      </aside>

      <section className="file-view">
        {s.tabs.length > 0 && (
          <div className="editor-tabs" role="tablist">
            {s.tabs.map((t) => (
              <div
                key={t.rel}
                role="tab"
                aria-selected={t.rel === s.active}
                className={`editor-tab ${t.rel === s.active ? 'on' : ''}`}
                title={t.rel}
                onClick={() => {
                  s.active = t.rel
                  setConflict(null)
                  rerender()
                }}
                onAuxClick={(e) => e.button === 1 && closeTab(t.rel)}
              >
                <TreeIcon name={t.rel.split('/').pop()!} type="file" env={t.kind === 'env'} />
                <span className="editor-tab-name">{t.rel.split('/').pop()}</span>
                <button
                  className={`editor-tab-close ${isDirty(t) ? 'dirty' : ''}`}
                  aria-label={`Close ${t.rel}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.rel)
                  }}
                >
                  <span className="dot">●</span>
                  <span className="x"><Icon name="close" size={12} /></span>
                </button>
              </div>
            ))}
          </div>
        )}

        {active && (
          <div className="file-bar">
            <div className="file-crumbs" title={active.rel}>
              {active.rel.split('/').map((part, i, all) => (
                <span key={i} className={i === all.length - 1 ? 'last' : ''}>
                  {part}
                  {i < all.length - 1 && <span className="sep">/</span>}
                </span>
              ))}
            </div>
            <div className="row gap-s">
              {note && <span className="muted small">{note}</span>}
              {active.kind === 'text' && canFormat(active.rel) && (
                <button className="btn small-btn" onClick={formatActive} title="Format with Prettier (Shift+Alt+F)">
                  Format
                </button>
              )}
              {active.kind === 'text' && (
                <button className={`btn small-btn ${dirty ? 'primary' : ''}`} disabled={!dirty} onClick={() => save()} title="Save (Ctrl+S)">
                  {dirty ? 'Save' : 'Saved'}
                </button>
              )}
              {active.kind !== 'env' && (
                <button
                  className="btn small-btn"
                  title="Ask Claude to explain this file (read-only)"
                  onClick={() =>
                    props.ask(
                      `Explain the file \`${active.rel}\`: what it does, how it fits into the project, and anything risky or worth improving. Do not change any files.`,
                      'plan'
                    )
                  }
                >
                  <Icon name="sparkle" size={14} /> Ask Claude
                </button>
              )}
              <button className="icon-btn" title="Show in folder" onClick={() => api.revealFile(projectId, active.rel)}>
                <Icon name="external" size={15} />
              </button>
              <button className="icon-btn" title="Copy path" onClick={() => navigator.clipboard.writeText(active.rel)}>
                ⧉
              </button>
            </div>
          </div>
        )}

        {conflict && (
          <div className="notice warn file-notice row between">
            <span>{conflict}</span>
            <span className="row gap-s">
              <button className="btn small-btn" onClick={reloadFromDisk}>
                Reload from disk
              </button>
              <button className="btn small-btn danger" onClick={() => save(true)}>
                Overwrite file
              </button>
            </span>
          </div>
        )}

        {/* The editor stays mounted and is only hidden, so it keeps its state. */}
        <div className="editor-host" ref={host} style={{ display: active?.kind === 'text' ? 'block' : 'none' }} />

        {!active && (
          <div className="term-empty">
            <h3>{project.name}</h3>
            <p className="muted">
              Open a file from the tree. <kbd>Ctrl+P</kbd> go to file · <kbd>Ctrl+Shift+F</kbd> search in files · <kbd>Ctrl+S</kbd> save ·{' '}
              <kbd>Shift+Alt+F</kbd> format. Right-click the tree to create, rename or delete.
            </p>
          </div>
        )}
        {active?.kind === 'env' && (
          <div className="term-empty">
            <h3><Icon name="lock" size={16} /> Environment file</h3>
            <p className="muted">
              <code>{name}</code> usually holds passwords and API keys. Edit it in the Environment tab, where values stay hidden until you
              reveal them.
            </p>
            <button className="btn primary" onClick={() => props.goTab('env')}>
              Open Environment tab
            </button>
          </div>
        )}
        {active?.kind === 'image' && (
          <div className="file-image">
            <img src={active.dataUrl} alt={name} />
          </div>
        )}
        {(active?.kind === 'binary' || active?.kind === 'too-large') && (
          <div className="term-empty">
            <p className="muted">
              {active.kind === 'binary'
                ? `This is a binary file (${fmtSize(active.size)}), so it can't be shown as text.`
                : `This file is ${fmtSize(active.size)}, too large to open in the editor.`}
            </p>
          </div>
        )}

        {active?.kind === 'text' && active.model && (
          <div className="status-bar">
            <span>
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span>{active.model.getLanguageId()}</span>
            <span>{fmtSize(active.model.getValueLength())}</span>
            <span className={dirty ? 'warn-text' : ''}>{dirty ? '● Unsaved' : 'Saved'}</span>
          </div>
        )}
      </section>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => (setMenu(null), setDialog({ kind: 'new', type: 'file', dir: menuDir }))}>New file…</button>
          <button onClick={() => (setMenu(null), setDialog({ kind: 'new', type: 'dir', dir: menuDir }))}>New folder…</button>
          {menu.entry?.type === 'dir' && (
            <>
              <hr />
              {projectAt(ctx.db, projectId, menu.entry.rel) ? (
                <button onClick={() => (setMenu(null), ctx.go({ view: 'project', id: projectAt(ctx.db, projectId, menu.entry!.rel)!.id }))}>
                  Open project
                </button>
              ) : (
                <button onClick={() => (setMenu(null), addSubproject(ctx, projectId, menu.entry!.rel).catch((e) => setError(errText(e))))}>
                  Add as project
                </button>
              )}
            </>
          )}
          {menu.entry && (
            <>
              <hr />
              <button onClick={() => (setMenu(null), setDialog({ kind: 'rename', rel: menu.entry!.rel }))}>Rename…</button>
              <button className="danger" onClick={() => (setMenu(null), deleteEntry(menu.entry!))}>
                Delete
              </button>
              <hr />
              <button onClick={() => (setMenu(null), navigator.clipboard.writeText(menu.entry!.rel))}>Copy path</button>
              <button onClick={() => (setMenu(null), api.revealFile(projectId, menu.entry!.rel))}>Show in folder</button>
            </>
          )}
        </div>
      )}

      {dialog && (
        <NameDialog
          title={dialog.kind === 'rename' ? 'Rename' : dialog.type === 'file' ? 'New file' : 'New folder'}
          label={dialog.kind === 'rename' ? 'New name' : `Name${dialog.dir ? ` (in ${dialog.dir}/)` : ''}`}
          initial={dialog.kind === 'rename' ? dialog.rel.split('/').pop()! : ''}
          hint={dialog.kind === 'new' ? 'Use slashes to create sub-folders, e.g. components/Button.tsx' : undefined}
          onClose={() => setDialog(null)}
          onSubmit={async (value) => {
            if (dialog.kind === 'rename') await renameEntry(dialog.rel, value)
            else await createEntry(value, dialog.type, dialog.dir)
            setDialog(null)
          }}
        />
      )}

      {quickOpen && (
        <QuickOpen
          projectId={projectId}
          onClose={() => setQuickOpen(false)}
          onPick={(rel) => {
            setQuickOpen(false)
            openFile(rel)
          }}
        />
      )}
    </div>
  )
}

function NameDialog(props: {
  title: string
  label: string
  initial: string
  hint?: string
  onClose: () => void
  onSubmit: (value: string) => Promise<void>
}): ReactNode {
  const [value, setValue] = useState(props.initial)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // Select the name without the extension, like VS Code.
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = props.initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : props.initial.length)
  }, [])
  const submit = async (): Promise<void> => {
    const v = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!v) return setError('Enter a name.')
    try {
      await props.onSubmit(v)
    } catch (e) {
      setError(errText(e))
    }
  }
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            {props.title === 'Rename' ? 'Rename' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={props.label} hint={props.hint}>
          <input
            ref={ref}
            className="input mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </Field>
        {error && <div className="notice bad">{error}</div>}
      </div>
    </Modal>
  )
}
