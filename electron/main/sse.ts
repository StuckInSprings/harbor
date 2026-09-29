/**
 * The wire, read without the network: server-sent-event framing, and the
 * reduction of one streamed chunk into what a completion is building up.
 * Both are pure, so the shapes a provider can send are tested with scripted
 * chunks rather than found in the log.
 */

/**
 * Frames arrive split anywhere, including inside a JSON payload. Bytes are
 * pushed as they come; complete frames' data payloads come back. A frame
 * ends at a blank line, with either line ending. Comment lines (OpenRouter's
 * ": OPENROUTER PROCESSING" keepalive) are dropped. `data:` may or may not
 * be followed by a space, and a frame's several data lines join with a
 * newline, as the standard says.
 */
export class SseParser {
  private buffer = ''

  push(text: string): string[] {
    this.buffer += text
    const out: string[] = []
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buffer)
      if (!m) break
      const frame = this.buffer.slice(0, m.index)
      this.buffer = this.buffer.slice(m.index + m[0].length)
      const data = SseParser.dataOf(frame)
      if (data !== null) out.push(data)
    }
    return out
  }

  /** What is left when the stream ends without a final blank line. It used to be dropped, and with it the usage chunk. */
  flush(): string[] {
    const rest = this.buffer
    this.buffer = ''
    if (!rest.trim()) return []
    const data = SseParser.dataOf(rest)
    return data === null ? [] : [data]
  }

  private static dataOf(frame: string): string | null {
    const lines: string[] = []
    for (const raw of frame.split(/\r?\n/)) {
      if (!raw.startsWith('data:')) continue
      lines.push(raw.slice(5).replace(/^ /, ''))
    }
    return lines.length ? lines.join('\n') : null
  }
}

export interface Usage {
  promptTokens: number | null
  completionTokens: number | null
  cachedTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  cost: number | null
}

export interface ToolCallFragment {
  id: string
  name: string
  arguments: string
}

export interface StreamState {
  content: string
  reasoning: string
  reasoningDetails: unknown[]
  /** Tool calls as they arrive, by slot; arguments are partial JSON until the end. */
  toolCalls: Map<number, ToolCallFragment>
  /** The slot the last fragment landed in, for a fragment that names none. */
  cursor: number
  citations: Map<string, { url: string; title: string; excerpt: string }>
  usage: Usage
  finishReason: string | null
  /** The model that actually answered — a fallback, when the chosen one failed. */
  servedBy: string | null
}

export const newStreamState = (): StreamState => ({
  content: '',
  reasoning: '',
  reasoningDetails: [],
  toolCalls: new Map(),
  cursor: 0,
  citations: new Map(),
  usage: { promptTokens: null, completionTokens: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, cost: null },
  finishReason: null,
  servedBy: null
})

/**
 * Reasoning blocks as they stream: a block may arrive whole, or as pieces
 * that share an index. Pieces are joined on their text; the last piece's
 * id and signature win, since those arrive at the end.
 */
export function mergeReasoningDetails(acc: unknown[], incoming: unknown): unknown[] {
  if (!Array.isArray(incoming)) return acc
  const out = [...acc] as Record<string, unknown>[]
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    const at = typeof block.index === 'number' ? out.findIndex((b) => b.index === block.index) : -1
    if (at === -1) {
      out.push({ ...block })
      continue
    }
    const prev = out[at]
    const merged: Record<string, unknown> = { ...prev }
    for (const key of ['text', 'summary', 'data'] as const) {
      if (typeof block[key] === 'string') merged[key] = `${typeof prev[key] === 'string' ? prev[key] : ''}${block[key]}`
    }
    for (const key of ['id', 'signature', 'format', 'type'] as const) {
      if (block[key] !== undefined && block[key] !== null) merged[key] = block[key]
    }
    out[at] = merged
  }
  return out
}

/**
 * One parsed chunk folded into the state. Returns what arrived as text this
 * time, for the callbacks. An `error` field is not handled here: the caller
 * reads it out first, since what to do about it (block a provider, throw)
 * is the client's business.
 */
export function applyChunk(state: StreamState, chunk: any): { content: string; reasoning: string } {
  const arrived = { content: '', reasoning: '' }
  // Every chunk names the model that produced it. With fallbacks on,
  // that is the only way to know a different one answered.
  if (typeof chunk.model === 'string' && chunk.model) state.servedBy = chunk.model

  const choice = chunk.choices?.[0]
  const delta = choice?.delta
  if (choice?.finish_reason) state.finishReason = choice.finish_reason

  if (delta?.content) {
    state.content += delta.content
    arrived.content = delta.content
  }
  if (delta?.reasoning) {
    state.reasoning += delta.reasoning
    arrived.reasoning = delta.reasoning
  }
  if (delta?.reasoning_details) state.reasoningDetails = mergeReasoningDetails(state.reasoningDetails, delta.reasoning_details)

  collectCitations(state, delta?.annotations)
  collectCitations(state, choice?.message?.annotations)

  for (const tc of delta?.tool_calls ?? []) {
    /*
      Fragments are keyed by index. A provider that sends whole calls
      without one used to have every call land in slot 0, its arguments
      concatenated into one string that parsed as nothing; a fragment that
      names a new id without an index opens a new slot instead.
    */
    if (typeof tc.index === 'number') state.cursor = tc.index
    else if (tc.id && state.toolCalls.get(state.cursor)?.id && state.toolCalls.get(state.cursor)?.id !== tc.id) state.cursor = state.toolCalls.size
    const entry = state.toolCalls.get(state.cursor) ?? { id: '', name: '', arguments: '' }
    if (tc.id) entry.id = tc.id
    if (tc.function?.name) entry.name = tc.function.name
    if (tc.function?.arguments) entry.arguments += tc.function.arguments
    state.toolCalls.set(state.cursor, entry)
  }

  if (chunk.usage) {
    state.usage.promptTokens = chunk.usage.prompt_tokens ?? null
    state.usage.completionTokens = chunk.usage.completion_tokens ?? null
    state.usage.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? null
    state.usage.cacheWriteTokens = chunk.usage.prompt_tokens_details?.cache_write_tokens ?? null
    state.usage.reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? null
    state.usage.cost = chunk.usage.cost ?? null
  }
  return arrived
}

// Web results come back as url_citation annotations rather than tool calls,
// so they are collected separately and shown under the reply.
function collectCitations(state: StreamState, list: unknown): void {
  for (const a of (list ?? []) as any[]) {
    const c = a?.url_citation
    if (!c?.url) continue
    state.citations.set(c.url, { url: c.url, title: c.title ?? c.url, excerpt: (c.content ?? '').slice(0, 400) })
  }
}

/** The calls in slot order, only those that got a name. */
export const finishedToolCalls = (state: StreamState): ToolCallFragment[] =>
  [...state.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.name)
