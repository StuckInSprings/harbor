import { db, id, now } from './connection'

/* --------------------------------------------------------- prompt library */
export interface Prompt {
  id: string
  projectId: string | null
  name: string
  body: string
  createdAt: number
}

export function listPrompts(projectId: string | null): Prompt[] {
  return db
    .prepare(
      `SELECT id, project_id AS projectId, name, body, created_at AS createdAt FROM prompts
       WHERE project_id IS NULL OR project_id = ? ORDER BY name`
    )
    .all(projectId) as Prompt[]
}

export function savePrompt(
  promptId: string | null,
  projectId: string | null,
  name: string,
  body: string
): Prompt {
  const pid = promptId ?? id()
  db.prepare(
    `INSERT INTO prompts (id, project_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, body = excluded.body,
       project_id = excluded.project_id`
  ).run(pid, projectId, name.trim(), body, now())
  return listPrompts(projectId).find((p) => p.id === pid)!
}

export function removePrompt(promptId: string): void {
  db.prepare('DELETE FROM prompts WHERE id = ?').run(promptId)
}
