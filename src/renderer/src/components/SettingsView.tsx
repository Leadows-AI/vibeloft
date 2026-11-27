import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { AppTools } from './AppTools'
import { Icon, type IconName } from '../icons'
import mark from '../assets/vibeloft-mark.svg'
import type { ClaudeAccount, GoogleFontInfo, SetupStatus } from '../../../shared/types'
import type { AppCtx } from '../App'
import { api, Field } from '../ui'
import { themeIconUrl } from '../fileIcons'
import { contrastRatio, resolveColors, TERM_DEFAULTS, UI_DEFAULTS, UI_SCALE_DEFAULT, type ColorDefaults } from '../fonts'
import { remember, remembered } from '../prefs'
import { UpdatesCard, useUpdateStatus } from '../updates'
import { SetupCheck, setupReady } from './SetupCheck'

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (recommended)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2 (most capable)' }
]

type SettingsTab = 'appearance' | 'setup' | 'work' | 'updates' | 'about'
const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'setup', label: 'Setup' },
  { id: 'work', label: 'Editor' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About Leadows' }
]

/** The tabs inside Setup: what's installed, Claude Code, GitHub. */
type SetupTab = 'check' | 'claude' | 'github'
const SETUP_TABS: { id: SetupTab; label: string }[] = [
  { id: 'check', label: 'Setup check' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'github', label: 'GitHub' }
]

type Tone = 'good' | 'warn' | 'bad' | 'muted'
type TileState = [Tone, string, string]

/** "Is everything working?" at a glance. Each tile opens the tab where you fix it. */
function StatusTiles(props: {
  account: ClaudeAccount | null
  gh: { ok: boolean; message: string } | null
  setup: SetupStatus | null
  model: string
  go: (t: SettingsTab, sub?: SetupTab, card?: string) => void
}): ReactNode {
  const up = useUpdateStatus()
  const { account: a, gh, setup } = props
  const model = MODELS.find((m) => m.id === props.model)?.label.replace(/^Claude /, '').replace(/ \(.*\)$/, '') ?? props.model
  const claude: TileState = !a
    ? ['muted', 'Checking…', '']
    : !a.installed
      ? ['bad', 'Not installed', 'Install Claude Code to start']
      : !a.loggedIn
        ? ['bad', 'Not signed in', 'Sign in to use Claude']
        : ['good', 'Signed in', `${planLabel(a)} · ${model}`]
  const github: TileState = !gh ? ['muted', 'Checking…', ''] : gh.ok ? ['good', 'Connected', gh.message] : ['warn', 'Not connected', gh.message]
  const tools = setup ? ['Claude Code', 'Git', ...(setup.gh.installed ? ['GitHub CLI'] : [])].join(', ') : ''
  const setupT: TileState = !setup
    ? ['muted', 'Checking…', '']
    : setupReady(setup)
      ? ['good', 'All set', tools]
      : ['bad', 'Needs attention', 'Something to install or sign in']
  const update: TileState = !up
    ? ['muted', 'Checking…', '']
    : up.state === 'ready'
      ? ['warn', `${up.available} ready`, `You have ${up.current} · restart to update`]
      : up.state === 'downloading'
        ? ['muted', `Downloading ${up.percent ?? 0}%`, `Vibeloft ${up.available ?? ''}`]
        : up.state === 'error'
          ? ['warn', 'Couldn’t check', `Version ${up.current}`]
          : up.state === 'dev'
            ? ['muted', 'Development copy', `Version ${up.current}`]
            : up.state === 'latest'
              ? ['good', 'Up to date', `Version ${up.current}`]
              : ['muted', `Version ${up.current}`, up.state === 'checking' ? 'Checking for updates…' : '']
  const tile = (title: string, [tone, value, sub]: TileState, to: SettingsTab, inSetup?: SetupTab, card?: string): ReactNode => (
    <button
      className={`status-tile ${tone === 'warn' || tone === 'bad' ? 'attn' : ''}`}
      onClick={() => props.go(to, inSetup, card)}
      title={`Open ${TABS.find((t) => t.id === to)!.label}${inSetup ? ` › ${SETUP_TABS.find((t) => t.id === inSetup)!.label}` : ''}`}
    >
      <span className="status-tile-title">{title}</span>
      <span className={`status-tile-value ${tone}`}>{value}</span>
      <span className="status-tile-sub">{sub}</span>
    </button>
  )
  return (
    <div className="status-tiles">
      {tile('Claude', claude, 'setup', 'claude')}
      {tile('GitHub', github, 'setup', 'github')}
      {tile('Setup', setupT, 'setup', 'check')}
      {tile('Updates', update, 'updates', undefined, 'updates-card')}
    </div>
  )
}

