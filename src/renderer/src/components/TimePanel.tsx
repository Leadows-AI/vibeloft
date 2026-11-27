import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { TimeEntry } from '../../../shared/types'
import type { AppCtx } from '../App'
import { entryMs, fmtClock, fmtHours, hoursDecimal, runningEntry, startOfDay, startOfMonth, startOfWeek, totalBetween, useTick } from '../time'
import { api, Empty, Field, Modal, uid } from '../ui'

// The Time tab: what you've spent on this project, for invoicing and reports.

const pad = (n: number): string => String(n).padStart(2, '0')
const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`

export function TimePanel({ ctx, projectId }: { ctx: AppCtx; projectId: string }): ReactNode {
  const { db, setDb } = ctx
  const project = db.projects.find((p) => p.id === projectId)!
  const entries = db.timeEntries.filter((t) => t.projectId === projectId).sort((a, b) => b.start.localeCompare(a.start))
  const running = runningEntry(db)
  const mine = running?.projectId === projectId ? running : null
  const now = useTick(!!mine)
  const [note, setNote] = useState('')
  const [itemId, setItemId] = useState<string>('')
  const [editing, setEditing] = useState<TimeEntry | null>(null)

  const openItems = db.workItems.filter((w) => w.projectId === projectId && w.status !== 'done')
  const itemTitle = (id: string | null): string | null => db.workItems.find((w) => w.id === id)?.title ?? null

  const totals = {
    today: totalBetween(entries, startOfDay(), undefined, now),
    week: totalBetween(entries, startOfWeek(), undefined, now),
    month: totalBetween(entries, startOfMonth(), undefined, now),
    all: entries.reduce((n, t) => n + entryMs(t, now), 0)
  }
  const rate = db.settings.hourlyRate ?? null
  const currency = db.settings.currency || 'USD'

  const byDay = useMemo(() => {
    const groups = new Map<string, TimeEntry[]>()
    for (const t of entries) {
      const key = localDate(new Date(t.start))
      groups.set(key, [...(groups.get(key) ?? []), t])
    }
    return [...groups.entries()]
  }, [db.timeEntries, projectId])

  function exportCsv(): void {
    const rows = [['Date', 'Start', 'End', 'Hours', 'Note', 'Item']]
    for (const t of [...entries].reverse()) {
      const s = new Date(t.start)
      const e = t.end ? new Date(t.end) : null
      rows.push([localDate(s), localTime(s), e ? localTime(e) : '(running)', hoursDecimal(entryMs(t)), t.note, itemTitle(t.workItemId) ?? ''])
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv' }))
    a.download = `${project.name} - time.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  return (
    <div>
      <section className="tiles">
        <Tile label="Today" ms={totals.today} />
        <Tile label="This week" ms={totals.week} />
        <Tile label="This month" ms={totals.month} rate={rate} currency={currency} />
        <Tile label="All time" ms={totals.all} rate={rate} currency={currency} />
      </section>

      <section className="card timer-card">
        {mine ? (
          <div className="row gap-s">
            <span className="rec-dot" />
            <strong className="timer-clock">{fmtClock(entryMs(mine, now))}</strong>
            <span className="muted grow">
              {mine.note || 'Working'}
              {itemTitle(mine.workItemId) && <> · {itemTitle(mine.workItemId)}</>}
            </span>
            <button className="btn primary" onClick={async () => setDb(await api.timeStop())}>
              Stop
            </button>
          </div>
        ) : (
          <div className="row gap-s">
            <input className="input grow" placeholder="What are you working on? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <select className="input timer-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">No linked item</option>
              {openItems.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.kind === 'bug' ? 'Bug' : 'Feature'}: {w.title}
                </option>
              ))}
            </select>
            <button
              className="btn primary"
              onClick={async () => {
                setDb(await api.timeStart(projectId, note.trim(), itemId || null))
                setNote('')
              }}
            >
              <Icon name="timer" size={15} /> Start
            </button>
          </div>
        )}
        {running && !mine && (
          <p className="muted small">
            A timer is running on {db.projects.find((p) => p.id === running.projectId)?.name}. Starting here stops it.
          </p>
        )}
      </section>

      <div className="toolbar">
        <h3>Entries</h3>
        <div className="grow" />
        <button
          className="btn"
          onClick={() => {
            const end = new Date()
            end.setSeconds(0, 0)
            const start = new Date(end.getTime() - 60 * 60 * 1000)
            setEditing({ id: uid(), projectId, start: start.toISOString(), end: end.toISOString(), note: '', workItemId: null })
          }}
        >
          <Icon name="plus" size={15} /> Add time
        </button>
        <button className="btn" onClick={exportCsv} disabled={!entries.length}>
          Export CSV
        </button>
      </div>

      {entries.length === 0 ? (
        <Empty title="No time logged yet" text="Start the timer when you work on this project, or add time by hand." />
      ) : (
        byDay.map(([day, list]) => (
          <section key={day} className="card time-day">
            <div className="card-head">
              <h3>{new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}</h3>
              <span className="muted">{fmtHours(list.reduce((n, t) => n + entryMs(t, now), 0))}</span>
            </div>
            {list.map((t) => (
              <div key={t.id} className="time-row" onClick={() => !t.end || setEditing(t)}>
                <span className="time-range mono">
                  {localTime(new Date(t.start))}–{t.end ? localTime(new Date(t.end)) : 'now'}
                </span>
                <span className="grow">
                  {t.note || <span className="muted">No note</span>}
                  {itemTitle(t.workItemId) && <span className="muted small"> · {itemTitle(t.workItemId)}</span>}
                </span>
                <span className="time-dur">{t.end ? fmtHours(entryMs(t)) : <span className="ok-text">running</span>}</span>
              </div>
            ))}
          </section>
        ))
      )}

      {editing && <EntryForm ctx={ctx} entry={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Tile(props: { label: string; ms: number; rate?: number | null; currency?: string }): ReactNode {
  return (
    <div className="tile">
      <div className="tile-value">{fmtHours(props.ms)}</div>
      <div className="tile-label">
        {props.label}
        {props.rate ? ` · ${(props.ms / 3_600_000 * props.rate).toLocaleString(undefined, { style: 'currency', currency: props.currency || 'USD', maximumFractionDigits: 0 })}` : ''}
      </div>
    </div>
  )
}

function EntryForm(props: { ctx: AppCtx; entry: TimeEntry; onClose: () => void }): ReactNode {
  const { db, setDb } = props.ctx
  const s0 = new Date(props.entry.start)
  const e0 = props.entry.end ? new Date(props.entry.end) : new Date()
  const [date, setDate] = useState(localDate(s0))
  const [start, setStart] = useState(localTime(s0))
  const [end, setEnd] = useState(localTime(e0))
  const [note, setNote] = useState(props.entry.note)
  const [itemId, setItemId] = useState(props.entry.workItemId ?? '')
  const [error, setError] = useState<string | null>(null)
  const isNew = !db.timeEntries.some((t) => t.id === props.entry.id)
  const items = db.workItems.filter((w) => w.projectId === props.entry.projectId)

  async function save(): Promise<void> {
    const s = new Date(`${date}T${start}:00`)
    let e = new Date(`${date}T${end}:00`)
    if (e <= s) e = new Date(e.getTime() + 24 * 3600_000) // past midnight
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return setError('Check the date and times.')
    setDb(await api.timeSave({ ...props.entry, start: s.toISOString(), end: e.toISOString(), note: note.trim(), workItemId: itemId || null }))
    props.onClose()
  }

  return (
    <Modal
      title={isNew ? 'Add time' : 'Edit time'}
      onClose={props.onClose}
      footer={
        <>
          {!isNew && (
            <button
              className="btn danger ghost"
              onClick={async () => {
                setDb(await api.timeDelete(props.entry.id))
                props.onClose()
              }}
            >
              Delete
            </button>
          )}
          <div className="grow" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Date">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="row gap-s">
          <Field label="From">
            <input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="To">
            <input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Note">
          <input className="input" value={note} placeholder="What did you work on?" onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field label="Linked bug or feature">
          <select className="input" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">None</option>
            {items.map((w) => (
              <option key={w.id} value={w.id}>
                {w.kind === 'bug' ? 'Bug' : 'Feature'}: {w.title}
              </option>
            ))}
          </select>
        </Field>
        {error && <div className="notice bad">{error}</div>}
      </div>
    </Modal>
  )
}
