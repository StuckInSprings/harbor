import type { Message } from './types'

/**
 * What a reply's cache line says. A provider that caches reports how much
 * of the prompt came from its cache; when that drops, the reason is almost
 * always one of a few, and naming it is what lets the person avoid it next
 * time (or accept it: a trimmed context rebuilds once, on purpose).
 */
export interface CacheVerdict {
  /** Share of the prompt read from the cache, 0..1; null when nothing is known. */
  rate: number | null
  /** The cache was expected to hold and did not. */
  missed: boolean
  /** In plain words, or '' when there is nothing to say. */
  note: string
}

/** Below this share of the prompt from cache, a reply after a cached one is a miss. */
export const MISS_BELOW = 0.3
/** Prompts shorter than this are under most providers' cacheable minimum; a miss there is nothing. */
export const MIN_PROMPT = 1500
/** A cache left idle this long is gone on most providers. */
export const IDLE_MS = 5 * 60_000

export function cacheVerdict(cur: Message, prev: Message | null, between: Message[]): CacheVerdict {
  const prompt = cur.promptTokens ?? 0
  const cached = cur.cachedTokens ?? 0
  const written = cur.cacheWriteTokens ?? 0
  if (!prompt) return { rate: null, missed: false, note: '' }
  const rate = Math.min(1, cached / prompt)
  if (prompt < MIN_PROMPT) return { rate, missed: false, note: '' }
  const prevCached = prev?.cachedTokens ?? 0
  const prevWrote = prev?.cacheWriteTokens ?? 0
  if (rate >= MISS_BELOW) return { rate, missed: false, note: written ? `${written.toLocaleString()} tokens written to the cache for next time.` : '' }
  // A miss is only a miss when the cache had something to hold.
  if (!prev || (!prevCached && !prevWrote)) {
    return { rate, missed: false, note: written ? 'First cached turn: the prefix was written to the cache; later turns read it.' : '' }
  }
  const why = (): string => {
    if (prev.model && cur.model && prev.model !== cur.model) return 'another model answered, and a cache is per model'
    if (between.some((m) => m.summaryOf)) return 'the conversation was compacted; the prefix rebuilt once'
    if (between.some((m) => m.trimmed) || cur.trimmed) return 'the context was trimmed to make room; the prefix rebuilt once'
    if (prev.prefixHash && cur.prefixHash && prev.prefixHash !== cur.prefixHash) return 'the instructions or the tool set changed since the last turn'
    if (cur.createdAt - prev.createdAt > IDLE_MS) return 'the cache had gone idle and expired'
    return 'the provider served it uncached'
  }
  return { rate, missed: true, note: `Cache miss: ${why()}.` }
}

/** The cache line for a reply: "92% cached" and, when it matters, why not. */
export function cacheLine(v: CacheVerdict): string {
  if (v.rate === null) return ''
  return `${Math.round(v.rate * 100)}% cached`
}
