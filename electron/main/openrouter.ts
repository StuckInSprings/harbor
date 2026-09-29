import type { ModelInfo, ModelParams, ReasoningEffort } from '../../shared/types'
import { readKey } from './keychain'
import * as db from './db'
import * as log from './log'
import { describeError, errorDetail } from '../../shared/errors'
import { FIRST_BYTE_MS, IDLE_MS, type ReportedPhase } from '../../shared/activity'
import { routingFor } from '../../shared/routing'
import * as routing from './routing'
import { EFFORT_ORDER } from '../../shared/params'
import { AUTOMATIC_CACHE, EXPLICIT_CACHE } from '../../shared/models'
import { SseParser, applyChunk, finishedToolCalls, newStreamState, type Usage } from './sse'
import type { Provider, StreamRequest } from './provider'

export { mergeReasoningDetails } from './sse'

const BASE = 'https://openrouter.ai/api/v1'

function headers(): Record<string, string> {
  const key = readKey()
  if (!key) throw new Error('No OpenRouter key set. Add one in Settings.')
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-Title': 'Harbor'
  }
}

/* ---------------------------------------------------------- local endpoint */

/*
  A second place to send a request: any server that speaks the OpenAI
  chat-completions dialect on the person's own machine or network — Ollama,
  LM Studio, llama.cpp's server. Its models appear in the catalogue with a
  `local/` prefix at no price; a request to one goes to it with only the
  fields that dialect has, none of OpenRouter's. The window is whatever the
  person says it is, since these servers rarely say.
*/
export const LOCAL_PREFIX = 'local/'
export const LOCAL_URL_SETTING = 'local_base_url'
export const LOCAL_KEY_SETTING = 'local_api_key'
export const LOCAL_CONTEXT_SETTING = 'local_context_length'
export const LOCAL_CONTEXT_DEFAULT = 32_768

export const isLocalModel = (model: string): boolean => model.startsWith(LOCAL_PREFIX)

export function localBase(): string | null {
  const raw = (db.getSetting(LOCAL_URL_SETTING) ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\//.test(raw) ? raw : null
}

export function localContextLength(): number {
  const n = Number(db.getSetting(LOCAL_CONTEXT_SETTING) ?? '')
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : LOCAL_CONTEXT_DEFAULT
}

interface Endpoint {
  base: string
  headers: Record<string, string>
  /** The model id as that server knows it. */
  model: string
  openrouter: boolean
  name: string
}

/** Where a request for this model goes, and as what. */
export function endpointFor(model: string): Endpoint {
  if (!isLocalModel(model)) return { base: BASE, headers: headers(), model, openrouter: true, name: 'OpenRouter' }
  const base = localBase()
  if (!base) throw new Error('No local endpoint is set. Add its URL in Settings to use a local model.')
  const key = (db.getSetting(LOCAL_KEY_SETTING) ?? '').trim()
  return {
    base,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    model: model.slice(LOCAL_PREFIX.length),
    openrouter: false,
    name: 'the local endpoint'
  }
}

/** What a local server offers, as catalogue entries; nothing when none is set or it does not answer. */
export async function fetchLocalModels(): Promise<ModelInfo[]> {
  const base = localBase()
  if (!base) return []
  try {
    const key = (db.getSetting(LOCAL_KEY_SETTING) ?? '').trim()
    const res = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8_000) })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const body = (await res.json()) as { data?: { id?: string }[] }
    const window = localContextLength()
    return (body.data ?? [])
      .filter((m) => typeof m.id === 'string' && m.id)
      .map((m) => ({
        id: `${LOCAL_PREFIX}${m.id}`,
        name: `${m.id} (local)`,
        contextLength: window,
        maxCompletionTokens: null,
        promptPrice: 0,
        completionPrice: 0,
        cacheReadPrice: null,
        cacheWritePrice: null,
        tiers: [],
        inputModalities: ['text'],
        caching: 'none' as const,
        supportsTools: true,
        supportsReasoning: false,
        reasoning: { mandatory: false, defaultEnabled: false, efforts: [], defaultEffort: null },
        supportedParameters: ['temperature', 'top_p', 'max_tokens', 'seed', 'tools', 'stop', 'frequency_penalty', 'presence_penalty'],
        description: `Served by ${base}.`
      }))
  } catch (e) {
    log.warn('request', 'local endpoint did not list its models', { base, error: (e as Error).message })
    return []
  }
}

