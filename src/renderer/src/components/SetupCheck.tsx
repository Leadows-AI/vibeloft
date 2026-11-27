import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SetupStatus, SetupStep } from '../../../shared/types'
import { Icon } from '../icons'
import { api } from '../ui'

// The setup check: Claude Code, Git and (optionally) the GitHub CLI, installed
// and signed in. Each Install button runs the tool's official installer, and
// shows the exact command first. Used on first start, in Settings, and from
// the sidebar while something required is missing.

type RowKey = SetupStep | 'claudeLogin'

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function setupReady(s: SetupStatus | null): boolean {
  return !!s && s.claude.installed && s.claudeSignedIn && s.git.installed
}

export function SetupCheck(props: { onAddProject?: () => void; onChange?: (s: SetupStatus) => void }): ReactNode {
  const [st, setSt] = useState<SetupStatus | null>(null)
  const [cmds, setCmds] = useState<Record<SetupStep, { command: string; manualUrl: string } | null> | null>(null)
  const [busy, setBusy] = useState<RowKey | null>(null)
  const [log, setLog] = useState<{ step: RowKey; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const logBox = useRef<HTMLPreElement>(null)

  const load = async (): Promise<void> => {
    try {
      const s = await api.setupStatus()
      setSt(s)
      props.onChange?.(s)
      setCmds(await api.setupCommands())
    } catch (e) {
      setError(errText(e))
    }
  }
  useEffect(() => void load(), [])
  useEffect(
    () =>
      api.onSetupOutput((e) =>
        setLog((l) => ({ step: e.step, text: `${l && l.step === e.step ? l.text : ''}${e.text}`.slice(-6000) }))
      ),
    []
  )
  useEffect(() => api.onAccountLoginOutput((t) => setLog((l) => ({ step: 'claudeLogin', text: `${l?.step === 'claudeLogin' ? l.text : ''}${t}`.slice(-6000) }))), [])
  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight
  }, [log])

  const runStep = async (step: SetupStep): Promise<void> => {
    setBusy(step)
    setError(null)
    setLog({ step, text: '' })
    try {
      const r = await api.runSetupStep(step)
      setSt(r.status)
      props.onChange?.(r.status)
      setCmds(await api.setupCommands())
      if (!r.ok) setError('That didn’t finish. The output below says why; you can also install it yourself from the link.')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const signInClaude = async (): Promise<void> => {
    setBusy('claudeLogin')
    setError(null)
    setLog({ step: 'claudeLogin', text: '' })
    try {
      await api.accountLogin('claudeai')
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  if (!st) {
    return <div className="setup-check muted small">{error ?? 'Checking what’s installed…'}</div>
  }

  const rows: {
    key: RowKey
    title: string
    required: boolean
    ok: boolean
    detail: string
    blockedBy?: string
    action?: { label: string; run: () => void }
  }[] = [
    {
      key: 'claude',
      title: 'Claude Code',
      required: true,
      ok: st.claude.installed,
      detail: st.claude.installed ? (st.claude.version ?? 'Installed') : 'Runs Claude in each project’s Terminal. Needs a paid Claude plan or an Anthropic Console account.',
      action: { label: 'Install', run: () => void runStep('claude') }
    },
    {
      key: 'claudeLogin',
      title: 'Sign in to Claude',
      required: true,
      ok: st.claudeSignedIn,
      detail: st.claudeSignedIn ? (st.claudeAccount ?? 'Signed in') : 'Opens your browser to sign in to your Claude account.',
      blockedBy: st.claude.installed ? undefined : 'Install Claude Code first',
      action: { label: 'Sign in', run: () => void signInClaude() }
    },
    {
      key: 'git',
      title: 'Git',
      required: true,
      ok: st.git.installed,
      detail: st.git.installed ? `Version ${st.git.version}` : 'Saves versions of your code. Vibeloft’s Git tab, Commit & Push and Undo use it.',
      action: { label: 'Install', run: () => void runStep('git') }
    },
    {
      key: 'gh',
      title: 'GitHub CLI',
      required: false,
      ok: st.gh.installed,
      detail: st.gh.installed ? `Version ${st.gh.version}` : 'Only for GitHub: cloning repos and syncing issues and milestones.',
      action: { label: 'Install', run: () => void runStep('gh') }
    },
    {
      key: 'ghLogin',
      title: 'Sign in to GitHub',
      required: false,
      ok: st.ghSignedIn,
      detail: st.ghSignedIn ? (st.ghUser ? `Signed in as ${st.ghUser}` : 'Signed in') : 'Opens your browser and shows a one-time code to enter there.',
      blockedBy: st.gh.installed ? undefined : 'Install the GitHub CLI first',
      action: { label: 'Sign in', run: () => void runStep('ghLogin') }
    }
  ]

  const ready = setupReady(st)
  const ghCode = log?.step === 'ghLogin' ? log.text.match(/code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1] : undefined
  const link = log?.text.match(/https:\/\/\S+/)?.[0]

  return (
    <div className="setup-check">
      <ul className="setup-rows">
        {rows.map((r) => {
          const cmd = r.key === 'claudeLogin' ? null : cmds?.[r.key as SetupStep]
          const manualOnly = r.key !== 'claudeLogin' && cmds && !cmd
          return (
            <li key={r.key} className={`setup-row ${r.ok ? 'ok' : ''}`}>
              <span className={`setup-mark ${r.ok ? 'ok' : r.required ? 'need' : 'opt'}`} aria-hidden="true">
                {r.ok ? <Icon name="check" size={13} /> : null}
              </span>
              <div className="setup-text">
                <div className="setup-title">
                  {r.title} <span className="setup-tag">{r.required ? 'Required' : 'Optional'}</span>
                </div>
                <div className="muted small">{r.detail}</div>
                {!r.ok && cmd && (
                  <div className="setup-cmd small">
                    Runs <code>{cmd.command}</code>
                  </div>
                )}
              </div>
              <div className="setup-act">
                {r.ok ? (
                  <span className="ok-text small">Done</span>
                ) : r.blockedBy ? (
                  <span className="muted small">{r.blockedBy}</span>
                ) : manualOnly ? (
                  <button className="btn small-btn" onClick={() => void api.openSetupManual(r.key as SetupStep)}>
                    <Icon name="external" size={14} /> Get it
                  </button>
                ) : (
                  <>
                    <button className={`btn small-btn ${r.required ? 'primary' : ''}`} disabled={!!busy} onClick={r.action?.run}>
                      {busy === r.key ? 'Working…' : r.action?.label}
                    </button>
                    {r.key !== 'claudeLogin' && (
                      <button className="link small" onClick={() => void api.openSetupManual(r.key as SetupStep)} title="Install it yourself instead">
                        or by hand
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {ghCode && (
        <div className="setup-code">
          Enter this code on the GitHub page that opened: <b>{ghCode}</b>
        </div>
      )}
      {busy === 'claudeLogin' && (
        <div className="setup-code">
          Finish signing in to Claude in your browser. This updates by itself.{' '}
          {link && (
            <button className="link" onClick={() => api.openUrl(link)}>
              Open the sign-in page
            </button>
          )}
        </div>
      )}
      {error && <div className="notice bad small">{error}</div>}
      {log && log.text.trim() && (
        <pre className="setup-log" ref={logBox}>
          {log.text}
        </pre>
      )}

      <div className="setup-foot">
        {ready ? (
          <span className="ok-text">
            <Icon name="check" size={15} /> You’re ready.
          </span>
        ) : (
          <span className="muted small">Claude Code, signing in and Git are needed. GitHub is optional.</span>
        )}
        <div className="grow" />
        <button className="btn small-btn" disabled={!!busy} onClick={() => void load()}>
          <Icon name="refresh" size={14} /> Check again
        </button>
        {busy && busy !== 'claudeLogin' && (
          <button className="btn small-btn" onClick={() => void api.cancelSetupStep()}>
            Stop
          </button>
        )}
        {ready && props.onAddProject && (
          <button className="btn small-btn primary" onClick={props.onAddProject}>
            <Icon name="plus" size={14} /> Add your first project
          </button>
        )}
      </div>
    </div>
  )
}
