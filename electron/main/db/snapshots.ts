import type { TreeSnapshot } from '../../../shared/types'
import { db, id, now } from './connection'

/* ------------------------------------------------------------- snapshots */

type Row = { id: string; run_id: string; conversation_id: string; project_id: string; kind: string; sha: string; created_at: number }

const toSnapshot = (r: Row): TreeSnapshot => ({ id: r.id, runId: r.run_id, conversationId: r.conversation_id, projectId: r.project_id, kind: r.kind as TreeSnapshot['kind'], sha: r.sha, createdAt: r.created_at })

export function addSnapshot(s: { runId: string; conversationId: string; projectId: string; kind: TreeSnapshot['kind']; sha: string }): string {
  const sid = id()
  db.prepare('INSERT INTO snapshots (id, run_id, conversation_id, project_id, kind, sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sid, s.runId, s.conversationId, s.projectId, s.kind, s.sha, now())
  return sid
}

export function getSnapshot(sid: string): TreeSnapshot | null {
  const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(sid) as Row | undefined
  return row ? toSnapshot(row) : null
}

/** Every snapshot taken for a conversation, newest first. */
export function listSnapshots(conversationId: string): TreeSnapshot[] {
  return (db.prepare('SELECT * FROM snapshots WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC').all(conversationId) as Row[]).map(toSnapshot)
}
