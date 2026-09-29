import { db, id, now } from './connection'

/* ------------------------------------------------------ command allowlist */
export interface AllowedCommand {
  id: string
  pattern: string
  createdAt: number
}

export function listAllowedCommands(projectId: string): string[] {
  const rows = db
    .prepare('SELECT pattern FROM command_allowlist WHERE project_id = ? ORDER BY created_at')
    .all(projectId) as { pattern: string }[]
  return rows.map((r) => r.pattern)
}

export function listAllowedCommandRows(projectId: string): AllowedCommand[] {
  return db
    .prepare('SELECT id, pattern, created_at AS createdAt FROM command_allowlist WHERE project_id = ? ORDER BY created_at')
    .all(projectId) as AllowedCommand[]
}

export function allowCommand(projectId: string, pattern: string): void {
  const trimmed = pattern.trim()
  if (!trimmed) return
  if (listAllowedCommands(projectId).includes(trimmed)) return
  db.prepare(
    'INSERT INTO command_allowlist (id, project_id, pattern, created_at) VALUES (?, ?, ?, ?)'
  ).run(id(), projectId, trimmed, now())
}

export function removeAllowedCommand(rowId: string): void {
  db.prepare('DELETE FROM command_allowlist WHERE id = ?').run(rowId)
}
