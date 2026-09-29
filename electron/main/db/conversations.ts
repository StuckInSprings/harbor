import type { Conversation } from '../../../shared/types'
import type { ConversationRole } from '../../../shared/director'
import { isRole } from '../../../shared/director'
import { db, id, now } from './connection'
import { parseParams, safeParse } from './projects'

/* ----------------------------------------------------------- conversations */
type ConvRow = {
  id: string
  project_id: string
  title: string
  model: string | null
  pinned: number
  archived: number
  scratch: number
  role: string
  budget: number
  approved: number
  run_id: string | null
  write_globs: string
  run_branch: string | null
  run_base: string | null
  run_dir: string | null
  rehearsal: number
  goal: string | null
  goal_state: string | null
  goal_turns: number
  goal_budget: number
  goal_since: number | null
  goal_idle: number
  params: string
  leaf_id: string | null
  created_at: number
  updated_at: number
}

const toConversation = (r: ConvRow): Conversation => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  model: r.model,
  pinned: r.pinned === 1,
  archived: r.archived === 1,
  scratch: r.scratch === 1,
  role: isRole(r.role) ? r.role : 'chat',
  budget: r.budget ?? 0,
  approved: r.approved === 1,
  runId: r.run_id ?? null,
  writeGlobs: safeParse(r.write_globs ?? '[]'),
  runBranch: r.run_branch ?? null,
  runBase: r.run_base ?? null,
  runDir: r.run_dir ?? null,
  rehearsal: r.rehearsal === 1,
  goal: r.goal ?? null,
  goalState: r.goal_state ?? null,
  goalTurns: r.goal_turns ?? 0,
  goalBudget: r.goal_budget ?? 0,
  goalSince: r.goal_since ?? null,
  goalIdle: r.goal_idle ?? 0,
  params: parseParams(r.params),
  leafId: r.leaf_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function listConversations(): Conversation[] {
  const rows = db
    .prepare('SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC')
    .all() as ConvRow[]
  return rows.map(toConversation)
}

export function createConversation(
  projectId: string,
  model: string | null,
  scratch = false,
  role: ConversationRole = 'chat',
  extra: { budget?: number; runId?: string | null; title?: string; writeGlobs?: string[]; rehearsal?: boolean } = {}
): Conversation {
  const t = now()
  const c: ConvRow = {
    id: id(),
    project_id: projectId,
    title: extra.title ?? (scratch ? 'Quick question' : role === 'interview' ? 'Interview' : role === 'director' ? 'Director' : 'Untitled'),
    model,
    pinned: 0,
    archived: 0,
    scratch: scratch ? 1 : 0,
    role,
    budget: extra.budget ?? 0,
    approved: 0,
    run_id: extra.runId ?? null,
    write_globs: JSON.stringify(extra.writeGlobs ?? []),
    run_branch: null,
    run_base: null,
    run_dir: null,
    rehearsal: extra.rehearsal ? 1 : 0,
    goal: null,
    goal_state: null,
    goal_turns: 0,
    goal_budget: 0,
    goal_since: null,
    goal_idle: 0,
    params: '{}',
    leaf_id: null,
    created_at: t,
    updated_at: t
  }
  db.prepare(
    `INSERT INTO conversations
       (id, project_id, title, model, pinned, archived, scratch, role, budget, approved, run_id, write_globs, run_branch, run_base, run_dir, rehearsal, params, leaf_id, created_at,
        updated_at)
     VALUES (@id, @project_id, @title, @model, @pinned, @archived, @scratch, @role, @budget, @approved, @run_id, @write_globs, @run_branch, @run_base, @run_dir, @rehearsal, @params, @leaf_id,
             @created_at, @updated_at)`
  ).run(c)
  return toConversation(c)
}

export function renameConversation(conversationId: string, title: string): void {
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(
    title,
    now(),
    conversationId
  )
}

export function setConversationModel(conversationId: string, model: string): void {
  db.prepare('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?').run(
    model,
    now(),
    conversationId
  )
}

export function deleteConversation(conversationId: string): void {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
}

