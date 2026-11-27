import { useEffect, useState, type ReactNode } from 'react'
import type { GhRepo, Project } from '../../../shared/types'
import type { AppCtx } from '../App'
import { Icon, type IconName } from '../icons'
import { api, Field, Modal, nowIso, uid } from '../ui'

type Source = 'folder' | 'github' | 'template'

const SOURCES: { id: Source; icon: IconName; title: string; text: string }[] = [
  { id: 'folder', icon: 'folderPlus', title: 'On this computer', text: 'A code folder you already have' },
  { id: 'github', icon: 'branch', title: 'On GitHub', text: 'Clone one of your repositories' },
  { id: 'template', icon: 'sparkle', title: 'Start fresh', text: 'A ready-to-run web or mobile app' }
]

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

/** "owner/name", "https://github.com/owner/name(.git)" or "git@github.com:owner/name.git" -> "owner/name". */
function repoSlug(text: string): string | null {
  const t = text.trim()
  const m = t.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i) ?? t.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

const cleanError = (e: unknown): string => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

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
  const [newCustomer, setNewCustomer] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stackText, setStackText] = useState(p.techStack.join(', '))
  // Where clones and new projects go.
  const [parentDir, setParentDir] = useState<string | null>(db.settings.projectsRoot)

  // GitHub
  const [repos, setRepos] = useState<GhRepo[] | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)

  // Template
  const [template, setTemplate] = useState<'web' | 'mobile'>('web')
  const [createRepo, setCreateRepo] = useState(true)
  const [gh, setGh] = useState<{ ok: boolean; message: string } | null>(null)

  const set = <K extends keyof Project>(k: K, v: Project[K]): void => setP((x) => ({ ...x, [k]: v }))

  useEffect(() => {
    if ((source === 'github' || source === 'template') && gh === null) {
      api.ghStatus().then(setGh, () => setGh({ ok: false, message: 'GitHub CLI (gh) is not installed. Get it from cli.github.com.' }))
    }
  }, [source])

  function loadRepos(): void {
    setRepos(null)
    setReposError(null)
    api.ghListRepos().then(setRepos, (e) => setReposError(cleanError(e)))
  }
  useEffect(() => {
    if (source === 'github' && gh?.ok && repos === null && !reposError) loadRepos()
  }, [source, gh])

  async function pickFolder(): Promise<void> {
    const path = await api.pickFolder()
    if (!path) return
    const info = await api.inspectFolder(path)
    setP((x) => ({ ...x, localPath: path, repo: info.repo ?? x.repo, kind: info.kind, name: x.name || info.name }))
    if (info.techStack.length) setStackText(info.techStack.join(', '))
  }

  async function browseParent(): Promise<void> {
    const d = await api.pickFolder()
    if (d) setParentDir(d)
  }

  /** Creates the new customer if one was typed; returns the id and name to use. */
  async function resolveCustomer(): Promise<{ customerId: string | null; customerName: string | null }> {
    if (newCustomer?.trim()) {
      const customerId = uid()
      await api.saveCustomer({ id: customerId, name: newCustomer.trim() })
      return { customerId, customerName: newCustomer.trim() }
    }
    return { customerId: p.customerId, customerName: db.customers.find((c) => c.id === p.customerId)?.name ?? null }
  }

  const pickedName = picked?.split('/')[1] ?? ''
  const autoName = source === 'github' ? pickedName : ''
  const name = p.name.trim() || autoName

  // Why the primary button is disabled (null = ready).
  const missing = editing
    ? !name && 'Give the project a name.'
    : source === 'folder'
      ? (!p.localPath && 'Choose the project folder.') || (!name && 'Give the project a name.')
      : source === 'github'
        ? (!picked && 'Pick a repository.') || (!parentDir && 'Choose where to clone it.')
        : (!name && 'Give the project a name.') || (!parentDir && 'Choose where to create it.')

  async function submit(): Promise<void> {
    if (missing || busy) return
    setError(null)
    try {
      if (!editing && source === 'template') return await createFromTemplate()
      let project: Project = {
        ...p,
        name,
        repo: repoSlug(p.repo ?? '') ?? (p.repo?.trim() || null),
        techStack: stackText.split(',').map((s) => s.trim()).filter(Boolean)
      }
      if (!editing && source === 'github' && picked) {
        setBusy(`Cloning ${picked}…`)
        const path = await api.ghClone(picked, parentDir!)
        const info = await api.inspectFolder(path)
        project = { ...project, localPath: path, repo: picked, kind: info.kind, techStack: info.techStack }
      }
      const { customerId } = await resolveCustomer()
      setDb(await api.saveProject({ ...project, customerId }))
      props.onSaved(p.id)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  async function createFromTemplate(): Promise<void> {
    setBusy(template === 'mobile' ? 'Creating the Expo app… this downloads the template and takes about a minute.' : 'Creating the project…')
    const { customerId, customerName } = await resolveCustomer()
    const r = await api.createFromTemplate({
      template,
      name,
      parentDir: parentDir!,
      customerName,
      description: p.description.trim(),
      createGithubRepo: createRepo && !!gh?.ok
    })
    setDb(
      await api.saveProject({
        ...p,
        name,
        customerId,
        kind: template,
        localPath: r.path,
        repo: r.repo,
        techStack: template === 'web' ? ['React', 'Vite', 'Express', 'TypeScript'] : ['Expo', 'React Native', 'TypeScript']
      })
    )
    if (r.notes.length) alert(r.notes.join('\n\n'))
    // Install dependencies in a terminal tab so progress is visible.
    const t = await import('../termStore')
    await t.openTerminal(p.id, { title: 'npm install', command: r.installCommand })
    props.onSaved(p.id, 'terminal')
  }

  // ---------- pieces ----------

  const folderRow = (value: string | null, placeholder: string, onBrowse: () => void): ReactNode => (
    <div className="row gap-s">
      <input className="input" value={value ?? ''} placeholder={placeholder} readOnly />
      <button type="button" className="btn" onClick={onBrowse}>
        Browse…
      </button>
    </div>
  )

  const nameField = (
    <Field label="Project name">
      <input className="input" value={p.name} placeholder={autoName || 'e.g. Acme Booking App'} onChange={(e) => set('name', e.target.value)} />
    </Field>
  )

  const customerField = (
    <Field label="Customer">
      <select
        className="input"
        value={newCustomer !== null ? '__new' : (p.customerId ?? '')}
        onChange={(e) => {
          setNewCustomer(e.target.value === '__new' ? '' : null)
          if (e.target.value !== '__new') set('customerId', e.target.value || null)
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
      {newCustomer !== null && (
        <input className="input" value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)} placeholder="New customer's name" autoFocus />
      )}
    </Field>
  )

  const settingsFields = (
    <>
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
      <Field label="GitHub repository" hint="owner/name or a GitHub link. Bugs and features sync with its Issues.">
        <input className="input" value={p.repo ?? ''} placeholder="acme/shop-app" onChange={(e) => set('repo', e.target.value || null)} />
      </Field>
      <Field label="Tech stack" hint="Comma separated">
        <input className="input" value={stackText} onChange={(e) => setStackText(e.target.value)} />
      </Field>
    </>
  )

  const ghSignIn = gh && !gh.ok && <div className="notice warn">{gh.message} Then reopen this dialog.</div>

  // ---------- sources ----------

  function folderSource(): ReactNode {
    return (
      <>
        <Field label="Project folder" hint="The code on this computer. Claude works inside this folder.">
          {folderRow(p.localPath, 'Choose a folder…', pickFolder)}
        </Field>
        {p.localPath && (
          <>
            <div className="form-grid">
              {nameField}
              {customerField}
            </div>
            <details className="more-options">
              <summary>
                Detected settings
                <span className="muted small">
                  {' '}
                  · {p.kind === 'web' ? 'Web app' : p.kind === 'mobile' ? 'Mobile app' : 'Other'}
                  {p.repo ? ` · ${p.repo}` : ' · no GitHub repository'}
                </span>
              </summary>
              <div className="form-grid">{settingsFields}</div>
            </details>
          </>
        )}
      </>
    )
  }

  function githubSource(): ReactNode {
    if (gh === null) return <p className="muted">Checking GitHub sign-in…</p>
    if (!gh.ok) return ghSignIn
    const pasted = repoSlug(query)
    const q = query.trim().toLowerCase()
    const shown = (repos ?? []).filter((r) => r.nameWithOwner.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q))
    const pastedIsNew = pasted && !shown.some((r) => r.nameWithOwner.toLowerCase() === pasted.toLowerCase())
    return (
      <>
        <div className="repo-picker">
          <input
            className="input"
            placeholder="Search your repositories, or paste a GitHub link"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="repo-list" role="listbox" aria-label="Repositories">
            {pastedIsNew && (
              <button className={`repo-row ${picked === pasted ? 'on' : ''}`} role="option" aria-selected={picked === pasted} onClick={() => setPicked(pasted)}>
                <span>
                  <Icon name="link" size={13} /> {pasted}
                </span>
                <span className="muted small">Clone this repository</span>
              </button>
            )}
            {shown.map((r) => (
              <button
                key={r.nameWithOwner}
                className={`repo-row ${picked === r.nameWithOwner ? 'on' : ''}`}
                role="option"
                aria-selected={picked === r.nameWithOwner}
                onClick={() => setPicked(r.nameWithOwner)}
                onDoubleClick={submit}
              >
                <span>
                  <span className="muted">{r.nameWithOwner.split('/')[0]}/</span>
                  <b>{r.nameWithOwner.split('/')[1]}</b> {r.isPrivate && <span className="badge">private</span>}
                </span>
                {r.description && <span className="muted small">{r.description}</span>}
              </button>
            ))}
            {!repos && !reposError && <p className="muted pad">Loading your repositories…</p>}
            {reposError && (
              <p className="pad bad-text">
                Couldn't list repositories: {reposError}{' '}
                <button className="btn" onClick={loadRepos}>
                  Try again
                </button>
              </p>
            )}
            {repos && shown.length === 0 && !pastedIsNew && <p className="muted pad">No repository matches “{query}”. Paste its GitHub link to clone it anyway.</p>}
          </div>
        </div>
        {picked && (
          <div className="form-grid">
            <Field label="Clone into" hint={`Creates ${parentDir ? `${parentDir}${parentDir.includes('\\') ? '\\' : '/'}${pickedName}` : `a folder named ${pickedName}`}. If it's already cloned there, that copy is used.`}>
              {folderRow(parentDir, 'Choose a folder…', browseParent)}
            </Field>
            {customerField}
            {nameField}
          </div>
        )}
      </>
    )
  }

  function templateSource(): ReactNode {
    return (
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
        {nameField}
        {customerField}
        <Field label="Create in" hint="A new folder named after the project is created here.">
          {folderRow(parentDir, 'Choose a folder…', browseParent)}
        </Field>
        <Field label="Description" hint="Goes into the README and CLAUDE.md, so Claude knows what the app is for.">
          <textarea className="input" rows={2} value={p.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <label className="check span-all">
          <input type="checkbox" checked={createRepo && !!gh?.ok} disabled={!gh?.ok} onChange={(e) => setCreateRepo(e.target.checked)} />
          Also create a private GitHub repository and push the first commit
          {gh && !gh.ok && <span className="muted small"> ({gh.message})</span>}
        </label>
        <p className="muted small span-all">
          Includes a CLAUDE.md with this project's context, a .gitignore that keeps .env secrets out of git, and a first commit. Dependencies install in a
          terminal tab afterwards.
        </p>
      </div>
    )
  }

  const action = editing ? 'Save' : source === 'folder' ? 'Add project' : source === 'github' ? 'Clone and add' : 'Create project'

  return (
    <Modal
      title={editing ? 'Edit project' : 'Add a project'}
      onClose={props.onClose}
      wide
      footer={
        <>
          {missing && !busy && <span className="muted small foot-hint">{missing}</span>}
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!!missing || !!busy}>
            {busy ? 'Working…' : action}
          </button>
        </>
      }
    >
      <form
        className="project-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <fieldset disabled={!!busy} className="plain">
          {!editing && (
            <div className="source-picks" role="radiogroup" aria-label="Where is the code?">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={source === s.id}
                  className={`source-card ${source === s.id ? 'on' : ''}`}
                  onClick={() => {
                    setSource(s.id)
                    setError(null)
                  }}
                >
                  <Icon name={s.icon} size={18} />
                  <b>{s.title}</b>
                  <span>{s.text}</span>
                </button>
              ))}
            </div>
          )}

          {editing ? (
            <div className="form-grid">
              <Field label="Project folder" hint="The code on this computer. Claude works inside this folder.">
                {folderRow(p.localPath, 'Choose a folder…', pickFolder)}
              </Field>
              {nameField}
              {customerField}
              {settingsFields}
              <Field label="Description">
                <textarea className="input" rows={3} value={p.description} onChange={(e) => set('description', e.target.value)} />
              </Field>
            </div>
          ) : source === 'folder' ? (
            folderSource()
          ) : source === 'github' ? (
            githubSource()
          ) : (
            templateSource()
          )}
          {/* Enter submits. */}
          <button type="submit" hidden />
        </fieldset>
      </form>

      {busy && <div className="notice">{busy}</div>}
      {error && <div className="notice bad">{error}</div>}
    </Modal>
  )
}
