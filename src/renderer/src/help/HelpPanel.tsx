import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { AppCtx } from '../App'
import { Markdown } from '../components/Markdown'
import { api } from '../ui'
import { markDone, useProgress } from './progress'
import { guideText, SCREEN_NAMES, TOPICS, type HelpTopic, type Screen, type TourId } from './topics'
import { TOURS } from './tours'

// Help & tour: ask a question in your own words (Claude answers from the
// guide), guided tours, topics for the screen you're on, search, and a
// "Getting started" checklist that ticks itself off.

interface Answer {
  q: string
  text: string | null
  tours: TourId[]
  topics: string[]
  error?: string
}

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function parseAnswer(raw: string): { text: string; tours: TourId[]; topics: string[] } {
  const lines = raw.split('\n')
  const tours: TourId[] = []
  const topics: string[] = []
  const keep: string[] = []
  for (const line of lines) {
    const t = line.trim().match(/^TOURS:\s*(.*)$/i)
    const p = line.trim().match(/^TOPICS:\s*(.*)$/i)
    if (t) t[1].split(',').map((x) => x.trim()).forEach((x) => x in TOURS && tours.push(x as TourId))
    else if (p) p[1].split(',').map((x) => x.trim()).forEach((x) => TOPICS.some((tp) => tp.id === x) && topics.push(x))
    else keep.push(line)
  }
  return { text: keep.join('\n').trim(), tours, topics }
}

