import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import type { FileEntry } from '../../../shared/types'
import type { AppCtx } from '../App'
import { TreeIcon } from '../fileIcons'
import { Icon } from '../icons'
import { addSubproject, projectAt } from '../subproject'
import { api } from '../ui'

// The project folder as a tree on the right of a project's tabs (the Files tab
// has its own). Clicking a file opens it in the Files tab; dragging one onto the
// terminal types its path. Open folders are remembered per project while the
// app runs, and the tree refreshes itself when files change on disk.

const openDirs = new Map<string, Set<string>>()
const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

export function ProjectTree(props: {
  ctx: AppCtx
  projectId: string
  folder: string
  onOpen: (rel: string) => void
  onCollapse: () => void
}): ReactNode {
  const { ctx, projectId } = props
  // Right-click menu on a folder.
  const [menu, setMenu] = useState<{ x: number; y: number; rel: string } | null>(null)
  const existing = menu ? projectAt(ctx.db, projectId, menu.rel) : undefined
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])
  if (!openDirs.has(projectId)) openDirs.set(projectId, new Set())
  const expanded = openDirs.get(projectId)!
  const [children, setChildren] = useState(new Map<string, FileEntry[]>())
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const loaded = useRef(children)
  loaded.current = children

  const load = useCallback(
    async (rel: string) => {
      try {
        const list = await api.listDir(projectId, rel)
        setChildren((m) => new Map(m).set(rel, list))
      } catch {
        expanded.delete(rel) // the folder was removed
      }
    },
    [projectId]
  )
  const refresh = useCallback(() => {
    void load('')
    for (const rel of expanded) void load(rel)
  }, [load])

  useEffect(refresh, [refresh])
  useEffect(
    () =>
      api.onFilesChanged((e) => {
        if (e.projectId !== projectId) return
        const dirs = new Set(e.paths.filter((p) => !p.startsWith('.git/')).map(parentOf))
        for (const d of dirs) if (loaded.current.has(d)) void load(d)
      }),
    [projectId, load]
  )

  function toggle(rel: string): void {
    if (expanded.has(rel)) expanded.delete(rel)
    else {
      expanded.add(rel)
      if (!children.has(rel)) void load(rel)
    }
    rerender()
  }

  function rows(rel: string, depth: number): ReactNode {
    const list = children.get(rel)
    if (!list) return depth === 0 ? <p className="muted small pad">Loading…</p> : null
    if (list.length === 0) return <div className="tree-empty" style={{ paddingLeft: 12 + depth * 14 }}>empty</div>
    return list.map((e) => {
      const open = expanded.has(e.rel)
      return (
        <div key={e.rel}>
          <button
            className={`tree-row ${e.heavy ? 'heavy' : ''} ${e.type}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => (e.type === 'dir' ? toggle(e.rel) : props.onOpen(e.rel))}
            onContextMenu={(ev) => {
              if (e.type !== 'dir') return
              ev.preventDefault()
              // The tree is at the window's right edge: keep the menu on screen.
              setMenu({ x: Math.min(ev.clientX, window.innerWidth - 200), y: ev.clientY, rel: e.rel })
            }}
            draggable
            onDragStart={(ev) => {
              ev.dataTransfer.setData('text/vibeloft-path', e.rel)
              ev.dataTransfer.setData('text/plain', e.rel)
              ev.dataTransfer.effectAllowed = 'copy'
            }}
            title={e.type === 'dir' ? e.rel : `${e.rel} (click to open in Files)`}
          >
            <TreeIcon name={e.name} type={e.type} open={open} env={e.env} />
            <span className="tree-name">{e.name}</span>
          </button>
          {e.type === 'dir' && open && rows(e.rel, depth + 1)}
        </div>
      )
    })
  }

  return (
    <aside className="project-tree" aria-label="Project files">
      <div className="project-tree-head">
        <span className="project-tree-title" title={props.folder}>
          {props.folder.split(/[\\/]/).filter(Boolean).pop()}
        </span>
        <button className="icon-btn" title="Open folder" aria-label="Open the project folder" onClick={() => void api.openFolder(props.folder)}>
          <Icon name="external" size={15} />
        </button>
        <button className="icon-btn" title="Refresh" aria-label="Refresh the file tree" onClick={refresh}>
          <Icon name="refresh" size={15} />
        </button>
        <button className="icon-btn" title="Hide the file tree" aria-label="Hide the file tree" onClick={props.onCollapse}>
          <Icon name="panelRight" size={15} />
        </button>
      </div>
      <div className="file-tree-body">{rows('', 0)}</div>
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          {existing ? (
            <button onClick={() => ctx.go({ view: 'project', id: existing.id })}>Open project</button>
          ) : (
            <button onClick={() => void addSubproject(ctx, projectId, menu.rel).catch((e) => alert((e as Error).message))}>
              Add as project
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
