/**
 * Fan-out: one prompt to several models at once.
 *
 * The tree already allows it — every reply is a sibling under the same user
 * message — so the work here is choosing who to ask and laying the answers
 * out next to each other. For creative work with open-weight models, where
 * quality swings between models and between runs, this is how you actually
 * work: ask once, read three, keep the best.
 *
 * Who is asked is a list of variants: a model, and optionally samplers of
 * its own, so one model can be asked twice at two temperatures. A set worth
 * keeping is saved as the project's layout. The replies can be judged blind,
 * and the votes kept as a rating per project.
 */

import type { Message, ModelParams } from './types'

export const FAN_OUT_MAX = 6

/** One reply asked for: a model, and the samplers it is asked with, over the conversation's own. */
export interface FanVariant {
  model: string
  params?: Partial<ModelParams>
  /** How the reply is named; made from the samplers when not given. */
  label?: string
}

export const asVariant = (v: string | FanVariant): FanVariant =>
  typeof v === 'string' ? { model: v.trim() } : { ...v, model: v.model.trim() }

const SHORT: Record<string, string> = {
  temperature: 't',
  topP: 'top_p',
  topK: 'top_k',
  minP: 'min_p',
  topA: 'top_a',
  repetitionPenalty: 'rep',
  seed: 'seed',
  maxTokens: 'max',
  frequencyPenalty: 'freq',
  presencePenalty: 'pres',
  reasoningEffort: 'effort',
  reasoningMaxTokens: 'think'
}

/** The samplers a variant sets, as a short line: "t=1.2 min_p=0.05". Empty when it sets none. */
export function variantLabel(v: FanVariant): string {
  if (v.label) return v.label
  return Object.entries(v.params ?? {})
    .filter(([, x]) => x !== undefined && x !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, x]) => `${SHORT[k] ?? k}=${x}`)
    .join(' ')
}

/** Two variants are the same ask when they name the same model with the same samplers. */
export const variantKey = (v: FanVariant): string => {
  const label = variantLabel(v)
  return label ? `${v.model} ${label}` : v.model
}

/** Who to ask: the conversation's model first, then the rest, no repeats, capped. */
export function planFanOut(current: string, picked: (string | FanVariant)[], max = FAN_OUT_MAX): FanVariant[] {
  const out: FanVariant[] = []
  const seen = new Set<string>()
  for (const raw of [current, ...picked]) {
    const v = asVariant(raw)
    if (!v.model) continue
    const key = variantKey(v)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
    if (out.length >= max) break
  }
  return out
}

/** The replies under one user message, oldest first — the columns of a comparison. */
export function compareColumns(messages: Message[], parentId: string): Message[] {
  return messages
    .filter((m) => m.parentId === parentId && m.role === 'assistant')
    .sort((a, b) => a.createdAt - b.createdAt)
}

/* ------------------------------------------------------------- the layout */

export const layoutKey = (projectId: string | null): string => `fanout_layout:${projectId ?? 'general'}`

export function parseLayout(raw: string | null): FanVariant[] {
  try {
    const a: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(a) ? a.filter((v): v is FanVariant => !!v && typeof (v as FanVariant).model === 'string').map(asVariant) : []
  } catch {
    return []
  }
}

/* ----------------------------------------------------------- a blind vote */

const fnv = (seed: number, s: string): number => {
  let h = seed
  for (const ch of s) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

/**
 * The columns in an order that says nothing about who wrote them: the same
 * parent always gives the same order, so the columns do not jump about, and
 * it is not the order they were made in, which is the order they were asked.
 */
export function blindOrder<T extends { id: string }>(columns: T[], seed: string): T[] {
  const base = fnv(2166136261, seed)
  return columns
    .map((c) => ({ c, x: fnv(base, c.id) }))
    .sort((a, b) => a.x - b.x || a.c.id.localeCompare(b.c.id))
    .map((k) => k.c)
}

/** What a reply is rated as: its model, and the variant it was asked as. */
export const replyKey = (m: { model: string | null; label: string | null }): string =>
  `${m.model ?? 'unknown'}${m.label ? ` ${m.label}` : ''}`

export interface Rating {
  rating: number
  games: number
}
export type Ratings = Record<string, Rating>

export const ELO_START = 1000
export const ELO_K = 32

export const ratingsKey = (projectId: string | null): string => `elo:${projectId ?? 'general'}`

export function parseRatings(raw: string | null): Ratings {
  try {
    const o: unknown = JSON.parse(raw ?? '{}')
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: Ratings = {}
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const r = v as Partial<Rating>
      if (typeof r?.rating === 'number' && typeof r?.games === 'number') out[k] = { rating: r.rating, games: r.games }
    }
    return out
  } catch {
    return {}
  }
}

export const expected = (a: number, b: number): number => 1 / (1 + 10 ** ((b - a) / 400))

/**
 * One vote: the winner beat every other column. Elo, pairwise, so a win
 * over a strong reply moves the numbers more than a win over a weak one.
 * Unknown keys start at ELO_START.
 */
export function applyVote(table: Ratings, winner: string, losers: string[], k = ELO_K): Ratings {
  const next: Ratings = { ...table }
  const get = (key: string): Rating => next[key] ?? { rating: ELO_START, games: 0 }
  const others = [...new Set(losers)].filter((l) => l !== winner)
  const w0 = get(winner).rating
  let gain = 0
  for (const l of others) {
    const lr = get(l)
    const e = expected(w0, lr.rating)
    gain += k * (1 - e)
    next[l] = { rating: round1(lr.rating - k * (1 - e)), games: lr.games + 1 }
  }
  const w = get(winner)
  next[winner] = { rating: round1(w0 + gain), games: w.games + others.length }
  return next
}

const round1 = (n: number): number => Math.round(n * 10) / 10

export function leaderboard(table: Ratings): { key: string; rating: number; games: number }[] {
  return Object.entries(table)
    .map(([key, r]) => ({ key, ...r }))
    .sort((a, b) => b.rating - a.rating || a.key.localeCompare(b.key))
}

/* --------------------------------------------- a question about one reply */

/**
 * What the model is sent for a side question about a reply: the reply and
 * the question, nothing else. The answer is shown and not kept, so the
 * conversation's context stays as it was.
 */
export function asideMessages(reply: string, question: string): { role: string; content: string }[] {
  return [
    {
      role: 'system',
      content:
        'You are asked a side question about one reply from a conversation you cannot otherwise see. Answer the question about the reply, briefly and directly. Do not continue the reply or rewrite it unless asked to.'
    },
    { role: 'user', content: `The reply:\n\n${reply.trim()}\n\n---\n\nThe question: ${question.trim()}` }
  ]
}
