import { db } from './connection'
import { getSetting, setSetting } from './settings'

/**
 * Messages written before the index existed still need to be findable.
 *
 * Counting rows in messages_fts does not work as a guard: on an external
 * content table that reads straight through to `messages`, so it always looks
 * full while the index itself is empty. A stored marker is the honest check.
 */
const FTS_VERSION = '1'

export function backfillSearchIndex(): void {
  const built = getSetting('fts_built')
  if (built === FTS_VERSION) return
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
  setSetting('fts_built', FTS_VERSION)
}


/* --------------------------------------------------------- global search */
export interface SearchResult {
  kind: 'conversation' | 'message' | 'memory' | 'skill' | 'prompt'
  /** Conversation to open, when opening one makes sense. */
  conversationId: string | null
  title: string
  snippet: string
  projectId: string | null
}

const like = (q: string): string => `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`

/**
 * One box over everything Harbor holds. Messages go through FTS5; the other
 * kinds are small enough that a scan is simpler and fast enough.
 */
export function searchEverything(query: string, limit = 40): SearchResult[] {
  const q = query.trim()
  if (q.length < 2) return []
  const out: SearchResult[] = []

  const titles = db
    .prepare(
      `SELECT id, project_id AS projectId, title FROM conversations
       WHERE title LIKE ? ESCAPE '\\' AND scratch = 0 ORDER BY updated_at DESC LIMIT ?`
    )
    .all(like(q), limit) as { id: string; projectId: string; title: string }[]
  for (const t of titles) {
    out.push({
      kind: 'conversation',
      conversationId: t.id,
      title: t.title,
      snippet: '',
      projectId: t.projectId
    })
  }

  const terms = q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
  if (terms.length) {
    const match = terms.map((t) => `"${t}"*`).join(' AND ')
    try {
      const rows = db
        .prepare(
          `SELECT m.conversation_id AS conversationId, c.title AS title, c.project_id AS projectId,
                  snippet(messages_fts, 0, '', '', '…', 14) AS snippet
           FROM messages_fts f
           JOIN messages m ON m.rowid = f.rowid
           JOIN conversations c ON c.id = m.conversation_id
           WHERE messages_fts MATCH ? AND m.role IN ('user','assistant') AND c.scratch = 0
           ORDER BY bm25(messages_fts) LIMIT ?`
        )
        .all(match, limit) as {
        conversationId: string
        title: string
        projectId: string
        snippet: string
      }[]
      for (const r of rows) {
        out.push({
          kind: 'message',
          conversationId: r.conversationId,
          title: r.title,
          snippet: r.snippet,
          projectId: r.projectId
        })
      }
    } catch {
      /* a malformed FTS query should not break the other kinds */
    }
  }

  const mems = db
    .prepare(
      `SELECT id, project_id AS projectId, text, source_conv_id AS conversationId
       FROM memories WHERE text LIKE ? ESCAPE '\\' LIMIT ?`
    )
    .all(like(q), limit) as {
    id: string
    projectId: string
    text: string
    conversationId: string | null
  }[]
  for (const m of mems) {
    out.push({
      kind: 'memory',
      conversationId: m.conversationId,
      title: m.text,
      snippet: '',
      projectId: m.projectId
    })
  }

  const prompts = db
    .prepare(
      `SELECT id, project_id AS projectId, name, body FROM prompts
       WHERE name LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' LIMIT ?`
    )
    .all(like(q), like(q), limit) as {
    id: string
    projectId: string | null
    name: string
    body: string
  }[]
  for (const p of prompts) {
    out.push({
      kind: 'prompt',
      conversationId: null,
      title: p.name,
      snippet: p.body.slice(0, 120),
      projectId: p.projectId
    })
  }

  return out.slice(0, limit)
}
