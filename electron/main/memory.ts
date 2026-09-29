import * as db from './db'
import { complete } from './openrouter'

/**
 * Memory holds what was learned by working, not what was written down — see
 * docs/CONTEXT-MODEL.md. The taxonomy is the whole safety story here: because
 * extraction happens without being asked, the rubric has to be narrow, and
 * every memory keeps provenance so a bad one can be traced and revoked.
 */

const RUBRIC = `You are keeping a project notebook for an assistant.

Read the exchange and record only durable facts learned THROUGH THIS INTERACTION
that would change how you work on this project next time.

Record:
- preferences and decisions the person stated (origin "person")
- constraints, conventions and gotchas discovered by doing the work (origin "model")
- corrections the person made to your approach (origin "person")

Also say which of the facts already known no longer hold, because this exchange showed a change: quote each such fact exactly as listed, under "outdated". Only a fact this exchange contradicts; not one you merely did not see used.

Do NOT record:
- anything that merely restates a document or file; that is reference material, not memory
- step-by-step procedures; those belong in a skill, not a memory
- anything only true of this one conversation
- restatements of what you just did
- speculation, praise, or filler

Most exchanges yield nothing. Returning an empty list is the common, correct answer.

Reply with JSON only: {"memories": [{"text": "...", "origin": "person"}], "outdated": ["..."]}
Each text is one sentence, under 25 words, written as a standing fact. Both lists are usually empty.`

export interface Extracted {
  memories: { text: string; origin: 'person' | 'model' }[]
  outdated: string[]
}

/** The model's reply as facts: the new form with an origin per entry, or the older list of strings. */
export function parseExtraction(raw: string): Extracted {
  const json = raw.match(/\{[\s\S]*\}/)?.[0]
  const none: Extracted = { memories: [], outdated: [] }
  if (!json) return none
  try {
    const parsed = JSON.parse(json) as { memories?: unknown; outdated?: unknown }
    const memories: Extracted['memories'] = []
    for (const item of Array.isArray(parsed.memories) ? parsed.memories : []) {
      const text = typeof item === 'string' ? item : item && typeof item === 'object' ? String((item as { text?: unknown }).text ?? '') : ''
      const t = text.trim()
      if (t.length <= 8 || t.length >= 300) continue
      const origin = item && typeof item === 'object' && (item as { origin?: unknown }).origin === 'person' ? 'person' : 'model'
      memories.push({ text: t, origin })
      if (memories.length >= 4) break
    }
    const outdated = (Array.isArray(parsed.outdated) ? parsed.outdated : []).filter((o): o is string => typeof o === 'string').map((o) => o.trim()).filter(Boolean).slice(0, 4)
    return { memories, outdated }
  } catch {
    return none
  }
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()

/**
 * Runs after a turn settles. Best effort: a failure here must never disturb the
 * conversation, so everything is swallowed.
 */
/** Whether a new memory waits for the person before it is used; the person's own entries never wait. */
export const REVIEW_SETTING = 'memory_review'
export const reviewFirst = (): boolean => db.getSetting(REVIEW_SETTING) === '1'

export async function extract(opts: {
  projectId: string
  conversationId: string
  messageId: string
  exchange: { role: string; content: string }[]
  model: string
  /** The call to the model; replaceable so this can be tested without one. */
  ask?: typeof complete
}): Promise<number> {
  try {
    const ask = opts.ask ?? complete
    const existing = db.listMemories(opts.projectId).filter((m) => !m.invalidatedAt)
    const seen = new Set(existing.map((m) => normalise(m.text)))

    const transcript = opts.exchange
      .filter((m) => m.content.trim())
      .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 4000)}`)
      .join('\n\n')
    if (transcript.length < 40) return 0

    const known = existing
      .slice(0, 30)
      .map((m) => `- ${m.text}`)
      .join('\n')

    const reply = await ask(opts.model, [
      { role: 'system', content: RUBRIC },
      {
        role: 'user',
        content: known
          ? `Already known, do not repeat:\n${known}\n\nExchange:\n${transcript}`
          : `Exchange:\n${transcript}`
      }
    ])

    const found = parseExtraction(reply)
    // A fact this exchange contradicted is marked, never deleted; the newest text says why.
    for (const old of found.outdated) {
      const hit = existing.find((m) => normalise(m.text) === normalise(old))
      if (hit && hit.enabled) db.invalidateMemory(hit.id, `contradicted in a later conversation: ${found.memories[0]?.text ?? 'see the conversation'}`)
    }
    let added = 0
    const wait = reviewFirst()
    for (const { text, origin } of found.memories) {
      if (seen.has(normalise(text))) continue
      seen.add(normalise(text))
      db.addMemory({
        projectId: opts.projectId,
        text,
        sourceConvId: opts.conversationId,
        sourceMsgId: opts.messageId,
        extractedBy: opts.model,
        origin,
        reviewed: !wait
      })
      added++
    }
    return added
  } catch {
    return 0
  }
}

/**
 * The block injected into the system prompt, under a token ceiling. When the
 * budget is exceeded entries drop by lowest value: unpinned before pinned,
 * unused before used, stale before fresh.
 */
export function block(projectId: string, budgetChars: number): { text: string; ids: string[] } {
  const enabled = db.liveMemories(projectId)
  if (enabled.length === 0) return { text: '', ids: [] }

  const ranked = [...enabled].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const aUsed = a.lastUsedAt ?? 0
    const bUsed = b.lastUsedAt ?? 0
    if (aUsed !== bUsed) return bUsed - aUsed
    return b.createdAt - a.createdAt
  })

  const kept: typeof ranked = []
  let used = 0
  for (const m of ranked) {
    const cost = m.text.length + 3
    if (used + cost > budgetChars) break
    kept.push(m)
    used += cost
  }
  if (kept.length === 0) return { text: '', ids: [] }

  return {
    text: [
      'What you have learned working on this project before:',
      ...kept.map((m) => `- ${m.text}`)
    ].join('\n'),
    ids: kept.map((m) => m.id)
  }
}