/* ----------------------------------------------------------------- models */

interface RawPricing {
  prompt?: string
  completion?: string
  input_cache_read?: string
  input_cache_write?: string
  overrides?: {
    min_prompt_tokens?: number
    prompt?: string
    completion?: string
  }[]
}

interface RawModel {
  id: string
  name?: string
  description?: string
  context_length?: number
  architecture?: { input_modalities?: string[]; modality?: string }
  top_provider?: { context_length?: number; max_completion_tokens?: number | null }
  pricing?: RawPricing
  supported_parameters?: string[]
  reasoning?: { mandatory?: boolean; default_enabled?: boolean; supported_efforts?: string[]; default_effort?: string }
}


function cachingMode(id: string, pricing: RawPricing | undefined): ModelInfo['caching'] {
  if (!pricing?.input_cache_read) return 'none'
  if (AUTOMATIC_CACHE.some((p) => id.startsWith(p))) return 'automatic'
  if (EXPLICIT_CACHE.some((p) => id.startsWith(p))) return 'explicit'
  return 'automatic'
}

const isEffort = (v: unknown): v is ReasoningEffort => typeof v === 'string' && (EFFORT_ORDER as readonly string[]).includes(v)
/** The efforts a model lists, in the documented order from most to least, unknown values dropped. */
const orderedEfforts = (raw: string[]): ReasoningEffort[] => EFFORT_ORDER.filter((e) => raw.includes(e))

/** OpenRouter quotes prices per token; Harbor shows them per million. */
const perMillion = (v: string | undefined): number => {
  const n = Number.parseFloat(v ?? '0')
  return Number.isFinite(n) ? n * 1_000_000 : 0
}

/*
  The catalogue as last fetched, so main can answer a question about a
  model without a round trip: a worker's window, say, which used to be
  passed as 0 and so a worker never compacted.
*/
const catalogue = new Map<string, ModelInfo>()

export async function contextLengthOf(modelId: string): Promise<number> {
  if (isLocalModel(modelId)) return localContextLength()
  if (catalogue.size === 0) await fetchModels().catch(() => [])
  return catalogue.get(modelId)?.contextLength ?? 0
}

/** A model's listing as last fetched, or null when the catalogue has no such model. */
export async function modelOf(modelId: string): Promise<ModelInfo | null> {
  if (catalogue.size === 0) await fetchModels().catch(() => [])
  return catalogue.get(modelId) ?? null
}

/** OpenRouter's catalogue when there is a key, the local endpoint's when there is one; both when both. */
export async function fetchModels(): Promise<ModelInfo[]> {
  const local = await fetchLocalModels()
  if (!readKey()) {
    if (!localBase()) throw new Error('No OpenRouter key set. Add one in Settings.')
    catalogue.clear()
    for (const m of local) catalogue.set(m.id, m)
    return local
  }
  const remote = await fetchOpenRouterModels()
  const models = [...remote, ...local]
  catalogue.clear()
  for (const m of models) catalogue.set(m.id, m)
  return models
}

