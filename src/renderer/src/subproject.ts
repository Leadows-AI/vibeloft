import { folderKey } from '../../shared/nesting'
import type { Database, Project } from '../../shared/types'
import type { AppCtx } from './App'
import { api, nowIso, uid } from './ui'

const folderPath = (parent: Project, rel: string): string => {
  const sep = parent.localPath!.includes('\\') ? '\\' : '/'
  return [parent.localPath!.replace(/[\\/]+$/, ''), ...rel.split('/')].join(sep)
}

/** The project already added for a folder inside `projectId`'s folder, if any. */
export function projectAt(db: Database, projectId: string, rel: string): Project | undefined {
  const key = folderKey(folderPath(db.projects.find((p) => p.id === projectId)!, rel))
  return db.projects.find((p) => p.localPath && folderKey(p.localPath) === key)
}

export async function addSubproject(ctx: AppCtx, projectId: string, rel: string): Promise<void> {
  const parent = ctx.db.projects.find((p) => p.id === projectId)!
  const path = folderPath(parent, rel)
  const info = await api.inspectFolder(path)
  // A folder that isn't its own repository reports the parent's: don't link it twice.
  const repo = info.repo === parent.repo ? null : info.repo
  ctx.setDb(
    await api.saveProject({
      id: uid(),
      name: repo ? info.name : rel.split('/').pop()!,
      customerId: parent.customerId,
      kind: info.kind,
      status: 'active',
      description: '',
      localPath: path,
      repo,
      techStack: info.techStack,
      architecture: '',
      architectureUpdatedAt: null,
      claudeSessionId: null,
      lastSyncedAt: null,
      createdAt: nowIso()
    })
  )
}
