import type { ReactNode } from 'react'
import type { AppCtx } from '../App'
import { Icon } from '../icons'
import { api } from '../ui'

/** Help and the light/dark switch: one small group in the top-right corner of every screen. */
export function AppTools({ ctx }: { ctx: AppCtx }): ReactNode {
  const dark = ctx.theme === 'dark'
  return (
    <div className="app-tools" role="group" aria-label="Help and theme">
      <button className="help-launch" title="Help, tours and getting started (F1)" aria-label="Help and tours" onClick={ctx.toggleHelp}>
        <Icon name="help" size={17} />
      </button>
      <button
        className="theme-toggle"
        title={dark ? 'Switch to light' : 'Switch to dark'}
        aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={async () => ctx.setDb(await api.saveSettings({ ...ctx.db.settings, theme: dark ? 'light' : 'dark' }))}
      >
        <Icon name={dark ? 'sun' : 'moon'} size={17} />
      </button>
    </div>
  )
}
