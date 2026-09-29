import { db, id, now } from './connection'
import type { Memory } from '../../../shared/types'

/* ---------------------------------------------------------------- memory */
export type { Memory }

type MemRow = Omit<Memory, 'enabled' | 'pinned' | 'reviewed'> & { enabled: number; pinned: number; reviewed: number }

const toMemory = (r: MemRow): Memory => ({
  ...r,
  enabled: r.enabled === 1,
  pinned: r.pinned === 1,
  reviewed: r.reviewed === 1,
  origin: r.origin === 'person' ? 'person' : 'model'
})

const MEM_COLS = `id, project_id AS projectId, text, source_conv_id AS sourceConvId,
  source_msg_id AS sourceMsgId, extracted_by AS extractedBy, enabled, pinned,
  last_used_at AS lastUsedAt, created_at AS createdAt, origin, reviewed,
  invalidated_at AS invalidatedAt, invalidated_by AS invalidatedBy`

/** Every memory of the project: the ones waiting for review first, then pinned, then newest. */
export function listMemories(projectId: string): Memory[] {
  return (
    db
      .prepare(`SELECT ${MEM_COLS} FROM memories WHERE project_id = ? ORDER BY reviewed ASC, pinned DESC, created_at DESC`)
      .all(projectId) as MemRow[]
  ).map(toMemory)
}

/** The memories that go into the prompt: on, reviewed, and not put out of date. */
export function liveMemories(projectId: string): Memory[] {
  return listMemories(projectId).filter((m) => m.enabled && m.reviewed && !m.invalidatedAt)
}

export function addMemory(m: {
  projectId: string
  text: string
  sourceConvId: string | null
  sourceMsgId: string | null
  extractedBy: string | null
  origin?: 'person' | 'model'
  /** False puts it in the review queue, off until kept. */
  reviewed?: boolean
}): Memory {
  const memId = id()
  const reviewed = m.reviewed !== false
  db.prepare(
    `INSERT INTO memories (id, project_id, text, source_conv_id, source_msg_id, extracted_by, created_at, origin, reviewed, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(memId, m.projectId, m.text, m.sourceConvId, m.sourceMsgId, m.extractedBy, now(), m.origin ?? 'model', reviewed ? 1 : 0, reviewed ? 1 : 0)
  return listMemories(m.projectId).find((x) => x.id === memId)!
}

export function setMemoryEnabled(memId: string, enabled: boolean): void {
  db.prepare('UPDATE memories SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, memId)
}

export function setMemoryPinned(memId: string, pinned: boolean): void {
  db.prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, memId)
}

/** The person's verdict on a new memory: kept, it goes into the prompt; dropped, it stays off and out of the queue. */
export function reviewMemory(memId: string, keep: boolean): void {
  db.prepare('UPDATE memories SET reviewed = 1, enabled = ? WHERE id = ?').run(keep ? 1 : 0, memId)
}

/**
 * A later fact contradicted this one. It is kept and marked, not deleted:
 * what was believed and when is part of the record, and the person can
 * read why a memory stopped applying.
 */
export function invalidateMemory(memId: string, by: string): void {
  db.prepare('UPDATE memories SET invalidated_at = ?, invalidated_by = ?, enabled = 0 WHERE id = ? AND invalidated_at IS NULL').run(now(), by, memId)
}

/** The person's own delete: gone for good. The model never calls this. */
export function removeMemory(memId: string): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(memId)
}

export function markMemoriesUsed(ids: string[]): void {
  if (ids.length === 0) return
  const stmt = db.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?')
  const t = now()
  for (const memId of ids) stmt.run(t, memId)
}
