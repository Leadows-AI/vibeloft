import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { AppTools } from './AppTools'
import { TeamCard } from './TeamCard'
import { rememberTab, tabFor } from '../nav'
import { LinkChips, LinkedProjectsCard } from './LinkedProjects'
import { parentProject } from '../../../shared/nesting'
import type { ChatMode, RepoInfo, SyncResult } from '../../../shared/types'
import type { AppCtx } from '../App'
import { api, customerName, dueLabel, fmtDate, KindBadge, Modal, projectStats, relTime } from '../ui'
import { Board } from './Board'
import { ProjectForm } from './ProjectForm'
import { ProjectTimeline } from './Timeline'
import { requestOpen, requestQuickOpen } from '../filesBridge'
import { TimerButton } from '../time'
import { Icon } from '../icons'
import { Dropdown } from './terminal/Dropdown'
import { ProjectTree } from './ProjectTree'
import { onRepoPicked } from './RepoPicker'
import { remember, remembered } from '../prefs'

// Heavy tabs load the first time they're opened, so the app starts fast:
// the code editor (Monaco), the terminal (xterm), chat and diagrams.
const Architecture = lazy(() => import('./Architecture').then((m) => ({ default: m.Architecture })))
const EnvPanel = lazy(() => import('./EnvPanel').then((m) => ({ default: m.EnvPanel })))
const FilesPanel = lazy(() => import('./FilesPanel').then((m) => ({ default: m.FilesPanel })))
const GitPanel = lazy(() => import('./GitPanel').then((m) => ({ default: m.GitPanel })))
const PreviewPanel = lazy(() => import('./PreviewPanel').then((m) => ({ default: m.PreviewPanel })))
import { ClaudeUsageCard } from './ClaudeUsageCard'
const MobilePanel = lazy(() => import('./MobilePanel').then((m) => ({ default: m.MobilePanel })))
const TimePanel = lazy(() => import('./TimePanel').then((m) => ({ default: m.TimePanel })))
const ReportModal = lazy(() => import('./ReportModal').then((m) => ({ default: m.ReportModal })))
const TerminalPanel = lazy(() => import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })))
const terminals = (): Promise<typeof import('../termStore')> => import('../termStore')

export type ProjectTab = 'overview' | 'board' | 'timeline' | 'time' | 'architecture' | 'files' | 'git' | 'preview' | 'mobile' | 'env' | 'terminal'

// In the order you work: the tabs you use every day, then the occasional
// ones, which live under "More".
const TABS: { id: ProjectTab; label: string; more?: true }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
  { id: 'git', label: 'Git' },
  { id: 'preview', label: 'Preview' },
  // Only shown for mobile app projects.
  { id: 'mobile', label: 'Mobile' },
  { id: 'board', label: 'Features & bugs' },
  { id: 'overview', label: 'Overview' },
  { id: 'timeline', label: 'Timeline', more: true },
  { id: 'time', label: 'Time', more: true },
  { id: 'architecture', label: 'Architecture', more: true },
  { id: 'env', label: 'Environment', more: true }
]

/** Send a task to Claude: in the chat panel, or as a new Claude Code terminal. */
/** Send a task to Claude Code in a new Terminal tab ('plan' = Plan mode, changes nothing). */
export type AskClaude = (prompt: string, mode: ChatMode, title?: string) => void

