import { useEffect, useState, type ReactNode } from 'react'
import type { UpdateStatus } from '../../shared/types'
import { api, relTime } from './ui'
import { Icon, type IconName } from './icons'
import mark from './assets/vibeloft-mark.svg'

// Updates: the sidebar shows "Restart to update" once a new version has
// downloaded; Settings shows the version and its update status with the one
// action that fits it, and a switch to turn automatic updates off.

export function useUpdateStatus(): UpdateStatus | null {
  const [s, setS] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    api.updateStatus().then(setS, () => setS(null))
    return api.onUpdateStatus(setS)
  }, [])
  return s
}

/** In the sidebar: only shown while downloading or when an update is ready. */
export function UpdateNotice(): ReactNode {
  const s = useUpdateStatus()
  if (!s) return null
  if (s.state === 'downloading') {
    return (
      <div className="update-notice muted small" title={`Downloading Vibeloft ${s.available ?? ''}`}>
        Downloading update… {s.percent ?? 0}%
      </div>
    )
  }
  if (s.state !== 'ready') return null
  return (
    <div className="update-notice ready">
      <div>
        <b>Vibeloft {s.available}</b> is ready.
      </div>
      <button className="btn small-btn primary" onClick={() => void api.updateInstall()}>
        Restart to update
      </button>
      <div className="muted small">Or it installs next time you close Vibeloft.</div>
    </div>
  )
}

/** Bottom of the sidebar: which version is running. */
export function SidebarVersion(): ReactNode {
  const s = useUpdateStatus()
  return s ? <div className="sidebar-version muted small">Vibeloft v{s.current}</div> : null
}

const LICENSE_URL = 'https://github.com/Leadows-AI/vibeloft/blob/main/LICENSE'

const RELEASES ='https://github.com/Leadows-AI/vibeloft/releases'

type Tone = 'good' | 'info' | 'warn' | 'bad' | 'muted'

/** What to say about each update state: icon, headline, detail and colour. */
function describe(s: UpdateStatus, auto: boolean): { tone: Tone; icon: IconName; title: string; detail: string; spin?: boolean } {
  switch (s.state) {
    case 'dev':
      return { tone: 'muted', icon: 'tool', title: 'Development copy', detail: 'This copy runs from the source code and never updates itself. The installed Vibeloft does.' }
    case 'checking':
      return { tone: 'info', icon: 'refresh', title: 'Checking for updates…', detail: 'Looking for a newer version of Vibeloft.', spin: true }
    case 'downloading':
      return { tone: 'info', icon: 'download', title: `Downloading Vibeloft ${s.available ?? ''}`, detail: 'You can keep working. It installs when you restart.' }
    case 'ready':
      return { tone: 'good', icon: 'download', title: `Vibeloft ${s.available} is ready to install`, detail: 'Restart now to finish, or it installs the next time you close Vibeloft.' }
    case 'latest':
      return { tone: 'good', icon: 'check', title: 'You’re up to date', detail: s.checkedAt ? `Last checked ${relTime(s.checkedAt)}.` : 'You have the newest version.' }
    case 'error':
      return { tone: 'bad', icon: 'alert', title: 'Couldn’t check for updates', detail: s.message ?? 'Something went wrong. Check your connection and try again.' }
    default:
      return auto
        ? { tone: 'muted', icon: 'timer', title: 'Not checked yet', detail: 'Vibeloft checks shortly after it starts, then every 4 hours.' }
        : { tone: 'muted', icon: 'timer', title: 'Automatic updates are off', detail: 'Use Check now to look for a new version.' }
  }
}

/** The Updates tab in Settings: this version and its update status, then the automatic-updates switch. */
export function UpdatesCard(props: { auto: boolean; setAuto: (on: boolean) => void }): ReactNode {
  const s = useUpdateStatus()
  if (!s) return null
  const d = describe(s, props.auto)
  const busy = s.state === 'checking' || s.state === 'downloading'
  const notes = s.state === 'ready' && s.available ? `${RELEASES}/tag/v${s.available}` : RELEASES
  return (
    <>
      <section className="card update-card" id="updates-card">
        <div className="update-head">
          <img src={mark} alt="" className="update-mark" draggable={false} />
          <div className="update-version">
            <h3>Vibeloft {s.current}</h3>
            <span className="muted small">A room for every project.</span>
            <span className="muted small">
              © 2026 Leadows Technologies
            </span>
            <span className="muted small">
              Open source under the{' '}
              <button className="link" onClick={() => void api.openUrl(LICENSE_URL)} title={LICENSE_URL}>
                Apache License 2.0
              </button>
            </span>
          </div>
          <button className="link update-notes" onClick={() => void api.openUrl(notes)} title={notes}>
            {s.state === 'ready' ? 'What’s new' : 'Release notes'} <Icon name="external" size={12} />
          </button>
        </div>

        <div className={`update-status ${d.tone}`} role="status" aria-live="polite">
          <span className="update-status-icon">
            <Icon name={d.icon} size={18} className={d.spin ? 'spin' : ''} />
          </span>
          <div className="update-status-text">
            <b>{d.title}</b>
            <span>{d.detail}</span>
            {s.state === 'downloading' && (
              <span className="update-progress" aria-label={`Downloaded ${s.percent ?? 0}%`}>
                <span style={{ width: `${s.percent ?? 0}%` }} />
              </span>
            )}
          </div>
          {s.state === 'ready' ? (
            <button className="btn primary" onClick={() => void api.updateInstall()}>
              Restart to update
            </button>
          ) : s.state === 'downloading' ? (
            <span className="update-percent">{s.percent ?? 0}%</span>
          ) : s.state !== 'dev' ? (
            <button className="btn" disabled={busy} onClick={() => void api.updateCheck()}>
              {s.state === 'error' ? 'Try again' : s.state === 'latest' ? 'Check again' : 'Check now'}
            </button>
          ) : null}
        </div>
      </section>

      <section className="card">
        <h3>Update settings</h3>
        <label className="switch-row">
          <span className="switch-text">
            <b>Download updates automatically</b>
            <span className="muted small">
              {props.auto
                ? 'Vibeloft checks shortly after it starts and every 4 hours, downloads in the background, and installs when you restart.'
                : 'Vibeloft won’t look for updates by itself. Check now still downloads one if there is one.'}
            </span>
          </span>
          <input type="checkbox" role="switch" className="switch" checked={props.auto} onChange={(e) => props.setAuto(e.target.checked)} />
        </label>
        <p className="muted small update-portable">The portable copy doesn’t update itself. Use the installer to get updates.</p>
      </section>
    </>
  )
}
