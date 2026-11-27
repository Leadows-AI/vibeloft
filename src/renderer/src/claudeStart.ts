import type { ClaudeSession, Database } from '../../shared/types'
import { addDirFlags } from './links'
import { api } from './ui'

// Starting Claude Code in a project: carry on with the last conversation or
// start a new one (New conversation / Continue in the Terminal tab). Linked
// projects are added with --add-dir so Claude can read them too.

export type ClaudeStart = 'continue' | 'new'

/** Folders of projects linked to this one. */
export function linkedFolders(db: Database, projectId: string): { name: string; path: string }[] {
  return db.links
    .filter((l) => l.consumerId === projectId || l.providerId === projectId)
    .map((l) => db.projects.find((p) => p.id === (l.consumerId === projectId ? l.providerId : l.consumerId)))
    .filter((p): p is NonNullable<typeof p> => !!p?.localPath)
    .map((p) => ({ name: p.name, path: p.localPath! }))
}

/**
 * The conversation "continue" should reopen: the project's most recent one
 * started in a terminal (VS Code's own conversations are left to History),
 * unless it's already open in a terminal here.
 */
export async function conversationToContinue(projectId: string, openIds: Set<string>): Promise<ClaudeSession | null> {
  const list = await api.claudeSessions(projectId).catch(() => [] as ClaudeSession[])
  const latest = list.find((s) => !s.fromEditor)
  return latest && !openIds.has(latest.id) ? latest : null
}

/** Tab name for a conversation carried on from before (Continue, History, Reopen). */
export const CONTINUED = 'Claude Code (continued)'

/** The command and tab title for starting Claude Code the way you prefer. */
export async function claudeCommand(
  db: Database,
  projectId: string,
  openIds: Set<string>,
  how: ClaudeStart
): Promise<{ command: string; title: string }> {
  const dirs = linkedFolders(db, projectId)
  const resume = how === 'continue' ? await conversationToContinue(projectId, openIds) : null
  return {
    command: `claude${resume ? ` --resume ${resume.id}` : ''}${addDirFlags(dirs.map((d) => d.path))}`,
    title: resume ? CONTINUED : 'Claude Code'
  }
}
