import { useSyncExternalStore } from 'react'

// "Getting started" checklist progress for things Vibeloft can't read from
// its data (e.g. "you started Claude Code"). Kept on this computer.

export type ProgressKey = 'claudeStarted' | 'promptSent' | 'changesViewed' | 'committed' | 'switched' | 'tourTaken' | 'askedHelp'

const KEY = 'vibeloft.help.progress'
let done: Set<string> = new Set()
try {
  done = new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[])
} catch {
  /* storage unavailable */
}
const listeners = new Set<() => void>()
let version = 0

export function markDone(key: ProgressKey): void {
  if (done.has(key)) return
  done.add(key)
  version++
  try {
    localStorage.setItem(KEY, JSON.stringify([...done]))
  } catch {
    /* storage unavailable */
  }
  for (const l of listeners) l()
}

export function useProgress(): Set<string> {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
  return done
}

const WELCOME_KEY = 'vibeloft.help.welcomed'
export function welcomed(): boolean {
  try {
    return localStorage.getItem(WELCOME_KEY) === '1'
  } catch {
    return true
  }
}
export function setWelcomed(): void {
  try {
    localStorage.setItem(WELCOME_KEY, '1')
  } catch {
    /* storage unavailable */
  }
}
