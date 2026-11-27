import { useEffect, useState, type ReactNode } from 'react'
import type { GhTeam } from '../../../shared/types'
import type { AppCtx } from '../App'
import { Icon } from '../icons'
import { api } from '../ui'

// One request per repo per session; the card's refresh and invites reload it.
const cache = new Map<string, Promise<GhTeam>>()
export function loadTeam(repo: string, fresh = false): Promise<GhTeam> {
  if (fresh || !cache.has(repo)) {
    const p = api.ghTeam(repo)
    cache.set(repo, p)
    p.catch(() => cache.delete(repo))
  }
  return cache.get(repo)!
}

/** The people on the project's GitHub repo, what each has open, and invites. */
export function TeamCard(props: { ctx: AppCtx; projectId: string; repo: string }): ReactNode {
  const { db } = props.ctx
  const [team, setTeam] = useState<GhTeam | null>(null)
  const [error, setError] = useState('')
  const [login, setLogin] = useState('')
  const [inviting, setInviting] = useState(false)
  const [note, setNote] = useState('')

  const load = (fresh = false): void => {
    setError('')
    loadTeam(props.repo, fresh).then(setTeam, (e: Error) => setError(e.message))
  }
  useEffect(() => {
    setTeam(null)
    load()
  }, [props.repo])

  const open = db.workItems.filter((w) => w.projectId === props.projectId && w.status !== 'done')
  const openFor = (l: string): number => open.filter((w) => w.assignees?.includes(l)).length

  async function invite(): Promise<void> {
    const who = login.trim().replace(/^@/, '')
    if (!who) return
    setInviting(true)
    setNote('')
    try {
      await api.ghInvite(props.repo, who)
      setLogin('')
      setNote(`Invited @${who}. GitHub emails them; once they accept, they can clone the repo in Vibeloft and sync.`)
      load(true)
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setInviting(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h3>Team</h3>
        <button className="link" onClick={() => api.openUrl(`https://github.com/${props.repo}/settings/access`)}>
          Manage on GitHub <Icon name="external" size={12} />
        </button>
      </div>
      {error ? (
        <p className="muted small">
          Couldn't load the team: {error}{' '}
          <button className="link" onClick={() => load(true)}>
            Retry
          </button>
        </p>
      ) : !team ? (
        <p className="muted small">Loading…</p>
      ) : (
        <ul className="list">
          {team.members.map((m) => (
            <li key={m.login}>
              <span className="grow">@{m.login}</span>
              <span className="muted small">{openFor(m.login) ? `${openFor(m.login)} open` : ''}</span>
              <span className="chip">{m.role}</span>
            </li>
          ))}
          {team.invited.map((l) => (
            <li key={l}>
              <span className="grow muted">@{l}</span>
              <span className="chip">invited</span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row gap-s"
        onSubmit={(e) => {
          e.preventDefault()
          void invite()
        }}
      >
        <input className="input" placeholder="GitHub username" aria-label="GitHub username to invite" value={login} onChange={(e) => setLogin(e.target.value)} />
        <button className="btn" type="submit" disabled={inviting || !login.trim()}>
          {inviting ? 'Inviting…' : 'Invite'}
        </button>
      </form>
      {note && <p className="muted small">{note}</p>}
    </section>
  )
}
