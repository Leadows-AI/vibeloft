import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../ui'

// A project folder can hold several apps, each with its own git repository.
// This picks the one the Git tab and the git bar work on (hidden with one repo).

const EVENT = 'vibeloft:repo-picked'

/** Run `fn` when another repository is picked for this project. */
export function onRepoPicked(projectId: string, fn: () => void): () => void {
  const h = (e: Event): void => {
    if ((e as CustomEvent<string>).detail === projectId) fn()
  }
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}

export function RepoPicker(props: { projectId: string; className?: string }): ReactNode {
  const [list, setList] = useState<{ current: string; repos: { path: string; changes: number }[] } | null>(null)
  const load = useCallback(() => {
    api.gitRepos(props.projectId).then(setList, () => setList(null))
  }, [props.projectId])

  useEffect(load, [load])
  useEffect(() => onRepoPicked(props.projectId, load), [props.projectId, load])
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const off = api.onFilesChanged((e) => {
      if (e.projectId !== props.projectId) return
      if (t) clearTimeout(t)
      t = setTimeout(load, 600)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [props.projectId, load])

  if (!list || list.repos.length < 2) return null
  return (
    <select
      className={`input repo-pick ${props.className ?? ''}`}
      value={list.current}
      title="Repository: this folder holds several apps, each with its own git repository"
      onChange={async (e) => {
        await api.gitPickRepo(props.projectId, e.target.value)
        window.dispatchEvent(new CustomEvent(EVENT, { detail: props.projectId }))
      }}
    >
      {list.repos.map((r) => (
        <option key={r.path} value={r.path}>
          {r.path || 'Project folder'}
          {r.changes ? ` (${r.changes})` : ''}
        </option>
      ))}
    </select>
  )
}
