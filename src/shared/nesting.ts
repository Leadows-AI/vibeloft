// A project whose folder is inside another project's folder is its sub-project.
// Worked out from the paths, so nothing extra is saved and it can't go stale.

import type { Project } from './types'

// shortcut: ignores case everywhere, so two folders differing only in case (possible on Linux) would match.
export const folderKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The closest project among `list` whose folder contains `p`'s folder. */
export function parentProject(p: Project, list: Project[]): Project | null {
  if (!p.localPath) return null
  const path = folderKey(p.localPath)
  let best: Project | null = null
  for (const other of list) {
    if (!other.localPath) continue
    const dir = folderKey(other.localPath)
    if (path.startsWith(`${dir}/`) && (!best || dir.length > folderKey(best.localPath!).length)) best = other
  }
  return best
}
