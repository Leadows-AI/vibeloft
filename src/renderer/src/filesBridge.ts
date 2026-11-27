// Lets other tabs ask the Files tab to open a file or the Ctrl+P palette,
// without importing the editor (which loads only when the Files tab opens).

interface Requests {
  open: { rel: string; line?: number; col?: number } | null
  quickOpen: boolean
}

const pending = new Map<string, Requests>()

function get(projectId: string): Requests {
  let r = pending.get(projectId)
  if (!r) pending.set(projectId, (r = { open: null, quickOpen: false }))
  return r
}

export function requestOpen(projectId: string, rel: string, line?: number, col?: number): void {
  get(projectId).open = { rel, line, col }
}

export function requestQuickOpen(projectId: string): void {
  get(projectId).quickOpen = true
}

/** Called by the Files tab: returns and clears what was requested. */
export function takeRequests(projectId: string): Requests {
  const r = { ...get(projectId) }
  pending.set(projectId, { open: null, quickOpen: false })
  return r
}
