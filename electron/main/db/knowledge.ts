import { db, id, now, hasVectorSearch } from './connection'

/* ------------------------------------------------------------- knowledge */
export interface KnowledgeSource {
  id: string
  projectId: string
  path: string
  chunks: number
  indexedAt: number | null
  createdAt: number
}

export function listSources(projectId: string): KnowledgeSource[] {
  return db
    .prepare(
      `SELECT s.id, s.project_id AS projectId, s.path,
              (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.source_id = s.id) AS chunks,
              s.indexed_at AS indexedAt, s.created_at AS createdAt
       FROM knowledge_sources s WHERE s.project_id = ? ORDER BY s.created_at`
    )
    .all(projectId) as KnowledgeSource[]
}

export function addSource(projectId: string, path: string): KnowledgeSource {
  const existing = db
    .prepare('SELECT id FROM knowledge_sources WHERE project_id = ? AND path = ?')
    .get(projectId, path) as { id: string } | undefined
  if (existing) return listSources(projectId).find((s) => s.id === existing.id)!

  const sid = id()
  db.prepare(
    'INSERT INTO knowledge_sources (id, project_id, path, created_at) VALUES (?, ?, ?, ?)'
  ).run(sid, projectId, path, now())
  return listSources(projectId).find((s) => s.id === sid)!
}

export function removeSource(sourceId: string): void {
  for (const row of db
    .prepare('SELECT id FROM knowledge_chunks WHERE source_id = ?')
    .all(sourceId) as { id: number }[]) {
    dropVector(row.id)
  }
  db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(sourceId)
  db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId)
}
export function touchSource(sourceId: string): void {
  db.prepare('UPDATE knowledge_sources SET indexed_at = ? WHERE id = ?').run(now(), sourceId)
}

export function fileAlreadyIndexed(sourceId: string, relPath: string, hash: string): boolean {
  const row = db
    .prepare(
      'SELECT 1 AS ok FROM knowledge_chunks WHERE source_id = ? AND rel_path = ? AND file_hash = ? LIMIT 1'
    )
    .get(sourceId, relPath, hash) as { ok: number } | undefined
  return !!row
}

function dropVector(chunkId: number): void {
  if (!hasVectorSearch()) return
  try {
    db.prepare('DELETE FROM knowledge_vec WHERE rowid = ?').run(BigInt(chunkId))
  } catch {
    /* the vector row may simply not exist */
  }
}

export function clearChunksForFile(sourceId: string, relPath: string): void {
  const rows = db
    .prepare('SELECT id FROM knowledge_chunks WHERE source_id = ? AND rel_path = ?')
    .all(sourceId, relPath) as { id: number }[]
  for (const r of rows) {
    dropVector(r.id)
    db.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(r.id)
  }
  db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ? AND rel_path = ?').run(
    sourceId,
    relPath
  )
}

export function pruneMissingFiles(sourceId: string, keep: string[]): void {
  const rows = db
    .prepare('SELECT DISTINCT rel_path FROM knowledge_chunks WHERE source_id = ?')
    .all(sourceId) as { rel_path: string }[]
  const wanted = new Set(keep)
  for (const r of rows) if (!wanted.has(r.rel_path)) clearChunksForFile(sourceId, r.rel_path)
}

export function addChunk(
  c: {
    sourceId: string
    projectId: string
    relPath: string
    heading: string
    content: string
    fileHash: string
  },
  vector: Buffer
): number {
  const info = db
    .prepare(
      `INSERT INTO knowledge_chunks
         (source_id, project_id, rel_path, heading, content, file_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(c.sourceId, c.projectId, c.relPath, c.heading, c.content, c.fileHash, now())

  const chunkId = Number(info.lastInsertRowid)
  db.prepare('INSERT INTO knowledge_fts (rowid, content, heading) VALUES (?, ?, ?)').run(
    chunkId,
    c.content,
    c.heading
  )
  if (hasVectorSearch()) {
    // sqlite-vec wants a BigInt rowid and the vector as raw bytes.
    db.prepare('INSERT INTO knowledge_vec (rowid, embedding) VALUES (?, ?)').run(
      BigInt(chunkId),
      vector
    )
  }
  return chunkId
}

export function getChunk(
  chunkId: number
): { relPath: string; heading: string; content: string } | null {
  const row = db
    .prepare(
      'SELECT rel_path AS relPath, heading, content FROM knowledge_chunks WHERE id = ?'
    )
    .get(chunkId) as { relPath: string; heading: string; content: string } | undefined
  return row ?? null
}

/*
  Terms so common that OR-ing them makes every chunk a match, which is how an
  off-topic question ends up "matching" a whole corpus.
*/
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no',
  'not', 'of', 'on', 'or', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'you', 'your', 'about', 'would', 'should', 'could', 'get', 'got', 'make', 'made',
  'use', 'used', 'using', 'via', 'over', 'under', 'out', 'up', 'down', 'just', 'more', 'most'
])

export function searchChunksLexical(
  projectId: string,
  query: string,
  limit: number
): { id: number }[] {
  // FTS5 treats punctuation as syntax, so the query is reduced to bare terms.
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  if (terms.length === 0) return []
  const match = terms.map((t) => `"${t}"`).join(' OR ')
  try {
    return db
      .prepare(
        `SELECT c.id AS id FROM knowledge_fts f
         JOIN knowledge_chunks c ON c.id = f.rowid
         WHERE knowledge_fts MATCH ? AND c.project_id = ?
         ORDER BY bm25(knowledge_fts) LIMIT ?`
      )
      .all(match, projectId, limit) as { id: number }[]
  } catch {
    return []
  }
}

export function searchChunksVector(
  projectId: string,
  vector: Buffer,
  limit: number
): { id: number; distance: number }[] {
  if (!hasVectorSearch()) return []
  try {
    const rows = db
      .prepare(
        `SELECT v.rowid AS id, v.distance AS distance
         FROM knowledge_vec v
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`
      )
      .all(vector, limit) as { id: bigint | number; distance: number }[]
    // vec0 has no project column, so ownership is checked after the fact.
    return rows
      .map((r) => ({ id: Number(r.id), distance: r.distance }))
      .filter((r) => {
        const own = db
          .prepare('SELECT 1 AS ok FROM knowledge_chunks WHERE id = ? AND project_id = ?')
          .get(r.id, projectId)
        return !!own
      })
  } catch {
    return []
  }
}
