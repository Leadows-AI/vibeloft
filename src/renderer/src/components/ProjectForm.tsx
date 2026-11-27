import { useEffect, useState, type ReactNode } from 'react'
import type { GhRepo, Project } from '../../../shared/types'
import type { AppCtx } from '../App'
import { api, Field, Modal, nowIso, uid } from '../ui'

type Source = 'folder' | 'github' | 'template'

const blank = (): Project => ({
  id: uid(),
  name: '',
  customerId: null,
  kind: 'web',
  status: 'active',
  description: '',
  localPath: null,
  repo: null,
  techStack: [],
  architecture: '',
  architectureUpdatedAt: null,
  claudeSessionId: null,
  lastSyncedAt: null,
  createdAt: nowIso()
})

export function ProjectForm(props: {
  ctx: AppCtx
  project?: Project
  onClose: () => void
  onSaved: (id: string, tab?: 'terminal') => void
}): ReactNode {
  const { db, setDb } = props.ctx
  const editing = !!props.project
  const [p, setP] = useState<Project>(props.project ?? blank())
  const [source, setSource] = useState<Source>('folder')
  const [newCustomer, setNewCustomer] = useState('')
  const [repos, setRepos] = useState<GhRepo[] | null>(null)
  const [repoFilter, setRepoFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stackText, setStackText] = useState(p.techStack.join(', '))

  const set = <K extends keyof Project>(k: K, v: Project[K]): void => setP((x) => ({ ...x, [k]: v }))

  useEffect(() => {
    if (!editing && source === 'github' && repos === null) {
      setBusy('Loading your GitHub repositories…')
      api
        .ghListRepos()
        .then(setRepos)
        .catch((e) => setError(`Couldn't list repositories: ${e.message}. Is the GitHub CLI signed in?`))
        .finally(() => setBusy(null))
    }
  }, [source])

  async function applyFolder(path: string): Promise<void> {
    const info = await api.inspectFolder(path)
    setP((x) => ({
      ...x,
      localPath: path,
      repo: info.repo ?? x.repo,
      kind: info.kind,
      name: x.name || info.name,
      techStack: info.techStack.length ? info.techStack : x.techStack
    }))
    if (info.techStack.length) setStackText(info.techStack.join(', '))
  }

  async function pickFolder(): Promise<void> {
    const path = await api.pickFolder()
    if (path) await applyFolder(path)
  }

  async function cloneSelected(repo: string): Promise<void> {
    setError(null)
    const parent = db.settings.projectsRoot ?? (await api.pickFolder())
    if (!parent) return
    setBusy(`Cloning ${repo}…`)
    try {
      const dest = await api.ghClone(repo, parent)
      await applyFolder(dest)
      set('repo', repo)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // ---------- new from template ----------
  const [template, setTemplate] = useState<'web' | 'mobile'>('web')
  const [parentDir, setParentDir] = useState<string | null>(db.settings.projectsRoot)
  const [createRepo, setCreateRepo] = useState(true)
  const [ghOk, setGhOk] = useState<boolean | null>(null)
  useEffect(() => {
    if (source === 'template' && ghOk === null) api.ghStatus().then((g) => setGhOk(g.ok), () => setGhOk(false))
  }, [source])

  async function createFromTemplate(): Promise<void> {
    if (!p.name.trim()) return setError('Give the project a name.')
    if (!parentDir) return setError('Choose the folder to create the project in.')
    setError(null)
    setBusy(template === 'mobile' ? 'Creating the Expo app… this downloads the template and takes about a minute.' : 'Creating the project…')
    try {
      let customerId = p.customerId
      let customerName = db.customers.find((c) => c.id === customerId)?.name ?? null
      if (newCustomer.trim()) {
        customerId = uid()
        customerName = newCustomer.trim()
        await api.saveCustomer({ id: customerId, name: customerName })
      }
      const r = await api.createFromTemplate({
        template,
        name: p.name.trim(),
        parentDir,
        customerName,
        description: p.description.trim(),
        createGithubRepo: createRepo && !!ghOk
      })
      const next = await api.saveProject({
        ...p,
        name: p.name.trim(),
        customerId,
        kind: template,
        localPath: r.path,
        repo: r.repo,
        techStack: template === 'web' ? ['React', 'Vite', 'Express', 'TypeScript'] : ['Expo', 'React Native', 'TypeScript']
      })
      setDb(next)
      if (r.notes.length) alert(r.notes.join('\n\n'))
      // Install dependencies in a terminal tab so progress is visible.
      const t = await import('../termStore')
      await t.openTerminal(p.id, { title: 'npm install', command: r.installCommand })
      props.onSaved(p.id, 'terminal')
    } catch (e) {
      setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(null)
    }
  }

  async function save(): Promise<void> {
    if (source === 'template' && !editing) return createFromTemplate()
    if (!p.name.trim()) return setError('Give the project a name.')
    let customerId = p.customerId
    let next = db
    if (newCustomer.trim()) {
      customerId = uid()
      next = await api.saveCustomer({ id: customerId, name: newCustomer.trim() })
    }
    const repo = p.repo?.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '') || null
    next = await api.saveProject({
      ...p,
      name: p.name.trim(),
      customerId,
      repo,
      techStack: stackText.split(',').map((s) => s.trim()).filter(Boolean)
    })
    setDb(next)
    props.onSaved(p.id)
  }

  const filteredRepos = (repos ?? []).filter((r) => r.nameWithOwner.toLowerCase().includes(repoFilter.toLowerCase()))

  return (
    <Modal
      title={editing ? 'Edit project' : 'New project'}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!!busy}>
            {editing ? 'Save' : 'Create project'}
          </button>
        </>
      }
    >
      {!editing && (
        <div className="segmented full">
          <button className={source === 'folder' ? 'on' : ''} onClick={() => setSource('folder')}>
            Folder on this computer
          </button>
          <button className={source === 'github' ? 'on' : ''} onClick={() => setSource('github')}>
            Clone from GitHub
          </button>
          <button className={source === 'template' ? 'on' : ''} onClick={() => setSource('template')}>
            New from template
          </button>
        </div>
      )}

      {!editing && source === 'template' && (
        <div className="form-grid">
          <div className="template-picks">
            <button className={`template-card ${template === 'web' ? 'on' : ''}`} onClick={() => setTemplate('web')}>
              <b>Web app</b>
              <span>React + Vite client, Express API server, TypeScript. One command runs both.</span>
            </button>
            <button className={`template-card ${template === 'mobile' ? 'on' : ''}`} onClick={() => setTemplate('mobile')}>
              <b>Mobile app</b>
              <span>Expo (React Native) with TypeScript. Runs on iPhone, Android and the web.</span>
            </button>
          </div>
          <Field label="Project name">
            <input className="input" value={p.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Acme Booking App" autoFocus />
          </Field>
          <Field label="Customer">
            <select
              className="input"
              value={newCustomer ? '__new' : p.customerId ?? ''}
              onChange={(e) => {
                if (e.target.value === '__new') setNewCustomer(' ')
                else {
                  setNewCustomer('')
                  set('customerId', e.target.value || null)
                }
              }}
            >
              <option value="">No customer</option>
              {db.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="__new">+ New customer…</option>
            </select>
          </Field>
          {newCustomer && (
            <Field label="New customer name">
              <input className="input" value={newCustomer.trimStart()} onChange={(e) => setNewCustomer(e.target.value || ' ')} />
            </Field>
          )}
          <Field label="Create in folder" hint={`A new folder named after the project is created here.`}>
            <div className="row gap-s">
              <input className="input" value={parentDir ?? ''} placeholder="Choose a folder…" readOnly />
              <button
                className="btn"
                onClick={async () => {
                  const d = await api.pickFolder()
                  if (d) setParentDir(d)
                }}
              >
                Browse…
              </button>
            </div>
          </Field>
          <Field label="Description" hint="Goes into the README and CLAUDE.md, so Claude knows what the app is for.">
            <textarea className="input" rows={3} value={p.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={createRepo && !!ghOk} disabled={!ghOk} onChange={(e) => setCreateRepo(e.target.checked)} />
            Create a private GitHub repository and push the first commit
            {ghOk === false && <span className="muted small"> (sign in with "gh auth login" first)</span>}
          </label>
          <p className="muted small">
            You get the starter code, a CLAUDE.md with this project's context, a .gitignore that keeps .env secrets out of git, and a first commit.
            Dependencies install in a terminal tab afterwards.
          </p>
        </div>
      )}

      {!editing && source === 'github' && !p.localPath && (
        <div className="repo-picker">
          <input className="input" placeholder="Filter repositories…" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} />
          <div className="repo-list">
            {filteredRepos.map((r) => (
              <button key={r.nameWithOwner} className="repo-row" onClick={() => cloneSelected(r.nameWithOwner)} disabled={!!busy}>
                <span>
                  {r.nameWithOwner} {r.isPrivate && <span className="badge">private</span>}
                </span>
                <span className="muted small">{r.description}</span>
              </button>
            ))}
            {repos && filteredRepos.length === 0 && <p className="muted pad">No matching repositories.</p>}
          </div>
          <p className="muted small">
            Clones into {db.settings.projectsRoot ?? 'a folder you choose'}. Set a default projects folder in Settings.
          </p>
        </div>
      )}

      {busy && <div className="notice">{busy}</div>}
      {error && <div className="notice bad">{error}</div>}

      {(editing || source === 'folder' || (source === 'github' && p.localPath)) && (
        <div className="form-grid">
          <Field label="Local folder" hint="The code on this computer. Claude works inside this folder.">
            <div className="row gap-s">
              <input className="input" value={p.localPath ?? ''} placeholder="Choose a folder…" readOnly />
              <button className="btn" onClick={pickFolder}>
                Browse…
              </button>
            </div>
          </Field>
          <Field label="Project name">
            <input className="input" value={p.name} onChange={(e) => set('name', e.target.value)} autoFocus />
          </Field>
          <Field label="Customer">
            <select
              className="input"
              value={newCustomer ? '__new' : p.customerId ?? ''}
              onChange={(e) => {
                if (e.target.value === '__new') setNewCustomer(' ')
                else {
                  setNewCustomer('')
                  set('customerId', e.target.value || null)
                }
              }}
            >
              <option value="">No customer</option>
              {db.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="__new">+ New customer…</option>
            </select>
          </Field>
          {newCustomer && (
            <Field label="New customer name">
              <input className="input" value={newCustomer.trimStart()} onChange={(e) => setNewCustomer(e.target.value || ' ')} />
            </Field>
          )}
          <Field label="Type">
            <select className="input" value={p.kind} onChange={(e) => set('kind', e.target.value as Project['kind'])}>
              <option value="web">Web app (client + server)</option>
              <option value="mobile">Mobile app (React Native)</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Status">
            <select className="input" value={p.status} onChange={(e) => set('status', e.target.value as Project['status'])}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="delivered">Delivered</option>
            </select>
          </Field>
          <Field label="GitHub repository" hint="owner/name — used to sync bugs and features with GitHub Issues">
            <input className="input" value={p.repo ?? ''} placeholder="acme/shop-app" onChange={(e) => set('repo', e.target.value || null)} />
          </Field>
          <Field label="Tech stack" hint="Comma separated">
            <input className="input" value={stackText} onChange={(e) => setStackText(e.target.value)} />
          </Field>
          <Field label="Description">
            <textarea className="input" rows={3} value={p.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  )
}
