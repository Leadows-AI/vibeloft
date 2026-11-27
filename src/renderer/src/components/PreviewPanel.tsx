import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { AppCtx } from '../App'
import { useDevUrls } from '../previewUrls'
import { api } from '../ui'

// Live preview of the app you're building, next to your work. Dev servers
// started in this project's terminals are detected automatically. Only local
// addresses (localhost / 127.0.0.1) can be shown here.

const remembered = new Map<string, { url: string; device: Device }>()
type Device = 'desktop' | 'tablet' | 'phone'
const WIDTH: Record<Device, string> = { desktop: '100%', tablet: '820px', phone: '390px' }
const isLocal = (u: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)
const terminals = (): Promise<typeof import('../termStore')> => import('../termStore')

export function PreviewPanel({ ctx, projectId }: { ctx: AppCtx; projectId: string }): ReactNode {
  const project = ctx.db.projects.find((p) => p.id === projectId)!
  const detected = useDevUrls(projectId)
  const saved = remembered.get(projectId)
  const [url, setUrl] = useState(saved?.url ?? '')
  const [input, setInput] = useState(saved?.url ?? '')
  const [device, setDevice] = useState<Device>(saved?.device ?? 'desktop')
  const [reloadKey, setReloadKey] = useState(0)
  const [scripts, setScripts] = useState<{ label: string; command: string }[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (project.localPath) api.termScripts(projectId).then(setScripts, () => {})
  }, [projectId])

  // Use the first dev server we see if nothing is chosen yet.
  useEffect(() => {
    if (!url && detected[0]) go(detected[0])
  }, [detected[0]])

  useEffect(() => {
    remembered.set(projectId, { url, device })
  }, [url, device, projectId])

  function go(next: string): void {
    let u = next.trim()
    if (!u) return
    if (/^\d+$/.test(u)) u = `http://localhost:${u}` // just a port number
    if (!/^https?:\/\//i.test(u)) u = `http://${u}`
    if (!isLocal(u)) {
      setError('The preview shows local dev servers only (localhost). Use the open-in-browser button to open other sites.')
      return
    }
    setError(null)
    setUrl(u)
    setInput(u)
    setReloadKey((k) => k + 1)
  }

  const devScript = scripts.find((s) => /(^|: )(dev|start|web)$/.test(s.label)) ?? scripts.find((s) => /dev|start/.test(s.label))

  async function startDevServer(): Promise<void> {
    if (!devScript) return
    const t = await terminals()
    await t.openTerminal(projectId, { title: devScript.label, command: devScript.command })
  }

  return (
    <div className="preview-panel">
      <div className="preview-bar">
        <button className="icon-btn" title="Reload" onClick={() => setReloadKey((k) => k + 1)} disabled={!url}>
          <Icon name="refresh" size={15} />
        </button>
        <input
          className="input preview-url"
          placeholder="http://localhost:5173 (or just 5173)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go(input)}
        />
        <div className="segmented">
          {(['desktop', 'tablet', 'phone'] as Device[]).map((d) => (
            <button key={d} className={device === d ? 'on' : ''} onClick={() => setDevice(d)} title={WIDTH[d]}>
              {d === 'desktop' ? 'Desktop' : d === 'tablet' ? 'Tablet' : 'Phone'}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Open in your browser" onClick={() => url && api.openUrl(url)} disabled={!url}>
          <Icon name="external" size={15} />
        </button>
      </div>

      {detected.length > 0 && (
        <div className="preview-detected">
          <span className="muted small">Running:</span>
          {detected.map((u) => (
            <button key={u} className={`chip-btn ${u === url ? 'on' : ''}`} onClick={() => go(u)}>
              {u.replace(/^https?:\/\//, '')}
            </button>
          ))}
        </div>
      )}
      {error && <div className="notice warn preview-notice">{error}</div>}

      <div className="preview-stage">
        {url ? (
          <div className={`preview-frame ${device}`} style={{ width: WIDTH[device] }}>
            <iframe key={reloadKey} src={url} title={`Preview of ${project.name}`} />
          </div>
        ) : (
          <div className="term-empty">
            <h3>Preview your app</h3>
            <p className="muted">
              Start the dev server and the app appears here, updating as you or Claude change the code. Mobile (Expo) apps: start Expo and press{' '}
              <kbd>w</kbd> for the web version.
            </p>
            {devScript ? (
              <button className="btn primary" onClick={startDevServer}>
                <Icon name="play" size={14} /> Start dev server ({devScript.command})
              </button>
            ) : (
              <p className="muted small">Or type a local address above, such as 5173 or http://localhost:3000.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