/** Where a run works: its branch, when one was made, and the commit it started from. */
/** The folder a run's files live in; set on the interview when it is made, and copied to the director it starts. */
export function setRunDir(conversationId: string, dir: string): void {
  db.prepare('UPDATE conversations SET run_dir = ? WHERE id = ?').run(dir, conversationId)
}

export function setRunGit(conversationId: string, branch: string | null, base: string | null): void {
  db.prepare('UPDATE conversations SET run_branch = ?, run_base = ? WHERE id = ?').run(branch, base, conversationId)
}

/** A new ceiling for a run; raising it is how a spent run continues. */
export function setBudget(conversationId: string, budget: number): void {
  db.prepare('UPDATE conversations SET budget = ?, updated_at = ? WHERE id = ?').run(Math.max(0, budget), now(), conversationId)
}

/** The person has read the director's plan. */
export function approveConversation(conversationId: string): void {
  db.prepare('UPDATE conversations SET approved = 1, updated_at = ? WHERE id = ?').run(now(), conversationId)
}

/** What a run has spent: the director's own turns and every worker's. */
export function runCost(directorId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(m.cost), 0) AS total FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.id = ? OR c.run_id = ?`
    )
    .get(directorId, directorId) as { total: number }
  return row.total
}

/** What one conversation has spent. */
export function conversationCost(conversationId: string): number {
  const row = db.prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM messages WHERE conversation_id = ?').get(conversationId) as { total: number }
  return row.total
}

/** A run's workers, oldest first. */
export function listWorkers(directorId: string): Conversation[] {
  const rows = db.prepare('SELECT * FROM conversations WHERE run_id = ? ORDER BY created_at').all(directorId) as ConvRow[]
  return rows.map(toConversation)
}

/** A throwaway the person decided to keep: it becomes an ordinary conversation. */
export function keepConversation(conversationId: string): void {
  db.prepare('UPDATE conversations SET scratch = 0, updated_at = ? WHERE id = ?').run(now(), conversationId)
}

/** Throwaways left behind by a quit or a crash; run at startup. Returns how many went. */
export function purgeScratch(): number {
  return db.prepare('DELETE FROM conversations WHERE scratch = 1').run().changes
}

export function togglePinned(conversationId: string): void {
  db.prepare('UPDATE conversations SET pinned = 1 - pinned WHERE id = ?').run(conversationId)
}

export function setConversationParams(conversationId: string, params: unknown): void {
  db.prepare('UPDATE conversations SET params = ? WHERE id = ?').run(
    JSON.stringify(params ?? {}),
    conversationId
  )
}

export function setArchived(conversationId: string, archived: boolean): void {
  db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(
    archived ? 1 : 0,
    conversationId
  )
}
export function getConversation(conversationId: string): Conversation | null {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
    | ConvRow
    | undefined
  return row ? toConversation(row) : null
}


/** Marks a conversation as active without adding to it, for a long tool call. */
export function touchConversation(conversationId: string): void {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), conversationId)
}


/** Sets a goal, or clears it with null; the turn count and the spend start from now. */
export function setGoal(conversationId: string, goal: string | null, budget = 0): void {
  db.prepare('UPDATE conversations SET goal = ?, goal_state = ?, goal_turns = 0, goal_budget = ?, goal_since = ?, goal_idle = 0, updated_at = ? WHERE id = ?').run(
    goal,
    goal ? 'pursuing' : null,
    Math.max(0, budget),
    goal ? now() : null,
    now(),
    conversationId
  )
}

export function setGoalState(conversationId: string, state: string, turns: number, idle: number): void {
  db.prepare('UPDATE conversations SET goal_state = ?, goal_turns = ?, goal_idle = ?, updated_at = ? WHERE id = ?').run(state, turns, idle, now(), conversationId)
}

/** What the conversation has cost since the goal was set. */
export function goalSpend(conversationId: string, since: number): number {
  const row = db.prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM messages WHERE conversation_id = ? AND created_at >= ?').get(conversationId, since) as { total: number }
  return row.total
}
