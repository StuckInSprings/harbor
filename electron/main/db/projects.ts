import type { Project } from '../../../shared/types'
import { GENERAL_PROJECT_ID, GENERAL_PROJECT_NAME } from '../../../shared/types'
import { parseHooks } from '../../../shared/hooks'
import { db, id, now } from './connection'

/* ---------------------------------------------------------------- projects */
type ProjectRow = {
  id: string
  name: string
  root_path: string | null
  system_prompt: string
  default_model: string | null
  unlocked: string
  system_as_user: number
  params: string
  hooks: string
  write_globs: string
  context_files: string
  auto_approve: number
  tiers: string
  archived: number
  created_at: number
  updated_at: number
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  rootPath: r.root_path,
  systemPrompt: r.system_prompt,
  defaultModel: r.default_model,
  unlocked: safeParse(r.unlocked),
  systemAsUser: r.system_as_user === 1,
  params: parseParams(r.params),
  hooks: parseHooks(r.hooks),
  writeGlobs: safeParse(r.write_globs),
  contextFiles: safeParse(r.context_files),
  autoApprove: r.auto_approve === 1,
  tiers: r.tiers ?? '',
  archived: r.archived === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function parseParams(raw: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export function safeParse(raw: string | null): Project['unlocked'] {
  try {
    const v = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** The general scope exists from the first launch and sorts ahead of every project. */
export function ensureGeneral(): void {
  if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(GENERAL_PROJECT_ID)) return
  db.prepare(
    `INSERT INTO projects (id, name, root_path, system_prompt, default_model, created_at, updated_at) VALUES (?, ?, NULL, '', NULL, 0, 0)`
  ).run(GENERAL_PROJECT_ID, GENERAL_PROJECT_NAME)
}

export function listProjects(): Project[] {
  // In the order the person dragged them into; a project never placed goes after the rest, oldest first.
  const rows = db.prepare('SELECT * FROM projects ORDER BY position IS NULL, position, created_at').all() as ProjectRow[]
  return rows.map(toProject)
}

/** The sidebar's order, as a list of ids: each takes its place in it, and any not named keeps its own after them. */
/** Put away, or brought back. The conversations stay as they were; only the project's place in the lists changes. */
export function setProjectArchived(projectId: string, archived: boolean): void {
  db.prepare('UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, now(), projectId)
}

export function reorderProjects(ids: string[]): void {
  const set = db.prepare('UPDATE projects SET position = ? WHERE id = ?')
  db.transaction(() => ids.forEach((id, i) => set.run(i, id)))()
}

export function createProject(name: string, rootPath: string | null): Project {
  const t = now()
  const p: ProjectRow = {
    id: id(),
    name,
    root_path: rootPath,
    system_prompt: '',
    default_model: null,
    unlocked: '[]',
    system_as_user: 0,
    params: '{}',
    hooks: '[]',
    write_globs: '[]',
    context_files: '[]',
    auto_approve: 0,
    tiers: '',
    archived: 0,
    created_at: t,
    updated_at: t
  }
  db.prepare(
    `INSERT INTO projects (id, name, root_path, system_prompt, default_model, unlocked, system_as_user, params, hooks, write_globs, context_files, auto_approve, tiers, created_at, updated_at)
     VALUES (@id, @name, @root_path, @system_prompt, @default_model, @unlocked,
             @system_as_user, @params, @hooks, @write_globs, @context_files, @auto_approve, @tiers, @created_at, @updated_at)`
  ).run(p)
  return toProject(p)
}

export function updateProject(
  projectId: string,
  patch: Partial<Pick<Project, 'name' | 'systemPrompt' | 'defaultModel' | 'rootPath' | 'unlocked' | 'systemAsUser' | 'params' | 'hooks' | 'writeGlobs' | 'contextFiles' | 'autoApprove' | 'tiers'>>
): void {
  const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow
  if (!current) return
  db.prepare(
    `UPDATE projects SET name = ?, root_path = ?, system_prompt = ?, default_model = ?,
       unlocked = ?, system_as_user = ?, params = ?, hooks = ?, write_globs = ?, context_files = ?, auto_approve = ?, tiers = ?, updated_at = ? WHERE id = ?`
  ).run(
    patch.name ?? current.name,
    patch.rootPath !== undefined ? patch.rootPath : current.root_path,
    patch.systemPrompt ?? current.system_prompt,
    patch.defaultModel !== undefined ? patch.defaultModel : current.default_model,
    patch.unlocked ? JSON.stringify(patch.unlocked) : current.unlocked,
    patch.systemAsUser === undefined ? current.system_as_user : patch.systemAsUser ? 1 : 0,
    patch.params ? JSON.stringify(patch.params) : current.params,
    patch.hooks ? JSON.stringify(parseHooks(JSON.stringify(patch.hooks))) : current.hooks,
    patch.writeGlobs
      ? JSON.stringify(patch.writeGlobs.filter((g) => typeof g === 'string' && g.trim()))
      : current.write_globs,
    patch.contextFiles
      ? JSON.stringify(patch.contextFiles.filter((g) => typeof g === 'string' && g.trim()))
      : current.context_files,
    patch.autoApprove === undefined ? current.auto_approve : patch.autoApprove ? 1 : 0,
    typeof patch.tiers === 'string' ? patch.tiers : current.tiers,
    now(),
    projectId
  )
}
export function deleteProject(projectId: string): void {
  if (projectId === GENERAL_PROJECT_ID) throw new Error('Chats is where conversations without a project live; it cannot be removed.')
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
}

export function getProject(projectId: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | ProjectRow
    | undefined
  return row ? toProject(row) : null
}
