import { db } from './connection'

/* -------------------------------------------------------------- spending */
export function conversationCosts(): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT conversation_id AS id, COALESCE(SUM(cost), 0) AS total
       FROM messages GROUP BY conversation_id`
    )
    .all() as { id: string; total: number }[]
  return Object.fromEntries(rows.map((r) => [r.id, r.total]))
}

export function projectCosts(): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT c.project_id AS id, COALESCE(SUM(m.cost), 0) AS total
       FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
       GROUP BY c.project_id`
    )
    .all() as { id: string; total: number }[]
  return Object.fromEntries(rows.map((r) => [r.id, r.total]))
}

/** Spend per day, newest first, for the usage view. */
export function dailyCosts(days: number): { day: string; total: number; messages: number }[] {
  return db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day,
              COALESCE(SUM(cost), 0) AS total,
              COUNT(*) AS messages
       FROM messages WHERE cost IS NOT NULL
       GROUP BY day ORDER BY day DESC LIMIT ?`
    )
    .all(days) as { day: string; total: number; messages: number }[]
}

