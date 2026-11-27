import { useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { LinkStatus, ProjectLink } from '../../../shared/types'
import type { AppCtx } from '../App'
import { linksOf, pendingFor, refreshLinks, updatePrompt, useLinkStatuses } from '../links'
import { api, Field, Modal, relTime, uid } from '../ui'
import type { ProjectTab } from './ProjectView'

// "Linked projects": an app that uses another project's API. Shows when the
// API changed since the app was last updated, and updates the app with Claude
// (which can read both codebases).

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Open Claude Code in the app's folder, able to read the API project, with the catch-up prompt. */
export async function updateAppWithClaude(ctx: AppCtx, link: ProjectLink, status: LinkStatus | undefined): Promise<void> {
  const provider = ctx.db.projects.find((p) => p.id === link.providerId)
  const { openClaudeTask } = await import('../termStore')
  await openClaudeTask(link.consumerId, {
    title: `Update for ${provider?.name ?? 'API'}`.slice(0, 40),
    prompt: updatePrompt(ctx.db, link, status),
    plan: false,
    addDirs: provider?.localPath ? [provider.localPath] : []
  })
  ctx.go({ view: 'project', id: link.consumerId, tab: 'terminal' })
}

/** Chips under the project name: jump to a linked project. */
export function LinkChips(props: { ctx: AppCtx; projectId: string }): ReactNode {
  const { db } = props.ctx
  const map = useLinkStatuses()
  const { uses, usedBy } = linksOf(db, props.projectId)
  if (!uses.length && !usedBy.length) return null
  const chip = (link: ProjectLink, otherId: string, label: string, pending: number): ReactNode => {
    const other = db.projects.find((p) => p.id === otherId)
    if (!other) return null
    return (
      <button
        key={`${link.id}-${otherId}`}
        className={`link-chip ${pending ? 'pending' : ''}`}
        title={`${label} ${other.name}. Click to switch to it.`}
        onClick={() => props.ctx.go({ view: 'project', id: otherId})}
      >
        <Icon name="link" size={13} /> {other.name}
        <span className="link-chip-role">{label === 'Uses the API of' ? 'API' : 'app'}</span>
        {pending > 0 && <span className="link-chip-count">{pending}</span>}
      </button>
    )
  }
  return (
    <div className="link-chips">
      {uses.map((l) => chip(l, l.providerId, 'Uses the API of', pendingFor(map.get(l.id))))}
      {usedBy.map((l) => chip(l, l.consumerId, 'Provides the API for', pendingFor(map.get(l.id))))}
    </div>
  )
}

/** Banner in the app's Terminal tab when the API it uses has changed. */
export function LinkBanner(props: { ctx: AppCtx; projectId: string; goTab: (t: ProjectTab) => void }): ReactNode {
  const { db, setDb } = props.ctx
  const map = useLinkStatuses()
  const [busy, setBusy] = useState(false)
  const pending = db.links.filter((l) => l.consumerId === props.projectId && pendingFor(map.get(l.id)) > 0)
  if (!pending.length) return null
  return (
    <>
      {pending.map((l) => {
        const st = map.get(l.id)
        const provider = db.projects.find((p) => p.id === l.providerId)
        const n = pendingFor(st)
        return (
          <div key={l.id} className="link-banner">
            <Icon name="link" size={16} className="link-banner-icon" />
            <span className="link-banner-text">
              <b>{provider?.name ?? 'Linked project'}</b>’s API changed: {n} commit{n === 1 ? '' : 's'} since this app was last updated
              {st?.commits[0] && <span className="muted"> · latest: {st.commits[0].subject}</span>}
            </span>
            <button className="btn small-btn" onClick={() => props.goTab('overview')}>
              Details
            </button>
            <button
              className="btn small-btn"
              disabled={busy}
              title="Already handled: stop showing these changes"
              onClick={async () => {
                setBusy(true)
                try {
                  setDb(await api.markLinkSynced(l.id))
                  await refreshLinks([l.id])
                } finally {
                  setBusy(false)
                }
              }}
            >
              Mark up to date
            </button>
            <button className="btn small-btn primary" onClick={() => void updateAppWithClaude(props.ctx, l, st)}>
              <Icon name="sparkle" size={15} /> Update app with Claude
            </button>
          </div>
        )
      })}
    </>
  )
}

/** The "Linked projects" card on a project's Overview. */
export function LinkedProjectsCard(props: { ctx: AppCtx; projectId: string; goTab: (t: ProjectTab) => void }): ReactNode {
  const { db, setDb } = props.ctx
  const map = useLinkStatuses()
  const { uses, usedBy } = linksOf(db, props.projectId)
  const [editing, setEditing] = useState<{ link: ProjectLink; thisIs: 'consumer' | 'provider' } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const name = (id: string): string => db.projects.find((p) => p.id === id)?.name ?? 'Missing project'

  const newLink = (): void =>
    setEditing({
      link: { id: uid(), consumerId: props.projectId, providerId: '', apiPaths: [], envVar: '' },
      thisIs: 'consumer'
    })

  const addTask = async (l: ProjectLink, st: LinkStatus | undefined): Promise<void> => {
    const at = new Date().toISOString()
    setDb(
      await api.saveWorkItem({
        id: uid(),
        projectId: l.consumerId,
        kind: 'feature',
        title: `Update for ${name(l.providerId)} API changes`,
        body: updatePrompt(db, l, st),
        status: 'todo',
        priority: 'high',
        milestoneId: null,
        githubNumber: null,
        githubUrl: null,
        createdAt: at,
        updatedAt: at,
        syncedAt: null
      })
    )
    setNotice(`Added "Update for ${name(l.providerId)} API changes" to ${name(l.consumerId)}'s features.`)
  }

  return (
    <section className="card linked-card">
      <div className="card-head">
        <h3>Linked projects</h3>
        <button className="link" onClick={newLink}>
          <Icon name="plus" size={14} /> Link a project
        </button>
      </div>
      {!uses.length && !usedBy.length && (
        <p className="muted small">
          Link this project to one whose API it uses (or that uses its API). Vibeloft then tells you when the API changes, lets Claude read both
          codebases, and updates the app in one click.
        </p>
      )}
      {notice && (
        <div className="notice ok small" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {uses.map((l) => {
        const st = map.get(l.id)
        const n = pendingFor(st)
        return (
          <div key={l.id} className="link-row">
            <div className="link-row-head">
              <span>
                Uses the API of{' '}
                <button className="link" onClick={() => props.ctx.go({ view: 'project', id: l.providerId})}>
                  {name(l.providerId)}
                </button>
              </span>
              <button className="link small" onClick={() => setEditing({ link: l, thisIs: 'consumer' })}>
                Edit
              </button>
            </div>
            {st?.error ? (
              <p className="bad-text small">{st.error}</p>
            ) : n === 0 ? (
              <p className="ok-text small">
                <Icon name="check" size={13} /> Up to date with its API{l.syncedAt ? ` (checked ${relTime(l.syncedAt)})` : ''}.
                {st?.uncommitted.length ? <span className="muted"> {st.uncommitted.length} API file(s) being edited there, not committed yet.</span> : null}
              </p>
            ) : (
              <>
                <p className="warn-text small">
                  The API changed in {n} commit{n === 1 ? '' : 's'} since this app was last updated:
                </p>
                <ul className="link-commits">
                  {st!.commits.slice(0, 6).map((c) => (
                    <li key={c.hash}>
                      <code>{c.hash}</code> {c.subject} <span className="muted">· {relTime(c.date)}</span>
                    </li>
                  ))}
                  {n > 6 && <li className="muted">…and {n - 6} more</li>}
                </ul>
                <div className="row gap-s wrap">
                  <button className="btn small-btn primary" onClick={() => void updateAppWithClaude(props.ctx, l, st)}>
                    <Icon name="sparkle" size={15} /> Update app with Claude
                  </button>
                  <button className="btn small-btn" onClick={() => void addTask(l, st)}>
                    Add as a task
                  </button>
                  <button
                    className="btn small-btn"
                    onClick={async () => {
                      setDb(await api.markLinkSynced(l.id))
                      await refreshLinks([l.id])
                    }}
                  >
                    Mark up to date
                  </button>
                </div>
              </>
            )}
            <p className="muted small link-meta">
              Watching {l.apiPaths.length ? l.apiPaths.join(', ') : 'the whole project'}
              {l.envVar ? ` · address in ${l.envVar}` : ''}
            </p>
          </div>
        )
      })}

      {usedBy.map((l) => {
        const n = pendingFor(map.get(l.id))
        return (
          <div key={l.id} className="link-row">
            <div className="link-row-head">
              <span>
                Its API is used by{' '}
                <button className="link" onClick={() => props.ctx.go({ view: 'project', id: l.consumerId})}>
                  {name(l.consumerId)}
                </button>
              </span>
              <button className="link small" onClick={() => setEditing({ link: l, thisIs: 'provider' })}>
                Edit
              </button>
            </div>
            <p className={`small ${n ? 'warn-text' : 'ok-text'}`}>
              {n ? `${name(l.consumerId)} hasn't been updated for ${n} API commit${n === 1 ? '' : 's'} yet.` : `${name(l.consumerId)} is up to date.`}
            </p>
            {n > 0 && (
              <button className="btn small-btn primary" onClick={() => void updateAppWithClaude(props.ctx, l, map.get(l.id))}>
                <Icon name="sparkle" size={15} /> Update {name(l.consumerId)} with Claude
              </button>
            )}
          </div>
        )
      })}

      {editing && <LinkForm ctx={props.ctx} projectId={props.projectId} initial={editing.link} thisIs={editing.thisIs} onClose={() => setEditing(null)} />}
    </section>
  )
}

function LinkForm(props: { ctx: AppCtx; projectId: string; initial: ProjectLink; thisIs: 'consumer' | 'provider'; onClose: () => void }): ReactNode {
  const { db, setDb } = props.ctx
  const isNew = !db.links.some((l) => l.id === props.initial.id)
  const [role, setRole] = useState<'consumer' | 'provider'>(props.thisIs)
  const [other, setOther] = useState(role === 'consumer' ? props.initial.providerId : props.initial.consumerId)
  const [paths, setPaths] = useState(props.initial.apiPaths.join('\n'))
  const [envVar, setEnvVar] = useState(props.initial.envVar ?? '')
  const [error, setError] = useState<string | null>(null)
  const others = db.projects.filter((p) => p.id !== props.projectId)
  const providerName = role === 'consumer' ? db.projects.find((p) => p.id === other)?.name || 'the other project' : 'this project'

  const save = async (): Promise<void> => {
    if (!other) return setError('Pick the other project.')
    const link: ProjectLink = {
      ...props.initial,
      consumerId: role === 'consumer' ? props.projectId : other,
      providerId: role === 'consumer' ? other : props.projectId,
      apiPaths: paths
        .split(/[\n,]/)
        .map((p) => p.trim())
        .filter(Boolean),
      envVar: envVar.trim() || undefined
    }
    try {
      setDb(await api.saveLink(link))
      await refreshLinks([link.id])
      props.onClose()
    } catch (e) {
      setError(errText(e))
    }
  }

  return (
    <Modal
      title={isNew ? 'Link a project' : 'Linked project'}
      onClose={props.onClose}
      footer={
        <>
          {!isNew && (
            <button
              className="btn danger ghost"
              onClick={async () => {
                if (!confirm('Remove this link? Nothing in either project changes.')) return
                setDb(await api.deleteLink(props.initial.id))
                props.onClose()
              }}
            >
              Remove link
            </button>
          )}
          <div className="grow" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="This project…">
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'consumer' | 'provider')}>
            <option value="consumer">uses the API of…</option>
            <option value="provider">provides the API used by…</option>
          </select>
        </Field>
        <Field label={role === 'consumer' ? 'The project with the API' : 'The app that uses this API'}>
          <select className="input" value={other} onChange={(e) => setOther(e.target.value)}>
            <option value="">Choose a project…</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.kind})
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={`Files in ${providerName} that define its public API`}
          hint="One per line. Folders and globs work, e.g. backend/routes/**, openapi.yaml, src/api/**. Leave empty to watch the whole project."
        >
          <textarea className="input mono" rows={4} value={paths} placeholder={'backend/routes/**\nopenapi.yaml'} onChange={(e) => setPaths(e.target.value)} />
        </Field>
        <Field label="Setting in the app that holds the API address (optional)" hint="Shown to Claude by name only; values in .env files are never sent.">
          <input className="input mono" value={envVar} placeholder="EXPO_PUBLIC_API_URL" onChange={(e) => setEnvVar(e.target.value)} />
        </Field>
        {isNew && <p className="muted small">Changes made from now on are tracked; the link starts as "up to date".</p>}
        {error && <div className="notice bad">{error}</div>}
      </div>
    </Modal>
  )
}
