import type { Message } from '../../shared/types'
import * as db from './db'
import * as or from './openrouter'
import * as log from './log'
import { pathToLeaf } from './thread'
import { chooseCut, SUMMARY_RUBRIC, summaryMessage, transcriptOf } from '../../shared/compact'

/**
 * Compacting a conversation. See shared/compact.ts for what that means; this
 * is the part that talks to the database and the model.
 */

export interface Compacted {
  /** The new root: the summary. */
  summaryId: string
  /** The end of the new branch, where the conversation continues. */
  leafId: string
  summarised: number
  kept: number
}

/** Summarises a transcript. Injectable so the rest can be tested without a model. */
export type Summariser = (transcript: string) => Promise<string>

export const withModel =
  (model: string, signal?: AbortSignal): Summariser =>
  (transcript) =>
    or.complete(
      model,
      [
        { role: 'system', content: SUMMARY_RUBRIC },
        { role: 'user', content: transcript }
      ],
      { maxTokens: 1500, signal }
    )

export async function compact(
  conversationId: string,
  leafId: string,
  keepTokens: number,
  summarise: Summariser
): Promise<Compacted | null> {
  const all = db.listMessages(conversationId)
  const path = pathToLeaf(all, leafId)
  const cut = chooseCut(path, keepTokens)
  if (!cut) return null

  const started = Date.now()
  const summary = (await summarise(transcriptOf(cut.summarise))).trim()
  if (!summary) throw new Error('The summariser returned nothing, so the conversation was left as it was.')

  /*
    The new branch is built as a unit. A summary root with half its tail copied
    would be a conversation that starts mid-thought, which is worse than the
    one being fixed.
  */
  const built = db.transaction(() => {
    const root = db.addMessage(
      conversationId,
      null,
      'user',
      summaryMessage(cut.summarise.length, summary),
      null,
      { summaryOf: leafId }
    )
    let parent: Message = root
    for (const m of cut.keep) parent = db.copyMessage(m, parent.id)
    return { root, leaf: parent }
  })

  log.info('compact', 'done', {
    ms: log.since(started),
    summarised: cut.summarise.length,
    kept: cut.keep.length,
    chars: summary.length
  })
  return {
    summaryId: built.root.id,
    leafId: built.leaf.id,
    summarised: cut.summarise.length,
    kept: cut.keep.length
  }
}

/** A loaded skill body is carried whole up to this; the whole of them up to the total. */
export const CARRY_SKILL_CHARS = 20_000
export const CARRY_TOTAL_CHARS = 100_000

/** The skills load_skill was called for on a path, in the order they were loaded, each once. */
export function skillsLoadedOn(path: Message[]): string[] {
  const names: string[] = []
  for (const m of path) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    try {
      for (const c of JSON.parse(m.toolCalls) as { function?: { name?: string; arguments?: string } }[]) {
        if (c.function?.name !== 'load_skill') continue
        const name = String((JSON.parse(c.function.arguments || '{}') as { name?: unknown }).name ?? '').trim()
        if (name && !names.includes(name)) names.push(name)
      }
    } catch {
      /* a call that does not parse loaded nothing */
    }
  }
  return names
}

/**
 * After a compaction, the skills the summarised part had loaded are put
 * on the summary whole, or the model would carry on with a procedure it
 * can no longer read. Skills still loaded in the kept tail are not
 * repeated. The loader is injected so this can be tested without a store.
 */
export async function carrySkills(
  conversationId: string,
  before: Message[],
  summaryId: string,
  leafId: string,
  load: (name: string) => Promise<string | null>
): Promise<string[]> {
  const kept = pathToLeaf(db.listMessages(conversationId), leafId)
  const still = new Set(skillsLoadedOn(kept))
  const lost = skillsLoadedOn(before).filter((n) => !still.has(n))
  const carried: string[] = []
  let total = 0
  const parts: string[] = []
  for (const name of lost) {
    const body = await load(name)
    if (!body) continue
    const cut = body.length > CARRY_SKILL_CHARS ? `${body.slice(0, CARRY_SKILL_CHARS).trimEnd()}\n\n[cut here]` : body
    if (total + cut.length > CARRY_TOTAL_CHARS) break
    total += cut.length
    carried.push(name)
    parts.push(`### ${name}\n\n${cut}`)
  }
  if (parts.length) db.appendToMessage(summaryId, `\n\n## Skills in use\n\nThese were loaded before the summary above and still apply.\n\n${parts.join('\n\n')}`)
  return carried
}