async function fetchOpenRouterModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${BASE}/models`, { headers: headers() })
  if (!res.ok) throw new Error(`Could not load models (${res.status} ${res.statusText})`)
  const body = (await res.json()) as { data: RawModel[] }
  const models = body.data
    .map((m) => {
      const params = m.supported_parameters ?? []
      return {
        id: m.id,
        name: m.name ?? m.id,
        contextLength: m.top_provider?.context_length ?? m.context_length ?? 0,
        maxCompletionTokens: m.top_provider?.max_completion_tokens ?? null,
        promptPrice: perMillion(m.pricing?.prompt),
        completionPrice: perMillion(m.pricing?.completion),
        cacheReadPrice: m.pricing?.input_cache_read
          ? perMillion(m.pricing.input_cache_read)
          : null,
        cacheWritePrice: m.pricing?.input_cache_write
          ? perMillion(m.pricing.input_cache_write)
          : null,
        tiers: (m.pricing?.overrides ?? [])
          .filter((o) => typeof o.min_prompt_tokens === 'number')
          .map((o) => ({
            minPromptTokens: o.min_prompt_tokens as number,
            promptPrice: perMillion(o.prompt),
            completionPrice: perMillion(o.completion)
          })),
        inputModalities: m.architecture?.input_modalities ?? ['text'],
        caching: cachingMode(m.id, m.pricing),
        supportsTools: params.includes('tools'),
        supportsReasoning: params.includes('reasoning') || params.includes('include_reasoning'),
        reasoning: {
          mandatory: m.reasoning?.mandatory === true,
          defaultEnabled: m.reasoning?.default_enabled === true || m.reasoning?.mandatory === true,
          efforts: orderedEfforts(m.reasoning?.supported_efforts ?? []),
          defaultEffort: isEffort(m.reasoning?.default_effort) ? m.reasoning.default_effort : null
        },
        supportedParameters: params,
        description: m.description ?? ''
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return models
}

export async function fetchKeyInfo(): Promise<{ label: string; usage: number; limit: number | null }> {
  const res = await fetch(`${BASE}/key`, { headers: headers() })
  if (!res.ok) throw new Error(`Key rejected (${res.status})`)
  const body = (await res.json()) as {
    data: { label?: string; usage?: number; limit?: number | null }
  }
  return {
    label: body.data.label ?? 'OpenRouter key',
    usage: body.data.usage ?? 0,
    limit: body.data.limit ?? null
  }
}

/* --------------------------------------------------------------- streaming */

export interface CompletionResult {
  content: string
  /** The model's reasoning trace, when it emitted one. */
  reasoning: string
  /**
   * The provider's own reasoning blocks (reasoning.text, .summary,
   * .encrypted), in order, to be sent back unmodified with the assistant
   * message on the next step of a tool loop.
   */
  reasoningDetails: unknown[]
  toolCalls: { id: string; name: string; arguments: string }[]
  citations: { url: string; title: string; excerpt: string }[]
  usage: Usage
  finishReason: string | null
  /** The model that actually answered — a fallback, when the chosen one failed. */
  servedBy: string | null
}

/**
 * Only keys that were actually set are included. An explicit undefined would
 * serialise away anyway, but building the object this way keeps the request
 * body honest about what was asked for.
 */
export function samplingFor(p: ModelParams = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (p.temperature !== undefined) out.temperature = p.temperature
  if (p.topP !== undefined) out.top_p = p.topP
  if (p.topK !== undefined) out.top_k = p.topK
  if (p.minP !== undefined) out.min_p = p.minP
  if (p.topA !== undefined) out.top_a = p.topA
  if (p.repetitionPenalty !== undefined) out.repetition_penalty = p.repetitionPenalty
  if (p.maxTokens !== undefined) out.max_tokens = p.maxTokens
  if (p.seed !== undefined) out.seed = p.seed
  if (p.frequencyPenalty !== undefined) out.frequency_penalty = p.frequencyPenalty
  if (p.presencePenalty !== undefined) out.presence_penalty = p.presencePenalty
  return out
}

export function reasoningFor(on: boolean | undefined, p: ModelParams = {}): Record<string, unknown> {
  if (!on) return {}
  const reasoning: Record<string, unknown> = { enabled: true }
  // effort and max_tokens are alternatives; max_tokens wins when both are set.
  if (p.reasoningMaxTokens !== undefined) reasoning.max_tokens = p.reasoningMaxTokens
  else if (p.reasoningEffort) reasoning.effort = p.reasoningEffort
  return { reasoning }
}

/*
  A stalled provider is indistinguishable from a slow one until you decide how
  long is too long. Nothing here timed out, so a stall showed as a spinner that
  never resolved. Streaming sends keepalive comments while a model thinks, so a
  real gap in the bytes means the connection is dead rather than busy.
*/
/*
  A real provider was measured taking 45 seconds to send its first byte, so 90
  was uncomfortably close to normal. Once bytes are flowing, a long gap is a
  better signal, since streaming sends keepalives while a model thinks.
*/

const inFlight = new Map<string, AbortController>()

/*
  A stopped request stays in the map, aborted, until the turn ends. It used
  to be deleted on the spot, so a Stop pressed while a tool ran or an
  approval card was up was forgotten by the time the loop asked: isCancelled
  read "no request, so no" and the loop sent the next model call.
*/
export function cancel(requestId: string): void {
  inFlight.get(requestId)?.abort()
}

export function isCancelled(requestId: string): boolean {
  return inFlight.get(requestId)?.signal.aborted ?? false
}

/** The turn's own signal, for anything that waits on its behalf. */
export function signalFor(requestId: string): AbortSignal | undefined {
  return inFlight.get(requestId)?.signal
}

export class Cancelled extends Error {}


/** The default patience for a call that has no stream to watch. */
export const QUIET_CALL_MS = 120_000

/**
 * A signal that fires when the caller's does or when the time is up,
 * whichever is first. Both reasons look like an AbortError to fetch, so the
 * caller's signal is what tells a Stop from a timeout afterwards.
 */
function bounded(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

function quietFailure(err: unknown, signal: AbortSignal | undefined, model: string, ms: number): Error {
  const e = err as Error
  if (e.name !== 'AbortError' && e.name !== 'TimeoutError') return e
  if (signal?.aborted) return new Cancelled('Stopped.')
  return new Error(`${model} did not answer within ${Math.round(ms / 1000)} seconds.`)
}

/**
 * One completion. Streams text out through the callbacks and returns whatever
 * the model finished with, including any tool calls it wants run. The agent
 * loop in run.ts calls this repeatedly.
 */
export async function streamCompletion(
  requestId: string,
  body: StreamRequest,
  onDelta: (text: string) => void,
  onReasoning: (text: string) => void,
  onPhase: (phase: ReportedPhase) => void = () => {}
): Promise<CompletionResult> {
  const controller = inFlight.get(requestId) ?? new AbortController()
  inFlight.set(requestId, controller)
  if (controller.signal.aborted) throw new Cancelled('Stopped.')

  /*
    One watchdog for the whole exchange, pushed forward on every chunk. When it
    fires it aborts the same controller the stop button uses, so `stalled` is
    what tells the two apart afterwards.
  */
  let stalled: string | null = null
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const expect = (ms: number, why: string): void => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      stalled = why
      log.error('request', 'watchdog fired', { after: ms, why })
      controller.abort()
    }, ms)
  }
  expect(
    FIRST_BYTE_MS,
    `${body.model} did not start replying within ${Math.round(FIRST_BYTE_MS / 1000)} seconds.`
  )

  const sentAt = Date.now()
  onPhase('sending')
  log.info('request', 'sending', {
    model: body.model,
    messages: body.messages.length,
    tools: body.tools?.length ?? 0
  })

  /*
    The request has to be inside the guarded region too. A fetch that rejects
    before the read loop used to skip the cleanup entirely, leaving the
    watchdog armed — it then fired ninety seconds later against a request that
    had already failed, aborting a controller nobody was waiting on and
    reporting a stall that never happened.
  */
  let res: Response
  const ep = endpointFor(body.model)
  // A local server has the dialect's fields and none of OpenRouter's: no plugins, no provider routing, no server tools.
  const tools = ep.openrouter ? body.tools : body.tools?.filter((t) => (t as { type?: string }).type === 'function')
  try {
    res = await fetch(`${ep.base}/chat/completions`, {
      method: 'POST',
      headers: { ...ep.headers, ...(ep.openrouter && body.sessionId ? { 'x-session-id': body.sessionId } : {}) },
      signal: controller.signal,
      body: JSON.stringify({
        model: ep.model,
        messages: body.messages,
        stream: true,
        ...samplingFor(body.params),
        ...(tools && tools.length ? { tools } : {}),
        ...(ep.openrouter
          ? {
              ...(body.plugins && body.plugins.length ? { plugins: body.plugins } : {}),
              // Only sent to models that advertise it; OpenRouter would drop it
              // silently otherwise, which hides the mistake rather than surfacing it.
              ...reasoningFor(body.reasoning, body.params),
              // Provider preferences and fallbacks; empty unless set in Settings.
              ...(body.routing ? routingFor(body.routing, body.model) : {})
              // Usage accounting is automatic; the old `usage: { include: true }` is
              // deprecated and has no effect.
            }
          : // The dialect sends usage on the last chunk only when asked.
            { stream_options: { include_usage: true } })
      })
    })
  } catch (err) {
    clearTimeout(watchdog)
    const e = err as Error
    if (e.name === 'AbortError' && !stalled) throw new Cancelled('Stopped.')
    const why = stalled ?? e.message
    log.error('request', 'never reached the model', { ms: log.since(sentAt), error: why })
    throw new Error(stalled ?? `Could not reach ${ep.name}: ${e.message}`)
  }

  if (!res.ok || !res.body) {
    clearTimeout(watchdog)
    const detail = await res.text().catch(() => '')
    const message = describeError(res.status, detail)
    // The provider's own account of what went wrong, kept in full in the log
    // even though the sentence shown is trimmed.
    log.error('request', 'refused', {
      ms: log.since(sentAt),
      ...errorDetail(res.status, detail),
      raw: detail.slice(0, 600)
    })
    throw new Error(message)
  }

  log.info('request', 'responded', { status: res.status, ms: log.since(sentAt) })
  /*
    The provider has answered, but a model that reasons can take another
    minute before it says anything. That gap is the longest silence in a turn,
    so it is worth naming as its own phase rather than lumping it with sending.
  */
  onPhase('waiting')

  let firstByte = false
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const state = newStreamState()

  const take = (payload: string): void => {
    if (payload === '[DONE]') return
    let chunk: any
    try {
      chunk = JSON.parse(payload)
    } catch {
      return
    }
    /*
      A mid-stream failure still carries HTTP 200 and arrives here with
      finish_reason "error", so it has to be read out of the body rather
      than the status.
    */
    if (chunk.error) {
      const detail = errorDetail(chunk.error.code, chunk)
      log.error('request', 'failed mid-stream', { ms: log.since(sentAt), ...detail })
      // A provider that dropped a reply is kept off the next request; the person can clear it in Settings.
      if (typeof detail.provider === 'string' && detail.provider && routing.block(detail.provider)) {
        log.warn('routing', 'provider blocked after a mid-stream failure', { provider: detail.provider })
      }
      throw new Error(describeError(chunk.error.code, chunk))
    }
    const arrived = applyChunk(state, chunk)
    if (arrived.content) onDelta(arrived.content)
    if (arrived.reasoning) onReasoning(arrived.reasoning)
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!firstByte) {
        firstByte = true
        log.info('request', 'first bytes', { ms: log.since(sentAt) })
      }
      expect(IDLE_MS, `${body.model} stopped sending after starting to reply.`)
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) take(payload)
    }
    // A last frame with no blank line after it is still a frame; it is where the usage chunk tends to be.
    for (const payload of parser.push(decoder.decode())) take(payload)
    for (const payload of parser.flush()) take(payload)
  } catch (err) {
    // An abort is either the stop button or the watchdog; only one is a failure.
    if ((err as Error).name === 'AbortError') {
      if (stalled) throw new Error(stalled)
      throw new Cancelled('Stopped.')
    }
    throw err
  } finally {
    clearTimeout(watchdog)
  }

  return {
    content: state.content,
    reasoning: state.reasoning,
    reasoningDetails: state.reasoningDetails,
    toolCalls: finishedToolCalls(state),
    citations: [...state.citations.values()],
    usage: state.usage,
    finishReason: state.finishReason,
    servedBy: state.servedBy
  }
}

/**
 * A single non-streaming completion, for Harbor's own housekeeping calls such
 * as memory extraction. Separate from the turn loop on purpose: it must never
 * touch the conversation. Routing applies here too: a privacy preference that
 * skipped the housekeeping calls would not be one.
 */
export async function complete(
  model: string,
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string> {
  // No stream means no watchdog, so a hung provider here used to hang the
  // turn in "assembling" for good. Bounded now, and stoppable.
  const ms = opts.timeoutMs ?? QUIET_CALL_MS
  const ep = endpointFor(model)
  const init = {
    method: 'POST',
    headers: ep.headers,
    signal: bounded(opts.signal, ms),
    body: JSON.stringify({
      model: ep.model,
      messages,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 400,
      ...(ep.openrouter ? routingFor(routing.current(), model) : {})
    })
  }
  let res: Response
  let text: string
  try {
    res = await fetch(`${ep.base}/chat/completions`, init)
    text = await res.text()
  } catch (err) {
    throw quietFailure(err, opts.signal, model, ms)
  }
  if (!res.ok) throw new Error(describeError(res.status, text))
  let body: { choices?: { message?: { content?: string } }[] }
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${model} returned something that was not JSON.`)
  }
  return body.choices?.[0]?.message?.content ?? ''
}

