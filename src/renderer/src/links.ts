import { useSyncExternalStore } from 'react'
import type { Database, LinkStatus, ProjectLink } from '../../shared/types'
import { api } from './ui'

// Live status of linked projects: has the provider's API changed since the
// consumer app was last updated? Refreshed when Vibeloft starts, when you come
// back to the window, when the provider's files change, and every 2 minutes.

const statuses = new Map<string, LinkStatus>()
const listeners = new Set<() => void>()
let version = 0
let current: ProjectLink[] = []

function bump(): void {
  version++
  for (const l of listeners) l()
}

export function setLinks(links: ProjectLink[]): void {
  current = links
  for (const id of [...statuses.keys()]) if (!links.some((l) => l.id === id)) statuses.delete(id)
  void refreshLinks()
}

export async function refreshLinks(ids?: string[]): Promise<void> {
  const list = ids ? current.filter((l) => ids.includes(l.id)) : current
  await Promise.all(
    list.map(async (l) => {
      try {
        statuses.set(l.id, await api.linkStatus(l.id))
      } catch {
        /* provider folder missing: leave as is */
      }
    })
  )
  bump()
}

window.addEventListener('focus', () => void refreshLinks())
setInterval(() => void refreshLinks(), 2 * 60_000)
let timer: ReturnType<typeof setTimeout> | null = null
api.onFilesChanged((e) => {
  const ids = current.filter((l) => l.providerId === e.projectId).map((l) => l.id)
  if (!ids.length) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void refreshLinks(ids), 800)
})

export function useLinkStatuses(): Map<string, LinkStatus> {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
  return statuses
}

/** API commits the consumer hasn't been updated for yet. */
export function pendingFor(status: LinkStatus | undefined): number {
  return status ? status.commits.length : 0
}

/** Pending API changes across all links where this project is the app. */
export function pendingForProject(db: Database, projectId: string, map: Map<string, LinkStatus>): number {
  return db.links.filter((l) => l.consumerId === projectId).reduce((n, l) => n + pendingFor(map.get(l.id)), 0)
}

export function linksOf(db: Database, projectId: string): { uses: ProjectLink[]; usedBy: ProjectLink[] } {
  return {
    uses: db.links.filter((l) => l.consumerId === projectId),
    usedBy: db.links.filter((l) => l.providerId === projectId)
  }
}

/** The prompt that asks Claude (in the app's folder, able to read the provider) to catch up. */
export function updatePrompt(db: Database, link: ProjectLink, status: LinkStatus | undefined): string {
  const provider = db.projects.find((p) => p.id === link.providerId)
  const consumer = db.projects.find((p) => p.id === link.consumerId)
  const pPath = provider?.localPath ?? ''
  const paths = link.apiPaths.length ? link.apiPaths.join(' ') : '.'
  const commits = status?.commits ?? []
  const lines: string[] = []
  lines.push(`The API of ${provider?.name ?? 'the linked project'} changed. Update ${consumer?.name ?? 'this app'} (this folder) to match.`)
  lines.push('')
  lines.push(`${provider?.name ?? 'The API project'} is in: ${pPath} (you can read it). Its public API is defined in: ${paths}`)
  if (commits.length) {
    lines.push('')
    lines.push(`API commits since this app was last updated (newest first):`)
    for (const c of commits.slice(0, 20)) lines.push(`- ${c.hash} ${c.subject} (${c.date.slice(0, 10)})`)
    if (commits.length > 20) lines.push(`- …and ${commits.length - 20} more`)
  }
  if (status?.uncommitted.length) {
    lines.push('')
    lines.push(`Not committed yet in ${provider?.name ?? 'the API project'}: ${status.uncommitted.slice(0, 15).join(', ')}`)
  }
  lines.push('')
  if (link.syncedCommit) lines.push(`See exactly what changed with: git -C "${pPath}" diff ${link.syncedCommit.slice(0, 12)} -- ${paths}`)
  else lines.push(`See what changed with: git -C "${pPath}" log -p -10 -- ${paths}`)
  if (link.envVar) lines.push(`This app reads the API address from ${link.envVar}. Never print or copy secret values from .env files.`)
  lines.push('')
  lines.push('Please:')
  lines.push('1. Read the diff and list what changed in the public API: new, removed or renamed endpoints, fields and types.')
  lines.push('2. Find where this app uses them and update the calls, types, parsing and screens.')
  lines.push('3. If the app is already released, keep it working with the API that is live now, or tell me what must be deployed first.')
  lines.push("4. Run the project's type check and tests and fix what fails.")
  lines.push(`5. Summarize what you changed. Don't change files in ${provider?.name ?? 'the API project'} and don't commit.`)
  return lines.join('\n')
}

/** `--add-dir` options typed into the shell (PowerShell on Windows, sh on macOS). */
export function addDirFlags(dirs: string[]): string {
  return dirs
    .filter(Boolean)
    .map((d) => (api.platform === 'win32' ? ` --add-dir '${d.replace(/'/g, "''")}'` : ` --add-dir '${d.replace(/'/g, "'\\''")}'`))
    .join('')
}
