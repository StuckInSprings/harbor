import type { Checkpoint, FileVersion } from '../../../shared/types'
import { db, id, now } from './connection'

/* ------------------------------------------------------------ checkpoints */
type CpRow = {
  id: string
  run_id: string
  conversation_id: string
  path: string
  before_hash: string | null
  after_hash: string | null
  created: number
  undone: number
  web_used: number
  created_at: number
}

const toCheckpoint = (r: CpRow): Checkpoint => ({
  id: r.id,
  runId: r.run_id,
  conversationId: r.conversation_id,
  path: r.path,
  beforeHash: r.before_hash,
  afterHash: r.after_hash,
  created: r.created === 1,
  undone: r.undone === 1,
  webUsed: r.web_used === 1,
  createdAt: r.created_at
})

export function addCheckpoint(c: {
  runId: string
  conversationId: string
  path: string
  beforeHash: string | null
  afterHash: string | null
  created: boolean
  webUsed?: boolean
}): string {
  const cpId = id()
  db.prepare(
    `INSERT INTO checkpoints
       (id, run_id, conversation_id, path, before_hash, after_hash, created, undone,
        web_used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    cpId,
    c.runId,
    c.conversationId,
    c.path,
    c.beforeHash,
    c.afterHash,
    c.created ? 1 : 0,
    c.webUsed ? 1 : 0,
    now()
  )
  return cpId
}

export function getCheckpoint(cpId: string): Checkpoint | null {
  const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(cpId) as CpRow | undefined
  return row ? toCheckpoint(row) : null
}

export function listCheckpoints(runId: string): Checkpoint[] {
  const rows = db
    .prepare('SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at')
    .all(runId) as CpRow[]
  return rows.map(toCheckpoint)
}

/** Everything written in a conversation, newest first, for the Changes pane. */
export function listConversationCheckpoints(conversationId: string): Checkpoint[] {
  const rows = db
    .prepare('SELECT * FROM checkpoints WHERE conversation_id = ? ORDER BY created_at DESC')
    .all(conversationId) as CpRow[]
  return rows.map(toCheckpoint)
}

/**
 * A file's history across the whole project, newest first. Checkpoints are
 * kept per conversation, but a draft is worked on across many, so the draft
 * view needs them all.
 */
export function listPathCheckpoints(projectId: string, path: string): FileVersion[] {
  const rows = db
    .prepare(
      `SELECT cp.id, cp.conversation_id, cp.after_hash, cp.created, cp.undone, cp.created_at,
              c.title
         FROM checkpoints cp JOIN conversations c ON c.id = cp.conversation_id
        WHERE c.project_id = ? AND cp.path = ?
        ORDER BY cp.created_at DESC, cp.rowid DESC`
    )
    .all(projectId, path) as {
    id: string
    conversation_id: string
    after_hash: string | null
    created: number
    undone: number
    created_at: number
    title: string
  }[]
  return rows.map((r) => ({
    checkpointId: r.id,
    conversationId: r.conversation_id,
    conversationTitle: r.title,
    hash: r.after_hash,
    created: r.created === 1,
    undone: r.undone === 1,
    createdAt: r.created_at
  }))
}

export function markUndone(cpId: string, undone: boolean): void {
  db.prepare('UPDATE checkpoints SET undone = ? WHERE id = ?').run(undone ? 1 : 0, cpId)
}

