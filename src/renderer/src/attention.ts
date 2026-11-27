import { useSyncExternalStore } from 'react'

// Which projects have a Claude Code terminal waiting for you. Kept separate
// from the terminal code so the sidebar can show it without loading xterm.

const waiting = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

export function setProjectWaiting(projectId: string, on: boolean): void {
  if (on === waiting.has(projectId)) return
  if (on) waiting.add(projectId)
  else waiting.delete(projectId)
  version++
  for (const l of listeners) l()
}

export function useWaitingProjects(): Set<string> {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
  return waiting
}
