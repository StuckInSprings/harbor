/**
 * Provider routing.
 *
 * One OpenRouter model id can be served by several providers, and the request
 * gets a say in which. Two of those choices matter enough to expose:
 *
 * - data_collection: "deny" keeps the prompt off any provider that trains on
 *   what it receives. Harbor promises that what you write stays on this
 *   machine; without this the promise stops at the provider's door.
 * - A fallback list, so a 429 or 503 from one model retries on the next
 *   instead of ending the turn with an error.
 *
 * Stored as one JSON setting; every field is optional on the wire and only
 * sent when set, so the default request is exactly what it was before.
 */

export type Sort = '' | 'price' | 'throughput' | 'latency'

export interface Routing {
  /** Only providers that do not train on prompts. */
  denyDataCollection: boolean
  /** How OpenRouter orders the providers it could use; '' is its default. */
  sort: Sort
  /** Model ids to try, in order, when the chosen one fails. */
  fallbacks: string[]
  /**
   * Providers never to use. Harbor adds one itself when it drops a stream
   * mid-way — a provider that cut a reply short once is cheaper to avoid
   * than to hope on — and the person can clear or add entries in Settings.
   */
  ignore: string[]
}

export const DEFAULT_ROUTING: Routing = { denyDataCollection: false, sort: '', fallbacks: [], ignore: [] }

const SORTS: Sort[] = ['', 'price', 'throughput', 'latency']

/** Reads the stored setting; anything malformed falls back to the default field by field. */
export function parseRouting(raw: string | null | undefined): Routing {
  if (!raw) return { ...DEFAULT_ROUTING }
  let obj: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_ROUTING }
    obj = parsed as Record<string, unknown>
  } catch {
    return { ...DEFAULT_ROUTING }
  }
  const sort = SORTS.includes(obj.sort as Sort) ? (obj.sort as Sort) : ''
  const fallbacks = Array.isArray(obj.fallbacks)
    ? obj.fallbacks.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    : []
  const ignore = Array.isArray(obj.ignore)
    ? obj.ignore.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    : []
  return { denyDataCollection: obj.denyDataCollection === true, sort, fallbacks, ignore }
}

/** The routing with a provider added to the ignore list; unchanged when it is there already. */
export function withIgnored(r: Routing, provider: string): Routing {
  const name = provider.trim()
  if (!name || r.ignore.some((p) => p.toLowerCase() === name.toLowerCase())) return r
  return { ...r, ignore: [...r.ignore, name] }
}

export const serialiseRouting = (r: Routing): string => JSON.stringify(r)

/** One model id per line or comma; blanks and repeats dropped, order kept. */
export function parseFallbacks(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\n,]/)) {
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * The request fields. Nothing is sent for a default routing, and the chosen
 * model is never listed as its own fallback.
 */
export function routingFor(r: Routing, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const provider: Record<string, unknown> = {}
  if (r.denyDataCollection) provider.data_collection = 'deny'
  if (r.sort) provider.sort = r.sort
  if (r.ignore.length) provider.ignore = r.ignore
  if (Object.keys(provider).length) out.provider = provider

  const fallbacks = r.fallbacks.filter((f) => f && f !== model)
  // OpenRouter reads the first entry as the primary, so the model leads the list.
  if (fallbacks.length) out.models = [model, ...fallbacks]
  return out
}
