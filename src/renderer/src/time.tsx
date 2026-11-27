import { useEffect, useState, type ReactNode } from 'react'
import type { Database, TimeEntry } from '../../shared/types'
import { Icon } from './icons'
import { api } from './ui'

// Time tracking helpers shared by the header timer, the sidebar and the Time tab.

export const entryMs = (t: TimeEntry, now = Date.now()): number =>
  Math.max(0, (t.end ? new Date(t.end).getTime() : now) - new Date(t.start).getTime())

export function fmtHours(ms: number): string {
  if (ms > 0 && ms < 60000) return '<1m'
  const mins = Math.round(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export const hoursDecimal = (ms: number): string => (ms / 3_600_000).toFixed(2)

export function runningEntry(db: Database): TimeEntry | null {
  return db.timeEntries.find((t) => !t.end) ?? null
}

/** Re-render every second while something is ticking. */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function startOfDay(d = new Date()): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export function startOfWeek(d = new Date()): Date {
  const x = startOfDay(d)
  const day = (x.getDay() + 6) % 7 // Monday first
  x.setDate(x.getDate() - day)
  return x
}

export function startOfMonth(d = new Date()): Date {
  const x = startOfDay(d)
  x.setDate(1)
  return x
}

/** Total time for entries overlapping [from, to). */
export function totalBetween(entries: TimeEntry[], from: Date, to = new Date(8.64e15), now = Date.now()): number {
  let ms = 0
  for (const t of entries) {
    const a = Math.max(new Date(t.start).getTime(), from.getTime())
    const b = Math.min(t.end ? new Date(t.end).getTime() : now, to.getTime())
    if (b > a) ms += b - a
  }
  return ms
}

/** Start/stop button for the project header. */
export function TimerButton(props: { db: Database; projectId: string; setDb: (db: Database) => void }): ReactNode {
  const running = runningEntry(props.db)
  const mine = running?.projectId === props.projectId
  const now = useTick(!!mine)
  if (mine) {
    return (
      <button className="btn timer-btn running" onClick={async () => props.setDb(await api.timeStop())} title="Stop the timer">
        <span className="rec-dot" /> {fmtClock(entryMs(running!, now))} · Stop
      </button>
    )
  }
  return (
    <button
      className="btn timer-btn"
      onClick={async () => props.setDb(await api.timeStart(props.projectId, '', null))}
      title={running ? 'Start timing this project (stops the other timer)' : 'Start timing your work on this project'}
    >
      <Icon name="timer" size={15} /> Start timer
    </button>
  )
}

/** Running timer shown in the sidebar from anywhere in the app. */
export function SidebarTimer(props: { db: Database; setDb: (db: Database) => void; onOpen: (projectId: string) => void }): ReactNode {
  const running = runningEntry(props.db)
  const now = useTick(!!running)
  if (!running) return null
  const project = props.db.projects.find((p) => p.id === running.projectId)
  return (
    <div className="sidebar-timer">
      <button className="sidebar-timer-main" onClick={() => props.onOpen(running.projectId)} title="Open project">
        <span className="rec-dot" />
        <span className="sidebar-timer-name">{project?.name ?? 'Project'}</span>
        <span className="sidebar-timer-clock">{fmtClock(entryMs(running, now))}</span>
      </button>
      <button className="icon-btn" title="Stop timer" onClick={async () => props.setDb(await api.timeStop())}>
        <Icon name="stop" size={15} />
      </button>
    </div>
  )
}
