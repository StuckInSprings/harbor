import type { ConversationRole } from '../../../shared/director'
import { nameOf, type Tool } from './registry'
import { DISCOVERY, FILE, JOBS, KNOWLEDGE, ORACLE, mcpTool } from './core'
import * as mcp from '../mcp'
import { isMcpTool } from '../../../shared/mcp'
import { DELEGATED, DIRECTOR, WORKER } from './director'
import type { ToolContext } from './context'

export type { ToolContext } from './context'
export type { Tool } from './registry'
export { validateArgs } from './registry'
export { nearestLine, refuseOutside } from './core'

/**
 * The tools an agent turn can call. Every one that touches the filesystem goes
 * through the path jail in workspace.ts, and every write is checkpointed first.
 *
 * The order here is the order the model sees, and the prompt cache sees the
 * same bytes; do not sort it.
 */
export const TOOLS: Tool[] = [...FILE, ...JOBS, ...DELEGATED, ...WORKER, ...KNOWLEDGE, ...ORACLE, ...DISCOVERY, ...DIRECTOR]

const byName = new Map(TOOLS.map((t) => [nameOf(t), t]))

/*
  What plan mode takes away. The checklist stays: it writes nothing to disk,
  and a plan is exactly what it is for.
*/
export const WRITE_TOOLS = new Set(TOOLS.filter((t) => t.writes).map(nameOf))
/** What an approved director may do itself: read, write its files and the board, run a command, keep the checklist. */
export const DIRECTOR_TOOLS = new Set(TOOLS.filter((t) => t.director).map(nameOf))
/** What an interviewer may do: read the project, write its own files. Nothing that spends or runs. */
export const INTERVIEW_TOOLS = new Set(TOOLS.filter((t) => t.interview).map(nameOf))

export function toolSchemas(opts: {
  hasWorkspace: boolean
  hasSkills: boolean
  hasKnowledge: boolean
  plan?: boolean
  role?: ConversationRole
  /** A director's plan has been approved; before that it reads and writes its files only. */
  approved?: boolean
  /** MCP tools the model has looked up this turn, by their Harbor names; their schemas ride along. */
  loaded?: Set<string>
}): unknown[] {
  const connected = mcp.tools().length > 0
  const has = (t: Tool): boolean =>
    t.needs === undefined ||
    (t.needs === 'workspace' && opts.hasWorkspace) ||
    (t.needs === 'skills' && opts.hasSkills) ||
    (t.needs === 'knowledge' && opts.hasKnowledge)
  // find_tools is offered only while a server is connected; a found tool's schema is added for the rest of the turn.
  const dynamic = (opts.loaded ? [...opts.loaded] : []).map((n) => mcp.toolByName(n)).filter((t): t is mcp.McpTool => !!t).map(mcpTool)
  const offered = [...TOOLS.filter((t) => !DISCOVERY.includes(t) || connected), ...dynamic].filter((t) => has(t) && !(opts.plan && t.writes))
  const general = offered.filter((t) => !t.roles || (opts.role !== undefined && t.roles.includes(opts.role)))

  if (opts.role === 'interview' || (opts.role === 'director' && !opts.approved)) {
    return general.filter((t) => t.interview).map((t) => t.schema)
  }
  if (opts.role === 'director') {
    // An approved director briefs workers; it keeps the reading tools and its own writes, not delegation.
    return [...general.filter((t) => t.director).map((t) => t.schema), ...DIRECTOR.map((t) => t.schema)]
  }
  return general.map((t) => t.schema)
}

/** A static tool by name, or an MCP server's tool by its Harbor name. */
function lookup(name: string): Tool | undefined {
  const t = byName.get(name)
  if (t) return t
  if (!isMcpTool(name)) return undefined
  const m = mcp.toolByName(name)
  return m ? mcpTool(m) : undefined
}

/** A short line naming what a call is about, for the collapsed transcript row. */
export function subjectOf(name: string, args: Record<string, unknown>): string {
  return lookup(name)?.subject(args) ?? ''
}

export async function execute(ctx: ToolContext, name: string, args: Record<string, any>): Promise<string> {
  const tool = lookup(name)
  if (!tool) throw new Error(`Unknown tool: ${name}${isMcpTool(name) ? ' (no connected MCP server offers it; call find_tools)' : ''}`)
  // The schema already withholds these; this is for a model that calls one anyway.
  if (ctx.plan && tool.writes) {
    return `Refused: plan mode is on, so ${name} is not available. Describe the change you would make instead.`
  }
  return tool.execute(ctx, args)
}
