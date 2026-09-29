import type { Message, Role } from '../../../shared/types'
import { db, id, now } from './connection'

/* --------------------------------------------------------------- messages */
type MsgRow = {
  id: string
  conversation_id: string
  parent_id: string | null
  role: Role
  content: string
  model: string | null
  reasoning: string | null
  reasoning_details: string | null
  error: string | null
  tool_calls: string | null
  tool_call_id: string | null
  trimmed: number
  summary_of: string | null
  citations: string | null
  attachments: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cached_tokens: number | null
  cache_write_tokens: number | null
  prefix_hash: string | null
  reasoning_tokens: number | null
  cost: number | null
  label: string | null
  created_at: number
}

const toMessage = (r: MsgRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  parentId: r.parent_id,
  role: r.role,
  content: r.content,
  model: r.model,
  reasoning: r.reasoning,
  reasoningDetails: r.reasoning_details ?? null,
  error: r.error,
  toolCalls: r.tool_calls,
  toolCallId: r.tool_call_id,
  trimmed: r.trimmed === 1,
  summaryOf: r.summary_of ?? null,
  citations: r.citations,
  attachments: r.attachments,
  promptTokens: r.prompt_tokens,
  completionTokens: r.completion_tokens,
  cachedTokens: r.cached_tokens,
  cacheWriteTokens: r.cache_write_tokens ?? null,
  prefixHash: r.prefix_hash ?? null,
  reasoningTokens: r.reasoning_tokens,
  cost: r.cost,
  label: r.label ?? null,
  createdAt: r.created_at
})

export function listMessages(conversationId: string): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at')
    .all(conversationId) as MsgRow[]
  return rows.map(toMessage)
}

export function addMessage(
  conversationId: string,
  parentId: string | null,
  role: Role,
  content: string,
  model: string | null,
  extra: {
    toolCalls?: string | null
    toolCallId?: string | null
    attachments?: string | null
    summaryOf?: string | null
    /** A tool that spent money — the oracle, a worker — records it on its result row. */
    cost?: number | null
    label?: string | null
  } = {}
): Message {
  const m: MsgRow = {
    id: id(),
    conversation_id: conversationId,
    parent_id: parentId,
    role,
    content,
    model,
    reasoning: null,
    reasoning_details: null,
    error: null,
    tool_calls: extra.toolCalls ?? null,
    tool_call_id: extra.toolCallId ?? null,
    trimmed: 0,
    summary_of: extra.summaryOf ?? null,
    citations: null,
    attachments: extra.attachments ?? null,
    prompt_tokens: null,
    completion_tokens: null,
    cached_tokens: null,
    cache_write_tokens: null,
    prefix_hash: null,
    reasoning_tokens: null,
    cost: extra.cost ?? null,
    label: extra.label ?? null,
    created_at: now()
  }
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, parent_id, role, content, model, reasoning, reasoning_details, error,
        tool_calls, tool_call_id, trimmed, summary_of, citations, attachments, prompt_tokens,
        completion_tokens, cached_tokens, cache_write_tokens, prefix_hash, reasoning_tokens, cost, label, created_at)
     VALUES
       (@id, @conversation_id, @parent_id, @role, @content, @model, @reasoning, @reasoning_details, @error,
        @tool_calls, @tool_call_id, @trimmed, @summary_of, @citations, @attachments, @prompt_tokens,
        @completion_tokens, @cached_tokens, @cache_write_tokens, @prefix_hash, @reasoning_tokens, @cost, @label, @created_at)`
  ).run(m)
  // Adding a message always moves the conversation onto that branch.
  db.prepare('UPDATE conversations SET leaf_id = ?, updated_at = ? WHERE id = ?').run(
    m.id,
    now(),
    conversationId
  )
  return toMessage(m)
}

/**
 * A copy of a message under a new parent, for compaction. What was said is
 * carried over; what it cost is not, since the copy cost nothing and the
 * spend sheet sums every row.
 */
export function copyMessage(m: Message, parentId: string | null): Message {
  const row: MsgRow = {
    id: id(),
    conversation_id: m.conversationId,
    parent_id: parentId,
    role: m.role,
    content: m.content,
    model: m.model,
    reasoning: m.reasoning,
    reasoning_details: m.reasoningDetails,
    error: m.error,
    tool_calls: m.toolCalls,
    tool_call_id: m.toolCallId,
    trimmed: m.trimmed ? 1 : 0,
    summary_of: null,
    citations: m.citations,
    attachments: m.attachments,
    prompt_tokens: null,
    completion_tokens: null,
    cached_tokens: null,
    cache_write_tokens: null,
    prefix_hash: m.prefixHash,
    reasoning_tokens: null,
    cost: null,
    label: m.label,
    created_at: now()
  }
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, parent_id, role, content, model, reasoning, reasoning_details, error,
        tool_calls, tool_call_id, trimmed, summary_of, citations, attachments, prompt_tokens,
        completion_tokens, cached_tokens, cache_write_tokens, prefix_hash, reasoning_tokens, cost, label, created_at)
     VALUES
       (@id, @conversation_id, @parent_id, @role, @content, @model, @reasoning, @reasoning_details, @error,
        @tool_calls, @tool_call_id, @trimmed, @summary_of, @citations, @attachments, @prompt_tokens,
        @completion_tokens, @cached_tokens, @cache_write_tokens, @prefix_hash, @reasoning_tokens, @cost, @label, @created_at)`
  ).run(row)
  db.prepare('UPDATE conversations SET leaf_id = ?, updated_at = ? WHERE id = ?').run(
    row.id,
    now(),
    m.conversationId
  )
  return toMessage(row)
}

