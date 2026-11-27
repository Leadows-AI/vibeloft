import type { ProjectTab } from './components/ProjectView'

// Each project remembers the tab you were last on, so coming back to it lands
// where you left off. A project you haven't opened yet starts on Terminal.
// Kept in this computer's local storage, so it survives restarts.

const KEY = 'vibeloft.projectTabs'
const tabs = new Map<string, ProjectTab>()

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, ProjectTab>
  for (const [id, tab] of Object.entries(saved)) tabs.set(id, tab)
} catch {
  /* storage unavailable or damaged: start fresh */
}

export function rememberTab(projectId: string, tab: ProjectTab): void {
  if (tabs.get(projectId) === tab) return
  tabs.set(projectId, tab)
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(tabs)))
  } catch {
    /* storage unavailable */
  }
}

/** The tab to open a project on: where you left it, else Terminal (Overview if it has no folder). */
export function tabFor(projectId: string, hasFolder: boolean): ProjectTab {
  return tabs.get(projectId) ?? (hasFolder ? 'terminal' : 'overview')
}
