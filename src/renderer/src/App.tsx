import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { parentProject } from '../../shared/nesting'
import type { Database, Project } from '../../shared/types'
import { Customers } from './components/Customers'
import { Dashboard } from './components/Dashboard'
import { ProjectForm } from './components/ProjectForm'
import { ProjectView, type ProjectTab } from './components/ProjectView'
import { SettingsView } from './components/SettingsView'
import { TimelineAll } from './components/Timeline'
import mark from './assets/vibeloft-mark.svg'
import { useWaitingProjects } from './attention'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { SetupCheck, setupReady } from './components/SetupCheck'
import { pendingForProject, setLinks, useLinkStatuses } from './links'
import { SidebarTimer } from './time'
import { SidebarVersion, UpdateNotice } from './updates'
import { Icon, type IconName } from './icons'
import { markDone, setWelcomed, welcomed } from './help/progress'
import type { Screen, TourId } from './help/topics'
import type { TourStep } from './help/tours'
import { tabFor } from './nav'
import { applyFonts } from './fonts'
import { remember, remembered } from './prefs'

const HelpPanel = lazy(() => import('./help/HelpPanel').then((m) => ({ default: m.HelpPanel })))
const Tour = lazy(() => import('./help/Tour').then((m) => ({ default: m.Tour })))
import { api, customerName, projectStats } from './ui'

export type Route =
  | { view: 'dashboard' }
  | { view: 'timeline' }
  | { view: 'customers' }
  | { view: 'settings' }
  | { view: 'project'; id: string; tab?: ProjectTab }

export interface AppCtx {
  db: Database
  /** The theme actually shown (resolves 'system'). */
  theme: 'dark' | 'light'
  setDb: (db: Database) => void
  go: (r: Route) => void
  newProject: () => void
  /** Open or close the help panel (F1). */
  toggleHelp: () => void
}