export function HelpPanel(props: { ctx: AppCtx; screen: Screen; onClose: () => void; startTour: (id: TourId) => void }): ReactNode {
  const { db, theme } = props.ctx
  const [q, setQ] = useState('')
  const [answers, setAnswers] = useState<Answer[]>([])
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const progress = useProgress()

  const here = TOPICS.filter((t) => t.screens.includes(props.screen))
  const found = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    return TOPICS.filter((t) => {
      const hay = `${t.title} ${t.keywords} ${t.body}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [search])

  const ask = async (): Promise<void> => {
    const question = q.trim()
    if (!question) return
    setQ('')
    markDone('askedHelp')
    setAnswers((a) => [{ q: question, text: null, tours: [], topics: [] }, ...a])
    try {
      const raw = await api.helpAsk(question, SCREEN_NAMES[props.screen], guideText())
      const parsed = parseAnswer(raw)
      setAnswers((a) => a.map((x) => (x.q === question && x.text === null ? { ...x, ...parsed } : x)))
    } catch (e) {
      setAnswers((a) => a.map((x) => (x.q === question && x.text === null ? { ...x, text: '', error: errText(e) } : x)))
    }
  }

  const checklist: { label: string; done: boolean; hint: string }[] = [
    { label: 'Add a project', done: db.projects.length > 0, hint: 'Click + next to Projects in the sidebar.' },
    { label: 'Take a tour', done: progress.has('tourTaken'), hint: 'Pick one under Guided tours above.' },
    { label: 'Start Claude Code', done: progress.has('claudeStarted'), hint: 'Open a project and click New conversation in its Terminal tab.' },
    { label: 'Send Claude a prompt', done: progress.has('promptSent'), hint: 'Type in the terminal, or click a quick prompt.' },
    { label: 'Review what Claude changed', done: progress.has('changesViewed'), hint: 'Click Changes, or Review after Claude’s turn.' },
    { label: 'Commit & push', done: progress.has('committed'), hint: 'Use Commit & Push in the git bar at the bottom of the Terminal tab.' },
    { label: 'Switch projects with Ctrl+K', done: progress.has('switched'), hint: 'Press Ctrl+K and type part of a project name.' },
    { label: 'Link an app to an API project', done: db.links.length > 0, hint: 'Overview → Linked projects → Link a project.' },
    { label: 'Track some time', done: db.timeEntries.length > 0, hint: 'Click Start timer in a project’s header.' }
  ]
  const doneCount = checklist.filter((c) => c.done).length

  const topicView = (t: HelpTopic): ReactNode => (
    <div key={t.id} className={`help-topic ${open === t.id ? 'open' : ''}`}>
      <button className="help-topic-head" onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
        <span>{t.title}</span>
        <span className="muted">{open === t.id ? '−' : '+'}</span>
      </button>
      {open === t.id && (
        <div className="help-topic-body">
          <Markdown text={t.body} theme={theme} />
          {t.tour && (
            <button className="btn small-btn" onClick={() => props.startTour(t.tour!)}>
              <Icon name="play" size={13} /> Show me: {TOURS[t.tour].title}
            </button>
          )}
        </div>
      )}
    </div>
  )

  return (
    <aside className="help-panel" aria-label="Help">
      <div className="help-head">
        <b>Help &amp; tour</b>
        <button className="icon-btn" aria-label="Close help" onClick={props.onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="help-scroll">
        <section className="help-ask">
          <label className="muted small" htmlFor="help-q">
            Ask how to do something
          </label>
          <div className="row gap-s">
            <input
              id="help-q"
              className="input"
              placeholder="e.g. How do I undo what Claude did?"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void ask()}
              autoFocus
            />
            <button className="btn primary" onClick={() => void ask()} disabled={!q.trim()}>
              Ask
            </button>
          </div>
          {answers.map((a, i) => (
            <div key={`${a.q}-${i}`} className="help-answer">
              <div className="help-q">{a.q}</div>
              {a.text === null ? (
                <div className="muted small"><Icon name="sparkle" size={13} /> Thinking…</div>
              ) : a.error ? (
                <div className="bad-text small">{a.error}</div>
              ) : (
                <>
                  <Markdown text={a.text} theme={theme} />
                  {(a.tours.length > 0 || a.topics.length > 0) && (
                    <div className="help-links">
                      {a.tours.map((t) => (
                        <button key={t} className="btn small-btn primary" onClick={() => props.startTour(t)}>
                          <Icon name="play" size={13} /> Show me: {TOURS[t].title}
                        </button>
                      ))}
                      {a.topics.map((id) => (
                        <button
                          key={id}
                          className="btn small-btn"
                          onClick={() => {
                            setSearch('')
                            setOpen(id)
                            document.getElementById(`help-all`)?.scrollIntoView({ block: 'start' })
                          }}
                        >
                          {TOPICS.find((t) => t.id === id)?.title}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </section>

        <section>
          <h4>Guided tours</h4>
          <div className="help-tours">
            {(Object.keys(TOURS) as TourId[]).map((id) => (
              <button key={id} className="help-tour" onClick={() => props.startTour(id)}>
                <b><Icon name="play" size={13} /> {TOURS[id].title}</b>
                <span>{TOURS[id].blurb}</span>
              </button>
            ))}
          </div>
        </section>

        {here.length > 0 && (
          <section>
            <h4>On this screen</h4>
            {here.map(topicView)}
          </section>
        )}

        <section id="help-all">
          <h4>All topics</h4>
          <input className="input help-search" placeholder="Search help…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search.trim() && found.length === 0 && <p className="muted small">Nothing found. Try asking above in your own words.</p>}
          {(search.trim() ? found : TOPICS.filter((t) => !here.includes(t))).map(topicView)}
        </section>

        <section>
          <h4>
            Getting started{' '}
            <span className="muted small">
              {doneCount} of {checklist.length}
            </span>
          </h4>
          <div className="help-progress" aria-hidden="true">
            <div style={{ width: `${(doneCount / checklist.length) * 100}%` }} />
          </div>
          <ul className="help-checklist">
            {checklist.map((c) => (
              <li key={c.label} className={c.done ? 'done' : ''}>
                <span className="help-check" aria-hidden="true">
                  {c.done ? <Icon name="check" size={12} /> : ''}
                </span>
                <span>
                  {c.label}
                  {!c.done && <span className="muted small"> · {c.hint}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  )
}
