import type { ConversationRole } from '../../../shared/director'
import type { ToolContext } from './context'

/**
 * One tool: what the model is shown, when it is offered, what the transcript
 * row calls it, and what it does. Adding a tool is adding one of these to a
 * list; nothing else has to know its name.
 */
export interface Tool {
  schema: { type: 'function'; function: { name: string; description: string; parameters: unknown } }
  /** What the turn must have for the tool to be offered at all. */
  needs?: 'workspace' | 'skills' | 'knowledge'
  /** Changes something. Withheld in plan mode, and refused if called anyway. */
  writes: boolean
  /** Offered only to conversations in these roles. */
  roles?: ConversationRole[]
  /** An approved director keeps this one; the rest are the worker's own. */
  director?: boolean
  /** An interviewer, or a director before approval, keeps this one: reading, and its own files. */
  interview?: boolean
  /** A short line naming what a call is about, for the collapsed transcript row. */
  subject: (args: Record<string, unknown>) => string
  execute: (ctx: ToolContext, args: Record<string, any>) => Promise<string>
}

export const nameOf = (t: Tool): string => t.schema.function.name

/**
 * Whether a call's arguments fit the tool's own schema: every required
 * field present, every given field of the declared type. The sentence is
 * for the model, which sent them.
 */
export function validateArgs(schema: unknown, args: Record<string, unknown>): string | null {
  const fn = (schema as { function?: { name?: string; parameters?: { properties?: Record<string, { type?: string }>; required?: string[] } } })?.function
  const params = fn?.parameters
  if (!params) return null
  const missing = (params.required ?? []).filter((k) => args[k] === undefined || args[k] === null)
  if (missing.length) return `${fn?.name ?? 'the call'} needs ${missing.join(', ')}, which the call left out.`
  for (const [k, v] of Object.entries(args)) {
    const want = params.properties?.[k]?.type
    if (!want) continue
    const got = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v
    const ok = want === got || (want === 'integer' && got === 'number') || (want === 'number' && got === 'number')
    if (!ok) return `${k} should be a ${want}, not a ${got}.`
  }
  return null
}