export default function App(): ReactNode {
  const [db, setDb] = useState<Database | null>(null)
  const [route, setRoute] = useState<Route>({ view: 'dashboard' })
  const [creating, setCreating] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tour, setTour] = useState<TourId | null>(null)
  const [welcome, setWelcome] = useState(false)
  // Is everything needed installed and signed in? (null: still checking)
  const [setupOk, setSetupOk] = useState<boolean | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)

  useEffect(() => {
    api.getDb().then(setDb)
  }, [])

  const theme = useResolvedTheme(db?.settings.theme ?? 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    if (db) applyFonts(db.settings)
  }, [
    db?.settings.uiFont,
    db?.settings.monoFont,
    db?.settings.uiFontScale,
    db?.settings.uiFontWeight,
    db?.settings.monoFontSize,
    db?.settings.monoFontWeight,
    db?.settings.terminalBg,
    db?.settings.terminalFg,
    db?.settings.uiBg,
    db?.settings.uiFg
  ])

  // The sidebar can be collapsed to an icon rail while a project is open.
  const [navHidden, setNavHidden] = useState(() => remembered('sidebar', 'open') === 'collapsed')
  const toggleNav = (): void => {
    setNavHidden(!navHidden)
    remember('sidebar', navHidden ? 'open' : 'collapsed')
  }

  const go = useCallback((r: Route) => setRoute(r), [])
  const waiting = useWaitingProjects()
  const linkStatuses = useLinkStatuses()

  // Linked projects: keep their "API changed" status fresh.
  useEffect(() => {
    if (db) setLinks(db.links)
  }, [db?.links])

  // First time Vibeloft opens: a short welcome.
  useEffect(() => {
    if (db && !welcomed()) setWelcome(true)
  }, [!!db])

  // Check once at start whether Claude Code, sign-in and Git are ready.
  useEffect(() => {
    if (!db) return
    api.setupStatus().then(
      (s) => setSetupOk(setupReady(s)),
      () => setSetupOk(null)
    )
  }, [!!db])

  // F1: help for the screen you're on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F1') return
      e.preventDefault()
      setHelpOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Ctrl+K (Cmd+K on a Mac): switch project. The code editor keeps Ctrl+K for its own shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = api.platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return
      if ((e.target as HTMLElement | null)?.closest?.('.monaco-editor')) return
      e.preventDefault()
      setSwitching((s) => !s)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Clicking a "Claude Code needs you" notification opens that project's terminal.
  useEffect(() => {
    const onGoto = (e: Event): void => {
      const { projectId } = (e as CustomEvent<{ projectId: string }>).detail
      setRoute({ view: 'project', id: projectId, tab: 'terminal' })
    }
    window.addEventListener('vibeloft:goto-terminal', onGoto)
    return () => window.removeEventListener('vibeloft:goto-terminal', onGoto)
  }, [])
  const newProject = useCallback(() => setCreating(true), [])

  const grouped = useMemo(() => {
    if (!db) return []
    const groups = new Map<string, Project[]>()
    const visible = db.projects.filter((p) => !p.archivedAt)
    for (const p of visible) {
      // Sub-projects are listed under their parent, not in a group of their own.
      if (parentProject(p, visible)) continue
      const key = customerName(db, p)
      groups.set(key, [...(groups.get(key) ?? []), p])
    }
    return [...groups.entries()].sort(([a], [b]) => (a === 'No customer' ? 1 : b === 'No customer' ? -1 : a.localeCompare(b)))
  }, [db])

  if (!db) return <div className="loading">Loading…</div>

  const visibleProjects = db.projects.filter((p) => !p.archivedAt)
  const projectLink = (p: Project, depth: number): ReactNode => {
    const s = projectStats(db, p.id)
    return (
      <Fragment key={p.id}>
        <button
          className={`project-link ${activeProject === p.id ? 'active' : ''}`}
          style={depth ? { paddingLeft: 10 + depth * 15 } : undefined}
          onClick={() => go({ view: 'project', id: p.id })}
        >
          <span className={`dot kind-${p.kind}`} />
          <span className="project-link-name">{p.name}</span>
          {waiting.has(p.id) && <span className="waiting-dot" title="Claude Code is waiting for you" />}
          {pendingForProject(db, p.id, linkStatuses) > 0 && (
            <span className="count api" title="The API this app uses has changed since it was last updated">
              API
            </span>
          )}
          {s.openBugs > 0 && <span className="count bad">{s.openBugs}</span>}
        </button>
        {visibleProjects.filter((c) => parentProject(c, visibleProjects)?.id === p.id).map((c) => projectLink(c, depth + 1))}
      </Fragment>
    )
  }

  const ctx: AppCtx = { db, theme, setDb, go, newProject, toggleHelp: () => setHelpOpen((o) => !o) }
  const activeProject = route.view === 'project' ? route.id : null
  const screen: Screen =
    route.view === 'project'
      ? (`project:${tabFor(route.id, !!db.projects.find((p) => p.id === route.id)?.localPath)}` as Screen)
      : route.view

  const startTour = (id: TourId): void => {
    setHelpOpen(false)
    setWelcome(false)
    setWelcomed()
    setTour(id)
  }

  /** Take a tour step to its screen: a main view, or a tab of a project (the open one, else the first with a folder). */
  const tourGo = (step: TourStep): void => {
    const g = step.go
    if (!g) return
    if ('view' in g) return go({ view: g.view })
    if (route.view === 'project') {
      window.dispatchEvent(new CustomEvent('vibeloft:goto-tab', { detail: { tab: g.project } }))
      return
    }
    const p = db.projects.find((x) => x.localPath) ?? db.projects[0]
    if (p) go({ view: 'project', id: p.id, tab: g.project })
  }

  return (
    <div className={`app ${navHidden && route.view === 'project' ? 'nav-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark-img" src={mark} alt="" draggable={false} />
          <div className="brand-text">
            <span className="brand-title">
              <span className="brand-word">
                Vibe<span>loft</span>
              </span>
              <span className="brand-by" title="Vibeloft is an independent project built on Claude Code. It is not an Anthropic product.">
                by Leadows
              </span>
            </span>
            <span className="brand-tagline">A room for every project.</span>
          </div>
          {route.view === 'project' && (
            <button
              className="icon-btn nav-toggle"
              title={navHidden ? 'Expand the sidebar' : 'Collapse the sidebar'}
              aria-label={navHidden ? 'Expand the sidebar' : 'Collapse the sidebar'}
              aria-expanded={!navHidden}
              onClick={toggleNav}
            >
              <Icon name="panelLeft" size={17} />
              {navHidden && waiting.size > 0 && <span className="waiting-dot" title="Claude Code is waiting for you in a project" />}
            </button>
          )}
        </div>
        <nav className="nav">
          <NavItem active={route.view === 'dashboard'} onClick={() => go({ view: 'dashboard' })} icon="dashboard" label="Dashboard" />
          <NavItem active={route.view === 'timeline'} onClick={() => go({ view: 'timeline' })} icon="flag" label="Deliveries" />
          <NavItem active={route.view === 'customers'} onClick={() => go({ view: 'customers' })} icon="users" label="Customers" />
          <NavItem active={route.view === 'settings'} onClick={() => go({ view: 'settings' })} icon="sliders" label="Settings" />
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-section-head">
            <span>Projects</span>
            <button className="icon-btn small" title="New project" aria-label="New project" onClick={newProject}>
              <Icon name="plus" size={15} />
            </button>
          </div>
          <button className="find-project" onClick={() => setSwitching(true)} title="Find and open any project">
            <Icon name="search" size={15} />
            <span>Find a project</span>
            <kbd>{api.platform === 'darwin' ? '⌘K' : 'Ctrl+K'}</kbd>
          </button>
          <div className="project-list">
            {grouped.map(([customer, projects]) => (
              <div key={customer} className="project-group">
                <div className="project-group-name">{customer}</div>
                {projects.map((p) => projectLink(p, 0))}
              </div>
            ))}
            {grouped.length === 0 && <p className="muted small pad">{db.projects.length ? 'All projects are archived.' : 'No projects yet.'}</p>}
          </div>
        </div>

        <SidebarTimer db={db} setDb={setDb} onOpen={(id) => go({ view: 'project', id, tab: 'time' })} />
        <UpdateNotice />
        {setupOk === false && !welcome && (
          <button className="setup-nudge" onClick={() => setSetupOpen(true)} title="Claude Code, sign-in or Git still needs setting up">
            <Icon name="sparkle" size={15} />
            <span>Finish setup</span>
          </button>
        )}
        <SidebarVersion />
      </aside>

      <main className="main">
        {route.view === 'dashboard' && <Dashboard ctx={ctx} />}
        {route.view === 'timeline' && <TimelineAll ctx={ctx} />}
        {route.view === 'customers' && <Customers ctx={ctx} />}
        {route.view === 'settings' && <SettingsView ctx={ctx} />}
        {route.view === 'project' && db.projects.some((p) => p.id === route.id) && (
          <ProjectView key={route.id} ctx={ctx} projectId={route.id} initialTab={route.tab} />
        )}
      </main>

      {helpOpen && (
        <Suspense fallback={null}>
          <HelpPanel ctx={ctx} screen={screen} onClose={() => setHelpOpen(false)} startTour={startTour} />
        </Suspense>
      )}
      {tour && (
        <Suspense fallback={null}>
          <Tour
            id={tour}
            go={tourGo}
            onClose={(finished) => {
              if (finished) markDone('tourTaken')
              setTour(null)
            }}
          />
        </Suspense>
      )}
      {welcome && (
        <div className="modal-backdrop">
          <div className="modal welcome-modal" role="dialog" aria-label="Welcome to Vibeloft">
            <div className="welcome-body">
              <img src={mark} alt="" className="welcome-mark" />
              <h2>Welcome to Vibeloft</h2>
              <p className="welcome-tagline">A room for every project.</p>
              <p className="muted">Build and manage all your customer apps with Claude, in one place.</p>
              {setupOk === false && (
                <div className="welcome-setup">
                  <h3>Let’s get you set up</h3>
                  <SetupCheck onChange={(s) => setSetupOk(setupReady(s))} />
                </div>
              )}
              {setupOk !== false && (
              <ul className="welcome-points">
                <li>
                  <b>Projects</b> in the sidebar: each is a code folder for a customer.
                </li>
                <li>
                  <b>Terminal</b> runs Claude Code in the project; undo, review and commit with one click.
                </li>
                <li>
                  <b>F1</b> opens help any time: ask a question in your own words.
                </li>
              </ul>
              )}
              <div className="row gap-s welcome-actions">
                <button
                  className="btn"
                  onClick={() => {
                    setWelcome(false)
                    setWelcomed()
                  }}
                >
                  Skip
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setWelcome(false)
                    setWelcomed()
                    setHelpOpen(true)
                  }}
                >
                  Open help
                </button>
                <button className="btn primary" onClick={() => startTour('welcome')} autoFocus>
                  <Icon name="play" size={14} /> Take the 1-minute tour
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {setupOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSetupOpen(false)}>
          <div className="modal setup-modal" role="dialog" aria-label="Setup check">
            <div className="modal-head">
              <h2>Setup check</h2>
              <button className="icon-btn" aria-label="Close" onClick={() => setSetupOpen(false)}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="modal-body">
              <SetupCheck
                onChange={(s) => setSetupOk(setupReady(s))}
                onAddProject={
                  db.projects.length === 0
                    ? () => {
                        setSetupOpen(false)
                        newProject()
                      }
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      )}
      {switching && <ProjectSwitcher ctx={ctx} currentId={activeProject} onClose={() => setSwitching(false)} />}
      {creating && (
        <ProjectForm
          ctx={ctx}
          onClose={() => setCreating(false)}
          onSaved={(id, tab) => {
            setCreating(false)
            go({ view: 'project', id, tab })
          }}
        />
      )}
    </div>
  )
}

function NavItem(props: { active: boolean; onClick: () => void; icon: IconName; label: string }): ReactNode {
  return (
    <button className={`nav-item ${props.active ? 'active' : ''}`} onClick={props.onClick} aria-current={props.active ? 'page' : undefined} title={props.label}>
      <Icon name={props.icon} size={17} className="nav-icon" />
      <span>{props.label}</span>
    </button>
  )
}

/** Follows the OS setting when the user picks 'system', and updates live when it changes. */
function useResolvedTheme(setting: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  const query = '(prefers-color-scheme: dark)'
  const [osDark, setOsDark] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (): void => setOsDark(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [setting])
  return setting === 'system' ? (osDark ? 'dark' : 'light') : setting
}