export function ProjectView(props: { ctx: AppCtx; projectId: string; initialTab?: ProjectTab }): ReactNode {
  const { ctx, projectId } = props
  const { db, setDb } = ctx
  const project = db.projects.find((p) => p.id === projectId)!
  const [tab, setTab] = useState<ProjectTab>(() => {
    const t = props.initialTab ?? tabFor(projectId, !!project.localPath)
    return TABS.some((x) => x.id === t) ? t : project.localPath ? 'terminal' : 'overview'
  })
  const [editing, setEditing] = useState(false)
  const [reporting, setReporting] = useState(false)
  // The file tree on the right: open by default, remembered across projects and restarts.
  const [treeOpen, setTreeOpen] = useState(() => remembered('projectTree', '1') === '1')
  const showTree = (open: boolean): void => {
    setTreeOpen(open)
    remember('projectTree', open ? '1' : '0')
  }
  const [info, setInfo] = useState<RepoInfo | null>(null)
  // Mobile app projects get a Mobile tab (build APK, install, device logs).
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    setIsMobile(false)
    if (project.localPath) void api.mobileInfo(projectId).then((m) => setIsMobile(!!m), () => setIsMobile(false))
  }, [projectId, project.localPath])
  const tabs = TABS.filter((t) => !t.more && (t.id !== 'mobile' || isMobile))
  const moreTabs = TABS.filter((t) => t.more)
  const inMore = moreTabs.find((t) => t.id === tab)
  const [sync, setSync] = useState<{ busy: boolean; result?: SyncResult; error?: string; quietError?: string }>({ busy: false })


  useEffect(() => {
    if (props.initialTab) setTab(props.initialTab)
  }, [props.initialTab])
  useEffect(() => rememberTab(projectId, tab), [projectId, tab])
  // A guided tour asks for a tab.
  useEffect(() => {
    const onGo = (e: Event): void => setTab((e as CustomEvent<{ tab: ProjectTab }>).detail.tab)
    window.addEventListener('vibeloft:goto-tab', onGo)
    return () => window.removeEventListener('vibeloft:goto-tab', onGo)
  }, [])

  useEffect(() => {
    if (project.localPath) api.repoInfo(project.localPath).then(setInfo)
  }, [project.localPath])

  // Watch the project folder so the file tree, git status and open files update by themselves.
  const [changeCount, setChangeCount] = useState(0)
  const [gitSync, setGitSync] = useState({ ahead: 0, behind: 0 })
  useEffect(() => {
    if (!project.localPath) return
    const refreshCount = (): void => {
      api.gitStatus(projectId).then(
        (s) => {
          setChangeCount(s.files.length)
          setGitSync({ ahead: s.ahead, behind: s.behind })
          setInfo((i) => (i && i.branch !== s.branch ? { ...i, branch: s.branch } : i))
        },
        () => setChangeCount(0)
      )
    }
    refreshCount()
    const offPick = onRepoPicked(projectId, refreshCount)
    api.watchProject(projectId).catch(() => {})
    let t: ReturnType<typeof setTimeout> | null = null
    const off = api.onFilesChanged((e) => {
      if (e.projectId !== projectId) return
      if (t) clearTimeout(t)
      t = setTimeout(refreshCount, 400)
    })
    return () => {
      off()
      offPick()
      if (t) clearTimeout(t)
      api.unwatchProject(projectId).catch(() => {})
    }
  }, [projectId, project.localPath])

  // A file path clicked in the terminal opens in the editor.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<{ projectId: string; rel: string; line?: number; col?: number }>).detail
      if (d.projectId !== projectId) return
      requestOpen(projectId, d.rel, d.line, d.col)
      setTab('files')
    }
    window.addEventListener('vibeloft:open-file', onOpen)
    return () => window.removeEventListener('vibeloft:open-file', onOpen)
  }, [projectId])

  // Ctrl+P from any tab: jump to the Files tab and open "Go to file".
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p' && tab !== 'files' && tab !== 'terminal') {
        e.preventDefault()
        requestQuickOpen(projectId)
        setTab('files')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, projectId])

  const ask: AskClaude = (prompt, mode, title) => {
    terminals().then((t) => t.openClaudeTask(projectId, { title: title ?? (mode === 'plan' ? 'Claude Code (Plan)' : 'Claude Code'), prompt, plan: mode === 'plan' }))
    setTab('terminal')
  }

  // quiet = auto-sync: no banner unless some items failed; a failed run only shows on the Sync button.
  const lastSync = useRef(0)
  async function runSync(quiet = false): Promise<void> {
    lastSync.current = Date.now()
    setSync((s) => (quiet ? { ...s, busy: true } : { busy: true }))
    try {
      const { db: next, result } = await api.syncIssues(projectId)
      setDb(next)
      setSync((s) => (quiet && !result.errors.length ? { busy: false, result: s.result } : { busy: false, result }))
    } catch (e) {
      const msg = (e as Error).message
      setSync((s) => (quiet ? { busy: false, result: s.result, quietError: msg } : { busy: false, error: msg }))
    }
  }

  // Auto-sync: when the project opens, every 2 minutes while the window is visible,
  // and when the window comes back into focus (at most every 30 s).
  useEffect(() => {
    if (!project.repo) return
    const tick = (): void => {
      if (document.visibilityState === 'visible') void runSync(true)
    }
    tick()
    const id = setInterval(tick, 2 * 60_000)
    const onFocus = (): void => {
      if (Date.now() - lastSync.current > 30_000) tick()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectId, project.repo])

  const [deleting, setDeleting] = useState(false)
  const remove = (): void => setDeleting(true)
  const archive = async (archived: boolean): Promise<void> => setDb(await api.archiveProject(projectId, archived))

  return (
    <div className="page project-page">
      {/* One row: the project (click for its details), the tabs, timer and actions. */}
      <header className="project-bar">
        <Dropdown
          label={
            <>
              <span className="project-title">{project.name}</span>
              <KindBadge kind={project.kind} />
              {project.status !== 'active' && <span className="badge">{project.status}</span>}
              <Icon name="chevronDown" size={14} />
            </>
          }
          className="project-name"
          title="Project details"
          align="left"
          width={440}
        >
          {() => (
            <div className="project-details">
              <dl className="details">
                <dt>Customer</dt>
                <dd>{customerName(db, project)}</dd>
                {project.repo && (
                  <>
                    <dt>Repository</dt>
                    <dd>
                      <button className="link" onClick={() => api.openUrl(`https://github.com/${project.repo}`)}>
                        {project.repo} <Icon name="external" size={12} />
                      </button>
                    </dd>
                  </>
                )}
                {info?.branch && (
                  <>
                    <dt>Branch</dt>
                    <dd>
                      <Icon name="branch" size={13} /> {info.branch}
                    </dd>
                  </>
                )}
              </dl>
              <LinkChips ctx={ctx} projectId={projectId} />
            </div>
          )}
        </Dropdown>
        <span className="project-bar-sep" aria-hidden="true" />
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
              {t.label}
              {t.id === 'git' && changeCount > 0 && (
                <span className="tab-count" title={`${changeCount} uncommitted change${changeCount === 1 ? '' : 's'}`}>
                  {changeCount}
                </span>
              )}
              {t.id === 'git' && changeCount === 0 && (gitSync.ahead > 0 || gitSync.behind > 0) && (
                <span className="tab-count sync" title={[gitSync.ahead ? `${gitSync.ahead} to push` : '', gitSync.behind ? `${gitSync.behind} to pull` : ''].filter(Boolean).join(', ')}>
                  {gitSync.ahead ? <><Icon name="arrowUp" size={11} />{gitSync.ahead}</> : ''}
                  {gitSync.behind ? <><Icon name="arrowDown" size={11} />{gitSync.behind}</> : ''}
                </span>
              )}
            </button>
          ))}
          <Dropdown
            label={
              <>
                {inMore?.label ?? 'More'} <Icon name="chevronDown" size={13} />
              </>
            }
            className={`tab-more ${inMore ? 'on' : ''}`}
            title="Timeline, Time, Architecture, Environment"
            align="left"
            width={220}
          >
            {(close) =>
              moreTabs.map((t) => (
                <button
                  key={t.id}
                  role="menuitem"
                  aria-current={tab === t.id ? 'page' : undefined}
                  onClick={() => {
                    close()
                    setTab(t.id)
                  }}
                >
                  <b>{t.label}</b>
                </button>
              ))
            }
          </Dropdown>
        </nav>
        <div className="grow" />
        <div className="row gap-s">
          {project.repo && (
            <button
              className={`btn icon-only ${sync.quietError ? 'warn' : ''}`}
              disabled={sync.busy}
              onClick={() => void runSync()}
              aria-label="Sync with GitHub"
              title={
                sync.busy
                  ? 'Syncing with GitHub…'
                  : sync.quietError
                    ? `Auto-sync failed: ${sync.quietError}\nClick to sync now.`
                    : `Sync with GitHub (syncs by itself every 2 minutes)\nLast synced ${relTime(project.lastSyncedAt)}`
              }
            >
              <Icon name="sync" size={16} className={sync.busy ? 'spin' : ''} />
            </button>
          )}
          <TimerButton db={db} projectId={projectId} setDb={setDb} />
          <Dropdown
            label={<Icon name="more" size={18} />}
            className="btn icon-only"
            title="More: sync with GitHub, status report, edit project"
            width={260}
          >
            {(close) => (
              <>
                {project.repo && (
                  <button
                    role="menuitem"
                    disabled={sync.busy}
                    onClick={() => {
                      close()
                      void runSync()
                    }}
                  >
                    <b>
                      <Icon name="sync" size={15} /> {sync.busy ? 'Syncing…' : 'Sync with GitHub'}
                    </b>
                    <span>Two-way sync of bugs, features and milestones</span>
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    close()
                    setReporting(true)
                  }}
                >
                  <b>
                    <Icon name="report" size={15} /> Status report
                  </b>
                  <span>For the customer: PDF, text or email</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    close()
                    setEditing(true)
                  }}
                >
                  <b>
                    <Icon name="edit" size={15} /> Edit project
                  </b>
                  <span>Name, customer, folder, repo</span>
                </button>
                {project.localPath && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      close()
                      void api.openFolder(project.localPath!)
                    }}
                  >
                    <b>
                      <Icon name="external" size={15} /> Open folder
                    </b>
                    <span>The project folder, in {api.platform === 'darwin' ? 'Finder' : 'File Explorer'}</span>
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    close()
                    void archive(!project.archivedAt)
                  }}
                >
                  <b>
                    <Icon name="archive" size={15} /> {project.archivedAt ? 'Restore project' : 'Archive project'}
                  </b>
                  <span>{project.archivedAt ? 'Show it in the sidebar and dashboard again' : 'Hide it and close its terminals; nothing is lost'}</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    close()
                    remove()
                  }}
                >
                  <b>
                    <Icon name="trash" size={15} /> Delete project…
                  </b>
                  <span>Remove it from Vibeloft for good</span>
                </button>
              </>
            )}
          </Dropdown>
          <span className="project-bar-sep" aria-hidden="true" />
          <AppTools ctx={ctx} />
        </div>
      </header>

      {sync.result && (
        <div className={`notice ${sync.result.errors.length ? 'warn' : 'ok'}`} onClick={() => setSync({ busy: false })}>
          Synced with GitHub: {sync.result.pulled} issues imported, {sync.result.created} created, {sync.result.updated} updated, {sync.result.milestones ?? 0} milestone changes.
          {sync.result.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
      {project.archivedAt && (
        <div className="notice row between">
          <span>This project is archived, so it's hidden from the sidebar and dashboard.</span>
          <button className="btn" onClick={() => void archive(false)}>
            Restore
          </button>
        </div>
      )}
      {sync.error && (
        <div className="notice bad" onClick={() => setSync({ busy: false })}>
          {sync.error}
        </div>
      )}

      {/* Header and tabs stay put; only this area scrolls. Editor, terminal and
          chat fill it exactly and scroll inside themselves. */}
      <div className="project-body">
      <div className={`tab-body ${tab === 'files' || tab === 'git' || tab === 'preview' || tab === 'terminal' ? 'fill' : ''}`}>
        <Suspense fallback={<p className="muted pad">Loading…</p>}>
        {tab === 'overview' && <Overview ctx={ctx} projectId={projectId} info={info} onRemove={remove} go={setTab} ask={ask} />}
        {tab === 'board' && <Board ctx={ctx} projectId={projectId} ask={ask} />}
        {tab === 'timeline' && <ProjectTimeline ctx={ctx} projectId={projectId} />}
        {tab === 'architecture' && <Architecture ctx={ctx} projectId={projectId} />}
        {tab === 'files' && <FilesPanel ctx={ctx} projectId={projectId} ask={ask} goTab={setTab} />}
        {tab === 'git' && <GitPanel ctx={ctx} projectId={projectId} goTab={setTab} />}
        {tab === 'time' && <TimePanel ctx={ctx} projectId={projectId} />}
        {tab === 'preview' && <PreviewPanel ctx={ctx} projectId={projectId} />}
        {tab === 'mobile' && <MobilePanel ctx={ctx} projectId={projectId} goTab={setTab} />}
        {tab === 'env' && <EnvPanel ctx={ctx} projectId={projectId} />}
        {tab === 'terminal' && <TerminalPanel ctx={ctx} projectId={projectId} goTab={setTab} />}
        </Suspense>
      </div>
      {/* The Files tab has its own tree. */}
      {project.localPath && tab !== 'files' &&
        (treeOpen ? (
          <ProjectTree
            ctx={ctx}
            projectId={projectId}
            folder={project.localPath}
            onOpen={(rel) => {
              requestOpen(projectId, rel)
              setTab('files')
            }}
            onCollapse={() => showTree(false)}
          />
        ) : (
          <button className="project-tree-rail" title="Show the file tree" aria-label="Show the file tree" onClick={() => showTree(true)}>
            <Icon name="panelRight" size={16} />
            <span>Files</span>
          </button>
        ))}
      </div>

      {reporting && (
        <Suspense fallback={null}>
          <ReportModal ctx={ctx} projectIds={[projectId]} title={project.name} onClose={() => setReporting(false)} />
        </Suspense>
      )}
      {deleting && <DeleteProject ctx={ctx} projectId={projectId} onClose={() => setDeleting(false)} />}
      {editing && <ProjectForm ctx={ctx} project={project} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
    </div>
  )
}

function Overview(props: {
  ctx: AppCtx
  projectId: string
  info: RepoInfo | null
  onRemove: () => void
  go: (t: ProjectTab) => void
  ask: AskClaude
}): ReactNode {
  const { db } = props.ctx
  const p = db.projects.find((x) => x.id === props.projectId)!
  const s = projectStats(db, p.id)
  const [commitAt, commitMsg] = props.info?.lastCommit?.split('|') ?? []
  const milestones = db.milestones
    .filter((m) => m.projectId === p.id && m.status !== 'delivered')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const urgent = db.workItems
    .filter((w) => w.projectId === p.id && w.status !== 'done')
    .sort((a, b) => rank(b.priority) - rank(a.priority))
    .slice(0, 6)

  return (
    <div className="overview">
      <div className="overview-main">
        <section className="tiles">
          <div className="tile clickable" onClick={() => props.go('board')}>
            <div className={`tile-value ${s.criticalBugs ? 'bad' : ''}`}>{s.openBugs}</div>
            <div className="tile-label">Open bugs</div>
          </div>
          <div className="tile clickable" onClick={() => props.go('board')}>
            <div className="tile-value">{s.openFeatures}</div>
            <div className="tile-label">Open features</div>
          </div>
          <div className="tile clickable" onClick={() => props.go('board')}>
            <div className="tile-value">{s.featuresInProgress}</div>
            <div className="tile-label">In progress</div>
          </div>
          <div className="tile">
            <div className="tile-value">{s.totalItems ? Math.round((s.doneItems / s.totalItems) * 100) : 0}%</div>
            <div className="tile-label">Items done</div>
          </div>
        </section>

        {p.localPath && <ClaudeUsageCard projectId={p.id} />}

        <section className="card">
          <div className="card-head">
            <h3>Needs attention</h3>
            <button className="link" onClick={() => props.go('board')}>
              Open board →
            </button>
          </div>
          {urgent.length === 0 ? (
            <p className="muted">Nothing open. Add features or bugs on the board, or sync from GitHub.</p>
          ) : (
            <ul className="list">
              {urgent.map((w) => (
                <li key={w.id}>
                  <span className={`kind-tag ${w.kind}`}>{w.kind === 'bug' ? 'Bug' : 'Feature'}</span>
                  <span className="grow">{w.title}</span>
                  <span className={`prio ${w.priority}`}>{w.priority}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Ask Claude</h3>
          </div>
          <div className="quick-asks">
            <button className="btn" onClick={() => props.ask('Give me a short status report on this codebase: what was worked on recently (check git log), what looks unfinished, and the top 3 risks.', 'plan')}>
              Status report
            </button>
            <button className="btn" onClick={() => props.ask('Review the open bugs listed in your context. For each one, find the likely cause in the code and suggest a fix. Do not change any files.', 'plan')}>
              Triage open bugs
            </button>
            <button className="btn" onClick={() => props.ask('Check this project for outdated or vulnerable dependencies and missing tests. Summarize what to fix first.', 'plan')}>
              Health check
            </button>
          </div>
        </section>
      </div>

      <aside className="overview-side">
        {p.repo && <TeamCard ctx={props.ctx} projectId={p.id} repo={p.repo} />}
        <LinkedProjectsCard ctx={props.ctx} projectId={props.projectId} goTab={props.go} />
        <section className="card">
          <h3>Details</h3>
          <dl className="details">
            <dt>Customer</dt>
            <dd>{customerName(db, p)}</dd>
            <dt>Repository</dt>
            <dd>
              {p.repo ? (
                <button className="link" onClick={() => api.openUrl(`https://github.com/${p.repo}`)}>
                  {p.repo} <Icon name="external" size={12} />
                </button>
              ) : (
                '—'
              )}
            </dd>
            <dt>Folder</dt>
            <dd>
              {p.localPath ? (
                <button className="link" onClick={() => api.openFolder(p.localPath!)} title={p.localPath}>
                  {p.localPath.split(/[\\/]/).pop()} <Icon name="external" size={12} />
                </button>
              ) : (
                '—'
              )}
            </dd>
            <dt>Last commit</dt>
            <dd title={commitMsg}>{commitAt ? `${relTime(commitAt)} — ${commitMsg}` : '—'}</dd>
            <dt>Working tree</dt>
            <dd>{props.info ? (props.info.dirty ? 'Uncommitted changes' : 'Clean') : '—'}</dd>
            <dt>Issues synced</dt>
            <dd>{relTime(p.lastSyncedAt)}</dd>
            <dt>Stack</dt>
            <dd>
              <div className="chips">
                {p.techStack.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </div>
            </dd>
          </dl>
          {p.description && <p className="desc">{p.description}</p>}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Deliveries</h3>
            <button className="link" onClick={() => props.go('timeline')}>
              Edit →
            </button>
          </div>
          {milestones.length === 0 && <p className="muted">No upcoming milestones.</p>}
          {milestones.map((m) => {
            const due = dueLabel(m.dueDate)
            return (
              <div key={m.id} className="mini-milestone">
                <div>
                  <div>{m.title}</div>
                  <div className="muted small">{fmtDate(m.dueDate)}</div>
                </div>
                <span className={`pill ${due.tone}`}>{due.text}</span>
              </div>
            )
          })}
        </section>

        <button className="btn danger ghost" onClick={props.onRemove}>
          <Icon name="trash" size={15} /> Delete project…
        </button>
      </aside>
    </div>
  )
}

const rank = (p: string): number => ({ low: 0, medium: 1, high: 2, critical: 3 })[p] ?? 0

/** Confirm deleting a project; optionally move its folder to the Recycle Bin / Trash too. */
function DeleteProject(props: { ctx: AppCtx; projectId: string; onClose: () => void }): ReactNode {
  const { ctx } = props
  const project = ctx.db.projects.find((p) => p.id === props.projectId)!
  const [trash, setTrash] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const bin = api.platform === 'darwin' ? 'Trash' : 'Recycle Bin'
  const nested = ctx.db.projects.filter((p) => parentProject(p, [project]))

  async function del(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const next = await api.deleteProject(project.id, trash)
      ctx.go({ view: 'dashboard' })
      ctx.setDb(next)
    } catch (e) {
      setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Delete “${project.name}”?`}
      onClose={props.onClose}
      footer={
        <>
          {!project.archivedAt && (
            <button
              className="btn"
              onClick={async () => {
                ctx.setDb(await api.archiveProject(project.id, true))
                props.onClose()
              }}
            >
              <Icon name="archive" size={15} /> Archive instead
            </button>
          )}
          <button className="btn danger" disabled={busy} onClick={() => void del()}>
            <Icon name="trash" size={15} /> {busy ? 'Deleting…' : trash ? 'Delete project and folder' : 'Delete project'}
          </button>
        </>
      }
    >
      <p>
        This removes the project from Vibeloft, with its features, bugs, deliveries, tracked time and chat. It can't be undone. To hide it
        and keep everything, archive it instead.
      </p>
      {project.localPath && (
        <label className="check">
          <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} />
          <span>
            Also move the project folder to the {bin}
            <br />
            <code className="muted small" style={{ overflowWrap: 'anywhere' }}>
              {project.localPath}
            </code>
          </span>
        </label>
      )}
      {trash && nested.length > 0 && (
        <div className="notice warn">
          This folder also holds the folders of other projects, which will be moved to the {bin} with it: {nested.map((p) => p.name).join(', ')}
        </div>
      )}
      <p className="muted small">The GitHub repository and its issues are not touched.</p>
      {error && <div className="notice bad">{error}</div>}
    </Modal>
  )
}
