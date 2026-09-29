import { db } from './connection'
import { listMessages } from './messages'

/**
 * Re-links messages whose parent no longer exists.
 *
 * Deleting a message used to orphan everything below it, and the walk from the
 * leaf would stop at the gap — leaving conversations that looked emptied while
 * every message sat intact and unreachable. Deletion no longer does that, but
 * the damage it already did needs undoing, and a chain can only break this one
 * way, so this repairs whatever it finds.
 *
 * Cheap when there is nothing wrong: one query that normally returns no rows.
 */
export function repairBrokenChains(): void {
  const dangling = db
    .prepare(
      `SELECT m.id, m.conversation_id AS conv, m.created_at AS at, m.rowid AS rid
       FROM messages m
       WHERE m.parent_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.id = m.parent_id)`
    )
    .all() as { id: string; conv: string; at: number; rid: number }[]
  if (dangling.length === 0) return

  const previous = db.prepare(
    `SELECT id FROM messages
     WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND rowid < ?))
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  )
  const relink = db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?')
  const touched = new Set<string>()

  db.transaction(() => {
    for (const row of dangling) {
      // These chains were built by appending, so the message immediately
      // before is where this one belonged.
      const before = previous.get(row.conv, row.at, row.at, row.rid) as
        | { id: string }
        | undefined
      relink.run(before?.id ?? null, row.id)
      touched.add(row.conv)
    }
  })()

  // A leaf still out of reach would hide the conversation all over again.
  for (const conv of touched) {
    const messages = listMessages(conv)
    const byId = new Map(messages.map((m) => [m.id, m]))
    const leafId = (
      db.prepare('SELECT leaf_id AS leafId FROM conversations WHERE id = ?').get(conv) as
        | { leafId: string | null }
        | undefined
    )?.leafId

    let node = leafId ? byId.get(leafId) : undefined
    const seen = new Set<string>()
    while (node && !seen.has(node.id)) {
      seen.add(node.id)
      node = node.parentId ? byId.get(node.parentId) : undefined
    }
    if (!(seen.size > 0 && !node) && messages.length > 0) {
      db.prepare('UPDATE conversations SET leaf_id = ? WHERE id = ?').run(
        messages[messages.length - 1].id,
        conv
      )
    }
  }

  console.log(`Harbor: re-linked ${dangling.length} orphaned message(s).`)
}