/**
 * One plain reply with its cost, for side calls outside the turn's stream:
 * the oracle, a quick aside. Unlike complete() the temperature is the
 * model's own, and the cost comes back so it can be charged to the turn.
 */
export async function chatOnce(
  model: string,
  messages: { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[],
  opts: {
    maxTokens: number
    seed?: number
    temperature?: number
    topP?: number
    topK?: number
    /** A full sampler set, sent as it is named on the wire; the single fields above win where both are given. */
    params?: ModelParams
    /** Tools the messages refer to, declared so a provider that checks finds them; the model is not asked to call any. */
    tools?: unknown[]
    signal?: AbortSignal
    timeoutMs?: number
  }
): Promise<{ content: string; cost: number; promptTokens: number; completionTokens: number }> {
  const ms = opts.timeoutMs ?? QUIET_CALL_MS
  const ep = endpointFor(model)
  const init = {
    method: 'POST',
    headers: ep.headers,
    signal: bounded(opts.signal, ms),
    body: JSON.stringify({
      model: ep.model,
      messages,
      max_tokens: opts.maxTokens,
      ...samplingFor(opts.params ?? {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
      ...(opts.topK !== undefined ? { top_k: opts.topK } : {}),
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'none' } : {}),
      /*
        A model that thinks by default spends the reply budget on thinking
        and hands back nothing — an oracle that said nothing, a judge with
        no verdict, at full price. These calls want the words, not the
        working; models that cannot reason ignore the field.
      */
      ...(ep.openrouter ? { reasoning: { enabled: false }, usage: { include: true }, ...routingFor(routing.current(), model) } : {})
    })
  }
  let res: Response
  let raw: string
  try {
    res = await fetch(`${ep.base}/chat/completions`, init)
    raw = await res.text()
  } catch (err) {
    throw quietFailure(err, opts.signal, model, ms)
  }
  if (!res.ok) throw new Error(describeError(res.status, raw))
  let body: {
    error?: unknown
    choices?: { message?: { content?: string } }[]
    usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number }
  }
  try {
    body = JSON.parse(raw)
  } catch {
    throw new Error(`${model} returned something that was not JSON.`)
  }
  if (body.error) throw new Error(describeError(res.status, body))
  const message = body.choices?.[0]?.message as { content?: string; reasoning?: string } | undefined
  if (!message?.content?.trim() && message?.reasoning) {
    log.warn('request', 'reasoned but said nothing', { model, reasoningChars: message.reasoning.length })
  }
  return {
    content: body.choices?.[0]?.message?.content ?? '',
    cost: body.usage?.cost ?? 0,
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0
  }
}

export function beginRequest(requestId: string): void {
  inFlight.set(requestId, new AbortController())
}

export function endRequest(requestId: string): void {
  inFlight.delete(requestId)
}


/** This module, as the shape the loop depends on. A second provider fills the same one. */
export const provider: Provider = { streamCompletion, complete, chatOnce, fetchModels, contextLengthOf }
