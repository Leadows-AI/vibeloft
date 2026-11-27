// Builds window.vibe on Tauri's IPC: every call goes to one Rust command, `ipc`,
// with the channel names in src/shared/channels.ts.
import { CALLS, EVENTS } from '../../shared/channels'
import type { VibeApi } from '../../shared/types'

interface TauriGlobal {
  core: { invoke(cmd: string, args: unknown): Promise<unknown> }
  event: { listen(ch: string, cb: (e: { payload: unknown }) => void): Promise<() => void> }
  window: { getCurrentWindow(): { setFocus(): Promise<void>; requestUserAttention(kind: number): Promise<void> } }
}

const T = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__

if (T) {
  const ipc = (channel: string, ...args: unknown[]): Promise<unknown> => T.core.invoke('ipc', { channel, args })
  const fire = (channel: string, ...args: unknown[]): void => void ipc(channel, ...args).catch(() => {})
  const ua = navigator.userAgent
  ;(window as unknown as { vibe: VibeApi }).vibe = {
    platform: ua.includes('Windows') ? 'win32' : ua.includes('Mac') ? 'darwin' : 'linux',
    ...Object.fromEntries(Object.entries(CALLS).map(([k, ch]) => [k, (...a: unknown[]) => ipc(ch, ...a)])),
    ...Object.fromEntries(
      Object.entries(EVENTS).map(([k, ch]) => [
        k,
        (cb: (e: unknown) => void) => {
          const off = T.event.listen(ch, (e) => cb(e.payload))
          return () => void off.then((f) => f())
        }
      ])
    ),
    termWrite: (id: string, data: string) => fire('term:write', id, data),
    termResize: (id: string, cols: number, rows: number) => fire('term:resize', id, cols, rows),
    // ponytail: webviews don't expose a dropped File's path; use Tauri's drag-drop event when porting drop-to-terminal.
    pathForFile: () => '',
    setDirtyCount: (count: number) => fire('app:dirty', count),
    focusWindow: () => void T.window.getCurrentWindow().setFocus(),
    requestAttention: () => void T.window.getCurrentWindow().requestUserAttention(2),
    // The close guard (app_shell.rs) asks the UI to save everything, then waits for the answer.
    onSaveAllRequest: (() => {
      let offSaveAll: Promise<() => void> | null = null
      return (handler: () => Promise<boolean>) => {
        void offSaveAll?.then((f) => f())
        offSaveAll = T.event.listen('app:saveAll', async () => {
          let ok = false
          try {
            ok = await handler()
          } finally {
            fire('app:savedAll', ok)
          }
        })
      }
    })()
  } as unknown as VibeApi
}