export function SettingsView({ ctx }: { ctx: AppCtx }): ReactNode {
  const { db, setDb } = ctx
  const s = db.settings
  const [gh, setGh] = useState<{ ok: boolean; message: string } | null>(null)
  const [acct, setAcct] = useState<ClaudeAccount | null>(null)
  const [setupSt, setSetup] = useState<SetupStatus | null>(null)

  useEffect(() => {
    api.ghStatus().then(setGh)
    api.accountStatus().then(setAcct, () => {})
    api.setupStatus().then(setSetup, () => {})
  }, [])

  const save = async (patch: Partial<typeof s>): Promise<void> => setDb(await api.saveSettings({ ...s, ...patch }))

  // Tabs remembered from before Setup existed: Claude and Git moved into it, General became Appearance.
  const OLD_TABS: Record<string, [SettingsTab, SetupTab?]> = { general: ['appearance'], claude: ['setup', 'claude'], git: ['setup', 'github'] }
  const [tab, setTab] = useState<SettingsTab>(() => {
    const t = remembered('settingsTab', 'appearance')
    return OLD_TABS[t]?.[0] ?? (TABS.some((x) => x.id === t) ? (t as SettingsTab) : 'appearance')
  })
  const [setupTab, setSetupTab] = useState<SetupTab>(() => {
    const t = OLD_TABS[remembered('settingsTab', '')]?.[1] ?? remembered('settingsSetupTab', 'check')
    return SETUP_TABS.some((x) => x.id === t) ? (t as SetupTab) : 'check'
  })
  const pickSetup = (t: SetupTab): void => {
    setSetupTab(t)
    remember('settingsSetupTab', t)
  }
  /** Open a tab (and a Setup sub-tab); with a card id, also scroll that card into view once the tab has rendered. */
  const pick = (t: SettingsTab, sub?: SetupTab, card?: string): void => {
    setTab(t)
    remember('settingsTab', t)
    if (sub) pickSetup(sub)
    if (card) requestAnimationFrame(() => document.getElementById(card)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
        </div>
        <AppTools ctx={ctx} />
      </header>

      <StatusTiles account={acct} gh={gh} setup={setupSt} model={s.model} go={pick} />

      <nav className="tabs settings-tabs" aria-label="Settings sections">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => pick(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="settings-panel">
        {tab === 'appearance' && (
          <>
            <section className="card appearance-theme">
              <h3>Theme</h3>
              <div className="theme-picker" role="radiogroup" aria-label="Theme">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    role="radio"
                    aria-checked={s.theme === t.id}
                    className={`theme-option ${s.theme === t.id ? 'on' : ''}`}
                    onClick={() => save({ theme: t.id })}
                  >
                    <span className={`theme-preview ${t.id}`} aria-hidden="true">
                      <span className="tp-side" />
                      <span className="tp-main">
                        <span className="tp-line wide" />
                        <span className="tp-line" />
                        <span className="tp-card" />
                      </span>
                    </span>
                    <span className="theme-option-label">
                      <Icon name={t.icon} size={14} />
                      {t.label}
                      {s.theme === t.id && <Icon name="check" size={14} className="theme-check" />}
                    </span>
                  </button>
                ))}
              </div>
              <p className="muted small">System follows your Windows or macOS appearance and switches automatically.</p>
            </section>

            <section className="card">
              <div className="card-title-row">
                <h3>Interface font</h3>
                <button className="link" onClick={() => api.openUrl('https://fonts.google.com/')}>
                  Google Fonts <Icon name="external" size={12} />
                </button>
              </div>
              <FontField
                label="Family"
                builtIn="Inter"
                categories={['Sans Serif', 'Serif']}
                value={s.uiFont}
                hint="Pick or type any family from fonts.google.com. It's downloaded once and stored with Vibeloft, so it works offline."
                onSave={(uiFont) => save({ uiFont })}
              />
              <FontOptions
                family={s.uiFont}
                sizes={UI_SIZES}
                size={s.uiFontScale ?? UI_SCALE_DEFAULT}
                weight={s.uiFontWeight ?? 400}
                onSize={(uiFontScale) => save({ uiFontScale })}
                onWeight={(uiFontWeight) => save({ uiFontWeight })}
              />
              <ColorPair
                defaults={UI_DEFAULTS}
                bgPresets={UI_BGS}
                fgPresets={UI_FGS}
                bg={s.uiBg || null}
                fg={s.uiFg || null}
                onBg={(uiBg) => void save({ uiBg })}
                onFg={(uiFg) => void save({ uiFg })}
                onReset={() => void save({ uiBg: null, uiFg: null })}
              />
              <div className="font-sample ui-sample">
                <span className="ui-sample-big">Aa</span>
                <span>
                  <b>Shopfront Web</b>
                  <span className="muted">Claude finished the checkout page. 3 files changed, ready to review.</span>
                </span>
              </div>
            </section>

            <section className="card">
              <div className="card-title-row">
                <h3>Code font</h3>
                <button className="link" onClick={() => api.openUrl('https://fonts.google.com/?classification=Monospace')}>
                  Google Fonts <Icon name="external" size={12} />
                </button>
              </div>
              <FontField
                label="Family"
                builtIn="JetBrains Mono"
                categories={['Monospace']}
                value={s.monoFont}
                hint="Used in the terminal, editor and diffs. The list shows monospaced families."
                onSave={(monoFont) => save({ monoFont })}
              />
              <FontOptions
                family={s.monoFont}
                sizes={MONO_SIZES}
                size={s.monoFontSize ?? 13}
                weight={s.monoFontWeight ?? 400}
                onSize={(monoFontSize) => save({ monoFontSize })}
                onWeight={(monoFontWeight) => save({ monoFontWeight })}
              />
              <ColorPair
                defaults={TERM_DEFAULTS}
                bgPresets={TERM_BGS}
                fgPresets={TERM_FGS}
                bg={s.terminalBg || null}
                fg={s.terminalFg || null}
                onBg={(terminalBg) => void save({ terminalBg })}
                onFg={(terminalFg) => void save({ terminalFg })}
                onReset={() => void save({ terminalBg: null, terminalFg: null })}
              />
              <pre className="font-sample" style={{ fontSize: s.monoFontSize ?? 13, fontWeight: s.monoFontWeight ?? 400 }}>
                {CODE_SAMPLE}
                <b>$ npm run dev</b>
              </pre>
            </section>
          </>
        )}
        {tab === 'setup' && (
          <>
            <div className="segmented setup-subtabs" role="tablist" aria-label="Setup">
              {SETUP_TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={setupTab === t.id}
                  className={setupTab === t.id ? 'on' : ''}
                  onClick={() => pickSetup(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {setupTab === 'check' && (
              <section className="card">
                <h3>Setup check</h3>
                <p className="muted small">What Vibeloft needs on this computer. Install buttons run each tool’s official installer.</p>
                <SetupCheck onChange={setSetup} />
              </section>
            )}
            {setupTab === 'claude' && (
              <>
                <ClaudeAccountCard onChange={setAcct} />
                <section className="card">
                  <h3>Claude model</h3>
                  <Field
                    label="Model"
                    hint="Used by every Claude Code terminal Vibeloft opens, and for commit messages, architecture, report summaries and help answers. Type /model in a terminal to switch just that session. Uses your Claude Code login on this computer."
                  >
                    <select className="input" value={s.model} onChange={(e) => save({ model: e.target.value })}>
                      {MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </section>
              </>
            )}
            {setupTab === 'github' && (
              <>
                <section className="card">
                  <h3>GitHub</h3>
                  <p className={gh ? (gh.ok ? 'ok-text' : 'bad-text') : 'muted'}>{gh ? gh.message : 'Checking…'}</p>
                  <Field label="Default projects folder" hint="Repositories you clone from GitHub go here.">
                    <div className="row gap-s">
                      <input className="input" readOnly value={s.projectsRoot ?? ''} placeholder="Not set — you'll be asked each time" />
                      <button
                        className="btn"
                        onClick={async () => {
                          const dir = await api.pickFolder()
                          if (dir) save({ projectsRoot: dir })
                        }}
                      >
                        Browse…
                      </button>
                    </div>
                  </Field>
                </section>
              </>
            )}
          </>
        )}
        {tab === 'work' && (
          <>
            <section className="card">
              <h3>Editor</h3>
              <Field label="Format on save (Prettier)" hint="Shift+Alt+F formats the current file at any time.">
                <select
                  className="input"
                  value={s.formatOnSave ?? 'auto'}
                  onChange={(e) => save({ formatOnSave: e.target.value as 'auto' | 'always' | 'off' })}
                >
                  <option value="auto">Only in projects that use Prettier (recommended)</option>
                  <option value="always">Always</option>
                  <option value="off">Off</option>
                </select>
              </Field>
            </section>
          </>
        )}
        {tab === 'updates' && (
          <>
            <UpdatesCard auto={s.autoUpdate !== false} setAuto={(autoUpdate) => save({ autoUpdate })} />
          </>
        )}
        {tab === 'about' && <AboutLeadows />}
      </div>
    </div>
  )
}

const SERVICES: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'phone',
    title: 'Enterprise communication',
    text: 'WhatsApp, SMS, RCS, email and voice messaging, AI agents and chatbots, and integration with CRM, ERP and helpdesk systems.'
  },
  { icon: 'sparkle', title: 'AI-powered business automation', text: 'Warehouse and inventory, manufacturing, healthcare, field service and internal business apps.' },
  { icon: 'tool', title: 'Product engineering', text: 'MVPs and enterprise products, cloud and mobile apps, APIs, DevOps, AI integration and legacy modernization.' }
]

/** About the company behind Vibeloft (from leadows.com), how to reach it, Vibeloft itself, and what it's built with. */
function AboutLeadows(): ReactNode {
  const up = useUpdateStatus()
  const link = (url: string, label: string): ReactNode => (
    <button className="link" onClick={() => api.openUrl(url)} title={url}>
      {label} <Icon name="external" size={12} />
    </button>
  )
  return (
    <>
      <section className="card about-hero" id="about-leadows">
        <div className="about-hero-head">
          <span className="about-logo" aria-hidden="true">
            L
          </span>
          <div>
            <h3>Leadows Technologies</h3>
            <span className="muted">Intelligent enterprise software</span>
          </div>
        </div>
        <p className="about-lead">
          Leadows helps enterprises build technology products, modernize operations and accelerate digital transformation through custom software and AI.
        </p>
        <div className="row gap-s">
          <button className="btn primary" onClick={() => api.openUrl('https://www.leadows.com')}>
            Visit leadows.com <Icon name="external" size={12} />
          </button>
          <button className="btn" onClick={() => api.openUrl('mailto:contact@leadows.com')}>
            Email us
          </button>
        </div>
        <ul className="about-services">
          {SERVICES.map((x) => (
            <li key={x.title}>
              <span className="about-service-icon">
                <Icon name={x.icon} size={16} />
              </span>
              <b>{x.title}</b>
              <span className="muted small">{x.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>Contact</h3>
        <dl className="details about-details">
          <dt>Website</dt>
          <dd>{link('https://www.leadows.com', 'www.leadows.com')}</dd>
          <dt>Email</dt>
          <dd>{link('mailto:contact@leadows.com', 'contact@leadows.com')}</dd>
          <dt>Teams</dt>
          <dd>India and Uzbekistan</dd>
        </dl>
      </section>

      <section className="card">
        <div className="about-app">
          <img src={mark} alt="" className="update-mark" draggable={false} />
          <div>
            <h3>Vibeloft{up ? ` ${up.current}` : ''}</h3>
            <span className="muted small">A room for every project.</span>
          </div>
        </div>
        <dl className="details about-details">
          <dt>Source code</dt>
          <dd>{link('https://github.com/Leadows-AI/vibeloft', 'github.com/Leadows-AI/vibeloft')}</dd>
          <dt>Releases</dt>
          <dd>{link('https://github.com/Leadows-AI/vibeloft/releases', 'github.com/Leadows-AI/vibeloft/releases')}</dd>
        </dl>
        <p className="muted small">Vibeloft is an independent project built on Claude Code. It is not an Anthropic product.</p>
      </section>

      <section className="card about-powered">
        <h3>Powered by</h3>
        <ul className="powered-by">
          {poweredBy().map((t) => {
            const logo = t.logo && themeIconUrl(t.logo)
            return (
              <li key={t.name}>
                <button className="powered-tile" onClick={() => api.openUrl(t.url)} title={t.url}>
                  {logo ? <img src={logo} alt="" /> : <span className="powered-letter">{t.name[0]}</span>}
                  <span>
                    <b>{t.name}</b>
                    <span className="muted small">{t.role}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <p className="muted small">Logos are trademarks of their owners, shown to credit the projects Vibeloft is built with.</p>
      </section>
    </>
  )
}

/** The technologies Vibeloft is built with. */
function poweredBy(): { name: string; role: string; logo?: string; url: string }[] {
  return [
    { name: 'Claude Code', role: 'The AI coding agent in every terminal', logo: 'claude', url: 'https://www.claude.com/product/claude-code' },
    { name: 'Tauri', role: 'Desktop app shell', logo: 'tauri', url: 'https://tauri.app' },
    { name: 'Rust', role: 'Files, terminals, Git and Claude Code hooks', logo: 'rust', url: 'https://www.rust-lang.org' },
    { name: 'React', role: 'Interface', logo: 'react', url: 'https://react.dev' },
    { name: 'TypeScript', role: 'Interface code', logo: 'typescript', url: 'https://www.typescriptlang.org' },
    { name: 'Vite', role: 'Build tool', logo: 'vite', url: 'https://vite.dev' },
    { name: 'Monaco Editor', role: 'Code editor (from VS Code)', logo: 'vscode', url: 'https://microsoft.github.io/monaco-editor/' },
    { name: 'xterm.js', role: 'Terminals', logo: 'console', url: 'https://xtermjs.org' },
    { name: 'Mermaid', role: 'Architecture diagrams', logo: 'mermaid', url: 'https://mermaid.js.org' },
    { name: 'Git & GitHub CLI', role: 'Version control and GitHub', logo: 'git', url: 'https://cli.github.com' },
    { name: 'Marked', role: 'Markdown', logo: 'markdown', url: 'https://marked.js.org' },
    { name: 'Prettier', role: 'Code formatting', logo: 'prettier', url: 'https://prettier.io' }
  ]
}

const PLAN: Record<string, string> = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise', free: 'Claude Free' }

function planLabel(a: ClaudeAccount): string {
  if (a.authMethod && /console|api/i.test(a.authMethod) && !a.subscriptionType) return 'Anthropic Console (API billing)'
  if (a.subscriptionType) return PLAN[a.subscriptionType] ?? `Claude ${a.subscriptionType[0].toUpperCase()}${a.subscriptionType.slice(1)}`
  return a.authMethod ?? 'Signed in'
}

/** Who Claude Code is signed in as on this computer, with sign in / out. */
function ClaudeAccountCard(props: { onChange?: (a: ClaudeAccount) => void }): ReactNode {
  const [acct, setAcct] = useState<ClaudeAccount | null>(null)
  useEffect(() => {
    if (acct) props.onChange?.(acct)
  }, [acct])
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)
  const [output, setOutput] = useState('')
  const [code, setCode] = useState('')

  const refresh = (): void => {
    setAcct(null)
    api.accountStatus().then(setAcct)
  }
  useEffect(refresh, [])
  useEffect(() => api.onAccountLoginOutput((t) => setOutput((o) => (o + t).slice(-4000))), [])

  const login = async (method: 'claudeai' | 'console'): Promise<void> => {
    setBusy('login')
    setOutput('')
    setCode('')
    try {
      setAcct(await api.accountLogin(method))
    } finally {
      setBusy(null)
    }
  }
  const logout = async (): Promise<void> => {
    if (!confirm('Sign out of Claude Code on this computer? Claude Code terminals and Vibeloft’s Claude features will stop working until you sign in again.')) return
    setBusy('logout')
    try {
      setAcct(await api.accountLogout())
    } finally {
      setBusy(null)
    }
  }

  const link = output.match(/https:\/\/\S+/)?.[0]
  const expires = acct?.loginExpiresAt ? new Date(acct.loginExpiresAt) : null

  return (
    <section className="card account-card">
      <div className="card-head">
        <h3>Claude account</h3>
        <button className="link" onClick={refresh} disabled={!!busy}>
          Refresh
        </button>
      </div>

      {!acct && <p className="muted">Checking…</p>}

      {acct && !acct.installed && (
        <p className="bad-text">
          Claude Code isn't installed on this computer. Install it from{' '}
          <button className="link" onClick={() => api.openUrl('https://claude.com/claude-code')}>
            claude.com/claude-code
          </button>
          , then come back and sign in.
        </p>
      )}

      {acct?.installed && acct.loggedIn && (
        <div className="account-info">
          <div className="account-avatar">{(acct.email ?? '?')[0].toUpperCase()}</div>
          <div className="account-lines">
            <b>{acct.email ?? 'Signed in'}</b>
            <span className="muted small">
              {planLabel(acct)}
              {acct.orgName ? ` · ${acct.orgName}` : ''}
            </span>
            {expires && !isNaN(expires.getTime()) && (
              <span className="muted small">Sign-in renews automatically · valid until {expires.toLocaleDateString()}</span>
            )}
          </div>
        </div>
      )}

      {acct?.installed && !acct.loggedIn && !busy && <p className="bad-text">Not signed in. Claude Code terminals and Vibeloft’s Claude features need you to sign in.</p>}
      {acct?.error && acct.installed && <p className="muted small">{acct.error}</p>}

      {busy === 'login' && (
        <div className="account-login">
          <p>
            <b>Finish signing in in your browser.</b> <span className="muted">This page updates by itself when you're done.</span>
          </p>
          {link && (
            <p className="small">
              Browser didn't open?{' '}
              <button className="link" onClick={() => api.openUrl(link)}>
                Open the sign-in page
              </button>
            </p>
          )}
          <div className="row gap-s">
            <input
              className="input"
              placeholder="If the browser shows a code, paste it here"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code.trim()) api.accountLoginCode(code)
              }}
            />
            <button className="btn" disabled={!code.trim()} onClick={() => api.accountLoginCode(code)}>
              Submit code
            </button>
            <button className="btn ghost" onClick={() => api.accountLoginCancel()}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {acct?.installed && !busy && (
        <div className="row gap-s account-actions">
          <button className={`btn ${acct.loggedIn ? '' : 'primary'}`} onClick={() => login('claudeai')}>
            {acct.loggedIn ? 'Switch account' : 'Sign in with Claude'}
          </button>
          <button className="btn ghost" onClick={() => login('console')} title="Pay per use with an Anthropic Console (API) account instead of a Claude subscription">
            Use API account
          </button>
          {acct.loggedIn && (
            <button className="btn ghost danger" onClick={logout}>
              Sign out
            </button>
          )}
          <div className="grow" />
          <button className="link small" onClick={() => api.openUrl('https://claude.ai/settings/usage')}>
            View usage <Icon name="external" size={13} />
          </button>
        </div>
      )}
      {busy === 'logout' && <p className="muted">Signing out…</p>}
    </section>
  )
}

const THEMES: { id: 'dark' | 'light' | 'system'; label: string; icon: IconName }[] = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'System', icon: 'sliders' }
]
const UI_SIZES: [number, string][] = [
  [0.9, 'Small'],
  [1, 'Medium'],
  [1.1, 'Large'],
  [1.25, 'Larger']
]
const MONO_SIZES: [number, string][] = [12, 13, 14, 16, 18].map((n) => [n, `${n}px`])
// Shows the characters people tell apart in a code font: 0/O, 1/l/I, brackets and operators.
const CODE_SAMPLE = `function greet(name: string): string {
  const id = [0, 1, 2].map((n) => n * 10) // 0O 1lI |
  return name !== '' ? \`Hello, \${name}!\` : 'Hi {}'
}
`
const TERM_BGS: [string, string][] = [
  ['#111418', 'Graphite'],
  ['#0b0d10', 'Black'],
  ['#15203a', 'Navy'],
  ['#1b2b22', 'Forest'],
  ['#fffdf8', 'Paper'],
  ['#eef1f5', 'Mist']
]
const TERM_FGS: [string, string][] = [
  ['#ede8de', 'Warm white'],
  ['#f4f6fa', 'Cool white'],
  ['#14171c', 'Ink'],
  ['#7ee2a8', 'Green'],
  ['#ffc46b', 'Amber'],
  ['#9cc8ff', 'Sky']
]

/**
 * One colour choice: an automatic "A" option, preset swatches and the system colour picker.
 * With `on`, swatches are text colours: an "A" in each colour on that background.
 */
function ColorRow(props: {
  label: string
  value: string | null
  auto: { label: string; bg: string; fg: string }
  presets: [string, string][]
  on?: string
  onPick: (c: string | null) => void
}): ReactNode {
  const { value, auto, presets, on } = props
  const preset = presets.find(([c]) => c === value)
  const custom = value !== null && !preset
  const name = value === null ? auto.label : (preset?.[1] ?? value.toUpperCase())
  const look = (c: string): CSSProperties => (on ? { background: on, color: c } : { background: c })
  return (
    <>
      <span className="field-label">{props.label}</span>
      <div className="swatch-row" role="radiogroup" aria-label={props.label}>
        <button
          role="radio"
          aria-checked={value === null}
          className="swatch"
          style={{ background: auto.bg, color: auto.fg }}
          title={auto.label}
          aria-label={auto.label}
          onClick={() => props.onPick(null)}
        >
          A
        </button>
        {presets.map(([c, label]) => (
          <button
            key={c}
            role="radio"
            aria-checked={value === c}
            className="swatch"
            style={look(c)}
            title={label}
            aria-label={label}
            onClick={() => props.onPick(c)}
          >
            {on && 'A'}
          </button>
        ))}
        <label className={`swatch swatch-custom ${custom ? 'on' : 'rainbow'}`} style={custom ? look(value) : undefined} title="Custom colour">
          {custom && on && 'A'}
          <input
            type="color"
            value={value ?? auto.fg}
            aria-label={`Custom ${props.label.toLowerCase()} colour`}
            onChange={(e) => props.onPick(e.target.value)}
          />
        </label>
        <span className="swatch-name">{name}</span>
      </div>
    </>
  )
}

const UI_BGS: [string, string][] = [
  ['#14171c', 'Ink'],
  ['#202124', 'Charcoal'],
  ['#172131', 'Slate blue'],
  ['#f6f1e7', 'Cream'],
  ['#f3f4f6', 'Cloud'],
  ['#e9efe9', 'Sage']
]
const UI_FGS: [string, string][] = [
  ['#ede8de', 'Warm white'],
  ['#f4f6fa', 'Cool white'],
  ['#c9ccd2', 'Soft grey'],
  ['#14171c', 'Ink'],
  ['#2a3140', 'Slate'],
  ['#3b3228', 'Sepia']
]

/** A background and text colour, picked independently, with a readability check. */
function ColorPair(props: {
  defaults: ColorDefaults
  bgPresets: [string, string][]
  fgPresets: [string, string][]
  bg: string | null
  fg: string | null
  onBg: (c: string | null) => void
  onFg: (c: string | null) => void
  onReset: () => void
}): ReactNode {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  const now = resolveColors(props.defaults, theme, props.bg, props.fg)
  const ratio = contrastRatio(now.bg, now.fg)
  const level = ratio >= 7 ? 'Easy to read' : ratio >= 4.5 ? 'Readable' : ratio >= 3 ? 'Hard to read' : 'Very hard to read'
  return (
    <div className="font-options color-pair">
      <ColorRow
        label="Background"
        value={props.bg}
        auto={{ label: 'Match theme', ...props.defaults[theme] }}
        presets={props.bgPresets}
        onPick={props.onBg}
      />
      <ColorRow
        label="Text"
        value={props.fg}
        auto={{ label: 'Automatic', ...resolveColors(props.defaults, theme, props.bg, null) }}
        presets={props.fgPresets}
        on={now.bg}
        onPick={props.onFg}
      />
      <span />
      <p className={`contrast-note small ${ratio < 4.5 ? 'warn' : 'muted'}`}>
        {ratio < 4.5 && <Icon name="alert" size={13} />}
        {level} ({ratio.toFixed(1)}:1 contrast).{' '}
        {(props.bg || props.fg) && (
          <button className="link" onClick={props.onReset}>
            Reset to theme
          </button>
        )}
      </p>
    </div>
  )
}

const WEIGHTS: [number, string][] = [
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold']
]

// Google's font catalogue, fetched (and cached by the backend) once per run.
let fontList: Promise<GoogleFontInfo[]> | null = null
function useGoogleFonts(): GoogleFontInfo[] {
  const [list, setList] = useState<GoogleFontInfo[]>([])
  useEffect(() => {
    fontList ??= api.googleFonts().catch(() => [])
    void fontList.then(setList)
  }, [])
  return list
}

/** Text size and weight for a font. Weights the chosen Google family doesn't have are turned off. */
function FontOptions(props: {
  family?: string | null
  sizes: [number, string][]
  size: number
  weight: number
  onSize: (n: number) => Promise<void>
  onWeight: (n: number) => Promise<void>
}): ReactNode {
  const fonts = useGoogleFonts()
  const has = props.family ? fonts.find((f) => f.family.toLowerCase() === props.family!.trim().toLowerCase())?.weights : undefined
  return (
    <div className="font-options">
      <span className="field-label">Size</span>
      <div className="segmented">
        {props.sizes.map(([n, label]) => (
          <button key={n} className={props.size === n ? 'on' : ''} onClick={() => void props.onSize(n)}>
            {label}
          </button>
        ))}
      </div>
      <span className="field-label">Weight</span>
      <div className="segmented">
        {WEIGHTS.map(([n, label]) => (
          <button
            key={n}
            className={props.weight === n ? 'on' : ''}
            disabled={!!has && !has.includes(n)}
            title={has && !has.includes(n) ? `${props.family} has no ${label} weight` : undefined}
            onClick={() => void props.onWeight(n)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A Google Fonts family name, picked from the catalogue or typed, checked (and downloaded) before it's saved. Empty = the built-in font. */
function FontField(props: {
  label: string
  builtIn: string
  categories: string[]
  value?: string | null
  hint: string
  onSave: (family: string | null) => Promise<void>
}): ReactNode {
  const fonts = useGoogleFonts()
  const listId = `fonts-${props.builtIn.replace(/\W/g, '')}`
  const [name, setName] = useState(props.value ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = props.value ?? ''

  async function apply(family: string): Promise<void> {
    setError('')
    if (!family) return props.onSave(null)
    setBusy(true)
    try {
      await api.googleFont(family)
      await props.onSave(family)
    } catch (e) {
      setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field label={props.label} hint={error || props.hint}>
      <div className="row gap-s">
        <input
          className="input"
          list={listId}
          placeholder={`${props.builtIn} (built in)`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void apply(name.trim())}
        />
        <button className="btn" disabled={busy || name.trim() === current} onClick={() => void apply(name.trim())}>
          {busy ? 'Downloading…' : 'Apply'}
        </button>
        <datalist id={listId}>
          {fonts
            .filter((f) => props.categories.includes(f.category))
            .map((f) => (
              <option key={f.family} value={f.family} />
            ))}
        </datalist>
        {current && (
          <button
            className="btn ghost"
            onClick={() => {
              setName('')
              void apply('')
            }}
          >
            Use {props.builtIn}
          </button>
        )}
      </div>
    </Field>
  )
}