/** Recreates the damage the old delete did, so the repair can be tested. */
export function rawDeleteForTest(messageId: string): void {
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
}

export function setLeaf(conversationId: string, messageId: string): void {
  db.prepare('UPDATE conversations SET leaf_id = ? WHERE id = ?').run(messageId, conversationId)
}
export function finalizeMessage(
  messageId: string,
  fields: {
    content: string
    reasoning?: string | null
    reasoningDetails?: string | null
    error?: string | null
    promptTokens?: number | null
    completionTokens?: number | null
    cachedTokens?: number | null
    cacheWriteTokens?: number | null
    prefixHash?: string | null
    reasoningTokens?: number | null
    cost?: number | null
    toolCalls?: string | null
    citations?: string | null
    /** Set when a fallback answered, so the row names the model that actually did. */
    model?: string
  }
): void {
  db.prepare(
    `UPDATE messages
       SET content = ?, reasoning = ?, reasoning_details = ?, error = ?, tool_calls = ?, citations = ?,
           prompt_tokens = ?, completion_tokens = ?, cached_tokens = ?, cache_write_tokens = ?, prefix_hash = ?, reasoning_tokens = ?,
           cost = ?, model = COALESCE(?, model)
     WHERE id = ?`
  ).run(
    fields.content,
    fields.reasoning ?? null,
    fields.reasoningDetails ?? null,
    fields.error ?? null,
    fields.toolCalls ?? null,
    fields.citations ?? null,
    fields.promptTokens ?? null,
    fields.completionTokens ?? null,
    fields.cachedTokens ?? null,
    fields.cacheWriteTokens ?? null,
    fields.prefixHash ?? null,
    fields.reasoningTokens ?? null,
    fields.cost ?? null,
    fields.model ?? null,
    messageId
  )
}

/**
 * Removes a message and closes the gap behind it.
 *
 * A conversation is a chain, so deleting a row without re-parenting its
 * children orphans everything below it: the walk from the leaf hits a missing
 * parent and stops, and the earlier half of the conversation silently vanishes.
 * The children are spliced onto the deleted message's parent instead.
 *
 * Tool results are the exception. They belong to the calls the deleted message
 * made, and a result with no matching call is not just meaningless — it is a
 * transcript the API will refuse. They go with it.
 */
export function deleteMessage(messageId: string): void {
  const target = db.prepare('SELECT id, parent_id, conversation_id FROM messages WHERE id = ?')
    .get(messageId) as { id: string; parent_id: string | null; conversation_id: string } | undefined
  if (!target) return

  const childrenOf = db.prepare('SELECT id, role FROM messages WHERE parent_id = ?')

  // Follow the chain down while it is still tool results of this message.
  const doomed: string[] = [messageId]
  let frontier = messageId
  for (;;) {
    const kids = childrenOf.all(frontier) as { id: string; role: string }[]
    const tool = kids.find((k) => k.role === 'tool')
    if (!tool) break
    doomed.push(tool.id)
    frontier = tool.id
  }

  const remove = db.transaction(() => {
    // Whatever hangs off the end of that run is re-attached above the gap.
    db.prepare('UPDATE messages SET parent_id = ? WHERE parent_id = ?').run(
      target.parent_id,
      frontier
    )
    db.prepare(
      `UPDATE conversations SET leaf_id = ?
       WHERE id = ? AND leaf_id IN (${doomed.map(() => '?').join(',')})`
    ).run(target.parent_id, target.conversation_id, ...doomed)

    const del = db.prepare('DELETE FROM messages WHERE id = ?')
    for (const id of doomed) del.run(id)
  })
  remove()
}

/** Marks rows as cleared from the context. Never unmarked, so what the model is sent changes once. */
export function markTrimmed(ids: string[]): void {
  if (!ids.length) return
  const mark = db.prepare('UPDATE messages SET trimmed = 1 WHERE id = ?')
  db.transaction(() => {
    for (const id of ids) mark.run(id)
  })()
}

/** Adds to a message's text; for carrying loaded skills onto a summary. */
export function appendToMessage(messageId: string, text: string): void {
  db.prepare("UPDATE messages SET content = content || ? WHERE id = ?").run(text, messageId)
}
