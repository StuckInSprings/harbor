import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import * as db from './db'
import * as log from './log'

/**
 * Spans from the timing the log already keeps, sent as OpenTelemetry
 * traces to any OTLP/HTTP collector: one `invoke_agent` per turn, a `chat`
 * per model request under it with the tokens and the cost, and an
 * `execute_tool` per tool run. Off until an endpoint is set; then batched
 * and posted every few seconds, and a collector that is down loses the
 * batch rather than the turn. The attribute names follow the GenAI
 * semantic conventions, which are not yet stable; `harbor.*` is ours.
 */

export const ENDPOINT_SETTING = 'otel_endpoint'
export const HEADERS_SETTING = 'otel_headers'

export type AttrValue = string | number | boolean
export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 'internal' | 'client'
  start: number
  end: number
  attrs: Record<string, AttrValue>
  error?: string
}

export interface Handle {
  traceId: string
  spanId: string
  /** Ends the span, with more attributes and, when it failed, why. Ending twice is nothing. */
  end: (attrs?: Record<string, AttrValue | null | undefined>, error?: string) => void
}

const FLUSH_MS = 5_000
const QUEUE_CAP = 2_000
const BATCH = 200

let queue: Span[] = []
let timer: NodeJS.Timeout | null = null
let lastWarned = 0
/** The turn spans still open, by request id, so a step or a tool can hang under its turn. */
const turns = new Map<string, Handle>()

export const endpoint = (): string => {
  try {
    return (db.getSetting(ENDPOINT_SETTING) ?? '').trim()
  } catch {
    return ''
  }
}
export const enabled = (): boolean => endpoint() !== ''

/** `Name: value`, one per line; blank lines and lines without a colon are dropped. */
export function parseHeaders(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (k && v) out[k] = v
  }
  return out
}

export const newTraceId = (): string => randomBytes(16).toString('hex')
export const newSpanId = (): string => randomBytes(8).toString('hex')

function clean(attrs: Record<string, AttrValue | null | undefined>): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {}
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== '') out[k] = v
  return out
}

/**
 * A span begun. Nothing is recorded until it ends, and nothing at all when
 * no endpoint is set; the handle is cheap enough to make regardless.
 */
export function startSpan(name: string, attrs: Record<string, AttrValue | null | undefined>, parent?: { traceId: string; spanId: string } | null, kind: Span['kind'] = 'internal'): Handle {
  const traceId = parent?.traceId ?? newTraceId()
  const spanId = newSpanId()
  const start = Date.now()
  let done = false
  return {
    traceId,
    spanId,
    end: (more = {}, error) => {
      if (done) return
      done = true
      if (!enabled()) return
      record({ traceId, spanId, parentSpanId: parent?.spanId, name, kind, start, end: Date.now(), attrs: clean({ ...attrs, ...more }), ...(error ? { error } : {}) })
    }
  }
}

/** A turn's span, kept by request id while it runs; a nested turn hangs under its parent's. */
export function startTurn(requestId: string, attrs: Record<string, AttrValue | null | undefined>, parentRequestId?: string | null): Handle {
  const parent = parentRequestId ? turns.get(parentRequestId) : null
  const h = startSpan('invoke_agent', { 'gen_ai.operation.name': 'invoke_agent', ...attrs }, parent ?? null)
  const wrapped: Handle = {
    ...h,
    end: (more, error) => {
      turns.delete(requestId)
      h.end(more, error)
    }
  }
  turns.set(requestId, wrapped)
  return wrapped
}
export const turnSpan = (requestId: string): Handle | null => turns.get(requestId) ?? null

function record(span: Span): void {
  queue.push(span)
  if (queue.length > QUEUE_CAP) queue = queue.slice(-QUEUE_CAP)
  if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS)
}

const attrValue = (v: AttrValue): Record<string, unknown> =>
  typeof v === 'boolean' ? { boolValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: String(v) }

/** The batch as OTLP/JSON, the shape a collector's /v1/traces takes. */
export function otlpBody(spans: Span[], version = 'dev'): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'harbor' } }, { key: 'service.version', value: { stringValue: version } }] },
        scopeSpans: [
          {
            scope: { name: 'harbor', version },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind === 'client' ? 3 : 1,
              startTimeUnixNano: `${s.start}000000`,
              endTimeUnixNano: `${s.end}000000`,
              attributes: Object.entries(s.attrs).map(([key, v]) => ({ key, value: attrValue(v) })),
              status: s.error ? { code: 2, message: s.error.slice(0, 500) } : { code: 1 }
            }))
          }
        ]
      }
    ]
  }
}

/** What is queued, sent. A collector that does not answer costs one warning a minute and the batch. */
export async function flush(): Promise<number> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const url = endpoint()
  if (!url || queue.length === 0) {
    queue = []
    return 0
  }
  let sent = 0
  while (queue.length) {
    const batch = queue.splice(0, BATCH)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...parseHeaders(db.getSetting(HEADERS_SETTING)) },
        body: JSON.stringify(otlpBody(batch, safeVersion())),
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      sent += batch.length
    } catch (e) {
      if (Date.now() - lastWarned > 60_000) {
        lastWarned = Date.now()
        log.warn('otel', 'the collector did not take the spans', { endpoint: url, dropped: batch.length, error: (e as Error).message.split('\n')[0] })
      }
      queue = []
      return sent
    }
  }
  return sent
}

const safeVersion = (): string => {
  try {
    return app.getVersion()
  } catch {
    return 'dev'
  }
}

/** For tests: what waits to be sent. */
export const pending = (): number => queue.length

export async function stop(): Promise<void> {
  await flush()
}
