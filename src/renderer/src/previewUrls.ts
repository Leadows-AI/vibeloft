import { useSyncExternalStore } from 'react'

// Local addresses printed by dev servers in a project's terminals
// (e.g. "Local: http://localhost:5173/"), newest first. The Preview tab offers
// them; kept separate from the terminal code so it loads without xterm.

const urls = new Map<string, string[]>()
const listeners = new Set<() => void>()
let version = 0

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"<>)\]]*)?/g
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

export function scanForUrls(projectId: string, chunk: string): void {
  if (!chunk.includes('://')) return
  const found = chunk.replace(ANSI, '').match(URL_RE)
  if (!found) return
  const list = urls.get(projectId) ?? []
  let changed = false
  for (const raw of found) {
    const url = raw.replace('0.0.0.0', 'localhost').replace(/[.,;]+$/, '')
    const i = list.indexOf(url)
    if (i === 0) continue
    if (i > 0) list.splice(i, 1)
    list.unshift(url)
    changed = true
  }
  if (!changed) return
  urls.set(projectId, list.slice(0, 8))
  version++
  for (const l of listeners) l()
}

export function useDevUrls(projectId: string): string[] {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
  return urls.get(projectId) ?? []
}
