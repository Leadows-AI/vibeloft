import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ApkBuild, MobileDevice, MobileInfo } from '../../../shared/types'
import type { AppCtx } from '../App'
import { Icon } from '../icons'
import { claudeTerminalFor, openClaudeTask, openTerminal, sendToTerminal, setActive, useTerminals } from '../termStore'
import { api, relTime } from '../ui'
import type { ProjectTab } from './ProjectView'

// Mobile app helpers (Android): build an APK, see the latest build, install it
// on a phone or emulator, and watch the app's logs — with one click to hand a
// failed build or a crash to Claude.

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g
const plain = (s: string): string => s.replace(ANSI, '').replace(/\r/g, '')

const size = (b: number): string => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`)

/** A build that's running (or just finished), per project: survives switching tabs. */
interface BuildRun {
  terminalId: string
  label: string
  startedAt: number
  exitCode?: number
}
const runs = new Map<string, BuildRun>()
const runListeners = new Set<() => void>()
api.onTermExit(({ id, code }) => {
  for (const r of runs.values())
    if (r.terminalId === id && r.exitCode === undefined) {
      r.exitCode = code
      runListeners.forEach((l) => l())
    }
})

/** The last part of a crash in device logs: the newest "FATAL EXCEPTION" block, or recent errors. */
function crashFrom(log: string): string {
  const lines = plain(log).split('\n')
  const fatal = lines.map((l, i) => (/FATAL EXCEPTION|AndroidRuntime.*FATAL/.test(l) ? i : -1)).filter((i) => i >= 0).pop()
  if (fatal !== undefined) return lines.slice(fatal, fatal + 120).join('\n')
  const errs = lines.filter((l) => /\s[EF]\/|Error|Exception|ERROR/.test(l))
  return (errs.length ? errs : lines).slice(-200).join('\n')
}

export function MobilePanel({ ctx, projectId, goTab }: { ctx: AppCtx; projectId: string; goTab: (t: ProjectTab) => void }): ReactNode {
  const project = ctx.db.projects.find((p) => p.id === projectId)!
  const [info, setInfo] = useState<MobileInfo | null | undefined>(undefined)
  const [devices, setDevices] = useState<MobileDevice[] | null>(null)
  const [serial, setSerial] = useState<string>('')
  const [variant, setVariant] = useState<'release' | 'debug'>('release')
  // Build for the connected phone's CPU type only (several times faster), or for all phones.
  const [target, setTarget] = useState<'phone' | 'all'>('phone')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [installing, setInstalling] = useState(false)
  const [, setTick] = useState(0)
  const { list } = useTerminals(projectId)
  const run = runs.get(projectId)

  const loadInfo = useCallback(() => {
    api.mobileInfo(projectId).then(setInfo, (e) => {
      setInfo(null)
      setMsg({ tone: 'bad', text: (e as Error).message })
    })
  }, [projectId])
  const loadDevices = useCallback(() => {
    api.mobileDevices(projectId).then(
      (d) => {
        setDevices(d)
        setSerial((s) => (d.some((x) => x.serial === s && x.state === 'device') ? s : (d.find((x) => x.state === 'device')?.serial ?? '')))
      },
      () => setDevices([])
    )
  }, [projectId])

  useEffect(() => {
    loadInfo()
    loadDevices()
    // Phones come and go: re-check every few seconds while this tab is open.
    const t = setInterval(loadDevices, 5000)
    const tick = setInterval(() => setTick((n) => n + 1), 1000)
    const onRun = (): void => {
      loadInfo()
      setTick((n) => n + 1)
    }
    runListeners.add(onRun)
    return () => {
      clearInterval(t)
      clearInterval(tick)
      runListeners.delete(onRun)
    }
  }, [loadInfo, loadDevices])

  /** Hand text to Claude: the open Claude terminal, or a new one. */
  const toClaude = async (title: string, prompt: string): Promise<void> => {
    const target = claudeTerminalFor(projectId, null)
    if (target) {
      setActive(projectId, target)
      sendToTerminal(target, prompt)
    } else await openClaudeTask(projectId, { title, prompt, plan: false })
    goTab('terminal')
  }

  const build = async (where: 'local' | 'cloud'): Promise<void> => {
    setMsg(null)
    try {
      const { command, abi } = await api.mobileBuildCommand(projectId, variant, where, target, serial)
      const label = where === 'cloud' ? 'Cloud build (EAS)' : `APK build (${variant}${abi ? `, ${abi}` : ', all phones'})`
      const id = await openTerminal(projectId, { title: label, command })
      runs.set(projectId, { terminalId: id, label, startedAt: Date.now() })
      setTick((n) => n + 1)
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message })
    }
  }

  const fixBuild = async (): Promise<void> => {
    if (!run) return
    const log = plain(await api.termBacklog(run.terminalId))
    const file = await api.mobileSaveLog(projectId, log)
    await toClaude('Fix the build', `The Android build failed (${run.label}). The full build output is in this file: ${file}\nRead it, find the cause, and fix it. Then tell me how to build again.`)
  }

  const logTerminals = list.filter((t) => t.title.startsWith('Device logs'))
  const showLogs = async (d: MobileDevice): Promise<void> => {
    const command = await api.mobileLogsCommand(projectId, d.serial)
    await openTerminal(projectId, { title: `Device logs · ${d.name}`, command })
    goTab('terminal')
  }
  const crashToClaude = async (): Promise<void> => {
    const t = logTerminals[logTerminals.length - 1]
    if (!t) return
    const crash = crashFrom(await api.termBacklog(t.id))
    const file = await api.mobileSaveLog(projectId, crash)
    await toClaude('Fix the crash', `The app crashed or showed errors on the device. The device log is in this file: ${file}\nRead it, find the cause in our code, and fix it.`)
  }

  const install = async (b: ApkBuild): Promise<void> => {
    if (!serial) return
    setInstalling(true)
    setMsg(null)
    try {
      const r = await api.mobileInstall(projectId, b.rel, serial)
      const name = devices?.find((d) => d.serial === serial)?.name ?? 'the device'
      setMsg({ tone: r.ok ? 'ok' : 'bad', text: r.ok ? `Installed ${b.name} on ${name}.` : r.message })
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message })
    } finally {
      setInstalling(false)
    }
  }

  if (info === undefined) return <p className="muted pad">Looking at the project…</p>
  if (info === null)
    return (
      <div className="pad">
        <p className="muted">This project doesn’t look like a mobile app (Expo, React Native, Flutter, Capacitor or Android).</p>
      </div>
    )

  const latest = info.builds[0]
  const ready = (devices ?? []).filter((d) => d.state === 'device')
  const fullPath = (b: ApkBuild): string => `${project.localPath!.replace(/[\\/]+$/, '')}${api.platform === 'win32' ? '\\' : '/'}${b.rel.replace(/\//g, api.platform === 'win32' ? '\\' : '/')}`
  const running = run && run.exitCode === undefined
  // Only these compile native code per CPU type.
  const perCpu = info.kind === 'expo' || info.kind === 'react-native' || info.kind === 'flutter'
  const phoneName = ready.find((d) => d.serial === serial)?.name
  const elapsed = run ? Math.round((Date.now() - run.startedAt) / 1000) : 0

  return (
    <div className="mobile-panel">
      <p className="muted small mobile-kind">
        <Icon name="phone" size={14} /> {info.label} app{info.appId ? <> · <code>{info.appId}</code></> : null}
      </p>

      {msg && <div className={`notice ${msg.tone}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      {/* ---------- Build ---------- */}
      <section className="card">
        <div className="card-head">
          <h3>Build an APK</h3>
          <div className="row gap-s">
            {info.canBuildLocally && perCpu && (
              <select
                className="input small-select"
                value={target}
                onChange={(e) => setTarget(e.target.value as 'phone' | 'all')}
                disabled={!!running}
                title="For this phone: only its CPU type, several times faster and a smaller APK. All phones: every CPU type, for sharing with testers."
              >
                <option value="phone">{phoneName ? `For ${phoneName}` : 'For modern phones (64-bit)'}</option>
                <option value="all">For all phones</option>
              </select>
            )}
            {info.canBuildLocally && (
              <select className="input small-select" value={variant} onChange={(e) => setVariant(e.target.value as 'release' | 'debug')} disabled={!!running}>
                <option value="release">Release</option>
                <option value="debug">Debug</option>
              </select>
            )}
            {info.canBuildLocally && (
              <button className="btn primary" onClick={() => void build('local')} disabled={!!running} title="Build on this computer (Gradle)">
                <Icon name="play" size={14} /> Build APK
              </button>
            )}
            {info.hasEas && (
              <button className="btn" onClick={() => void build('cloud')} disabled={!!running} title="Build in Expo's cloud (EAS); the APK link appears in the terminal">
                Cloud build (EAS)
              </button>
            )}
          </div>
        </div>
        {!info.canBuildLocally && !info.hasEas && <p className="muted small">There’s no android folder to build from yet.</p>}
        {run && (
          <div className={`build-status ${running ? 'running' : run.exitCode === 0 ? 'ok' : 'bad'}`}>
            {running ? (
              <>
                <span className="working-dot" /> {run.label}: building… {Math.floor(elapsed / 60)}m {elapsed % 60}s
              </>
            ) : run.exitCode === 0 ? (
              <>
                <Icon name="check" size={15} /> {run.label} finished.
              </>
            ) : (
              <>
                <Icon name="alert" size={15} /> {run.label} failed (exit code {run.exitCode}).
              </>
            )}
            <span className="grow" />
            <button
              className="btn small-btn"
              onClick={() => {
                setActive(projectId, run.terminalId)
                goTab('terminal')
              }}
            >
              <Icon name="terminal" size={14} /> {running ? 'Watch' : 'Output'}
            </button>
            {!running && run.exitCode !== 0 && (
              <button className="btn small-btn primary" onClick={() => void fixBuild()} title="Give Claude the build output and ask it to fix the problem">
                <Icon name="sparkle" size={14} /> Fix with Claude
              </button>
            )}
          </div>
        )}
      </section>

      {/* ---------- Latest build ---------- */}
      <section className="card">
        <div className="card-head">
          <h3>Latest build</h3>
          <button className="icon-btn" title="Look again" onClick={loadInfo}>
            <Icon name="refresh" size={15} />
          </button>
        </div>
        {!latest ? (
          <p className="muted small">No APK built yet.</p>
        ) : (
          <>
            <div className="apk-row">
              <Icon name="download" size={18} />
              <div className="apk-main">
                <b>{latest.name}</b>
                <span className="muted small">
                  {latest.versionName ? `Version ${latest.versionName}${latest.versionCode != null ? ` (${latest.versionCode})` : ''} · ` : ''}
                  {latest.variant ? `${latest.variant} · ` : ''}
                  {size(latest.sizeBytes)} · built {relTime(latest.builtAt)}
                </span>
              </div>
              <button className="btn small-btn" onClick={() => void api.revealFile(projectId, latest.rel)} title="Show the APK in its folder, e.g. to share it">
                <Icon name="external" size={14} /> Show in folder
              </button>
              <button className="btn small-btn" onClick={() => void navigator.clipboard.writeText(fullPath(latest)).then(() => setMsg({ tone: 'ok', text: 'Path copied.' }))}>
                <Icon name="copy" size={14} /> Copy path
              </button>
            </div>
            <div className="row gap-s install-row">
              <select className="input small-select" value={serial} onChange={(e) => setSerial(e.target.value)} disabled={!ready.length}>
                {!ready.length && <option value="">No device connected</option>}
                {ready.map((d) => (
                  <option key={d.serial} value={d.serial}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button className="btn primary" disabled={!serial || installing || !info.adb} onClick={() => void install(latest)}>
                <Icon name="phone" size={14} /> {installing ? 'Installing…' : 'Install on device'}
              </button>
              {info.builds.length > 1 && <span className="muted small">{info.builds.length - 1} older build{info.builds.length > 2 ? 's' : ''} in the build folder</span>}
            </div>
          </>
        )}
      </section>

      {/* ---------- Devices and logs ---------- */}
      <section className="card">
        <div className="card-head">
          <h3>Devices and logs</h3>
          <button className="icon-btn" title="Look again" onClick={loadDevices}>
            <Icon name="refresh" size={15} />
          </button>
        </div>
        {!info.adb ? (
          <p className="muted small">adb (Android platform tools) wasn’t found. Install Android Studio or the Android SDK platform tools.</p>
        ) : devices === null ? (
          <p className="muted small">Looking for devices…</p>
        ) : devices.length === 0 ? (
          <p className="muted small">No phone or emulator connected. Plug in a phone with USB debugging on, or start an emulator.</p>
        ) : (
          <div className="device-list">
            {devices.map((d) => (
              <div key={d.serial} className="device-row">
                <Icon name="phone" size={16} />
                <b>{d.name}</b>
                <span className="muted small">{d.emulator ? 'Emulator' : d.serial}</span>
                {d.state !== 'device' && (
                  <span className="badge warn">{d.state === 'unauthorized' ? 'Allow USB debugging on the phone' : d.state}</span>
                )}
                <span className="grow" />
                <button className="btn small-btn" disabled={d.state !== 'device'} onClick={() => void showLogs(d)} title="Show the app's logs and crashes from this device in a terminal">
                  <Icon name="terminal" size={14} /> Show logs
                </button>
              </div>
            ))}
          </div>
        )}
        {logTerminals.length > 0 && (
          <div className="row gap-s logs-actions">
            <button className="btn small-btn primary" onClick={() => void crashToClaude()} title="Give Claude the latest crash or errors from the device logs">
              <Icon name="sparkle" size={14} /> Send crash to Claude
            </button>
            <span className="muted small">Uses the newest crash in “{logTerminals[logTerminals.length - 1].title}”.</span>
          </div>
        )}
      </section>
    </div>
  )
}
