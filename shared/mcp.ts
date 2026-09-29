/**
 * MCP servers as the person configures them, and the shape their tools take
 * in Harbor. Pure: the connections live in electron/main/mcp.ts.
 *
 * A server's tools do not enter the prompt whole. Their names and one line
 * each are behind find_tools; a tool the model looks up is loaded for the
 * rest of the turn. Ten servers can carry two hundred schemas, and a
 * prefix that changes whenever a server reconnects is a cache lost.
 */

export const SERVERS_SETTING = 'mcp_servers'

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  /** Off: configured, not connected. */
  enabled: boolean
  /** Its tools run without a card, read-only or not. Off, only tools that say they only read run unasked. */
  trusted: boolean
}

const slug = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** The setting's JSON as configs, with what was wrong when it was. */
export function parseServers(json: string): { servers: McpServerConfig[]; error?: string } {
  if (!json.trim()) return { servers: [] }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    return { servers: [], error: `Not JSON: ${(e as Error).message}` }
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { servers?: unknown }).servers) ? (raw as { servers: unknown[] }).servers : null
  if (!list) return { servers: [], error: 'Expected a list of servers, or an object with a "servers" list.' }
  const servers: McpServerConfig[] = []
  const seen = new Set<string>()
  for (const [i, item] of list.entries()) {
    const o = (item ?? {}) as Record<string, unknown>
    const name = typeof o.name === 'string' ? slug(o.name) : ''
    if (!name) return { servers: [], error: `Server ${i + 1} has no name.` }
    if (seen.has(name)) return { servers: [], error: `Two servers are called "${name}".` }
    seen.add(name)
    const transport = o.url ? 'http' : 'stdio'
    if (transport === 'stdio' && typeof o.command !== 'string') return { servers: [], error: `Server "${name}" needs a command, or a url.` }
    if (transport === 'http' && !/^https?:\/\//.test(String(o.url))) return { servers: [], error: `Server "${name}" has a url that is not http(s).` }
    servers.push({
      name,
      transport,
      command: typeof o.command === 'string' ? o.command : undefined,
      args: Array.isArray(o.args) ? (o.args as unknown[]).map(String) : undefined,
      env: o.env && typeof o.env === 'object' ? Object.fromEntries(Object.entries(o.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : undefined,
      url: typeof o.url === 'string' ? o.url : undefined,
      enabled: o.enabled !== false,
      trusted: o.trusted === true
    })
  }
  return { servers }
}

/** What an MCP tool is called in Harbor: the server and the tool, in one name the schema can carry. */
export const toolName = (server: string, tool: string): string => `mcp__${slug(server)}__${tool}`
export function splitToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([a-z0-9-]+)__(.+)$/.exec(name)
  return m ? { server: m[1], tool: m[2] } : null
}
export const isMcpTool = (name: string): boolean => name.startsWith('mcp__')

/** A line naming what a call is about, for the transcript row: the first string argument, or the keys. */
export function summariseArgs(args: Record<string, unknown>): string {
  for (const v of Object.values(args)) if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80)
  const keys = Object.keys(args)
  return keys.length ? keys.join(', ') : ''
}

export interface ToolListing {
  name: string
  description: string
  /** Names of the input's properties, for the one-line listing. */
  params: string[]
  readOnly: boolean
}

/** Tools that match a query, best first: words of the query against name and description. */
export function rankTools(query: string, tools: ToolListing[], max = 12): ToolListing[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1)
  const score = (t: ToolListing): number => {
    const hay = `${t.name} ${t.description}`.toLowerCase()
    let n = 0
    for (const w of words) {
      if (t.name.toLowerCase().includes(w)) n += 3
      else if (hay.includes(w)) n += 1
    }
    return n
  }
  if (!words.length) return tools.slice(0, max)
  return tools
    .map((t) => ({ t, s: score(t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
    .slice(0, max)
    .map((x) => x.t)
}

/** The listing the model reads back from find_tools. */
export function formatListing(tools: ToolListing[], total: number): string {
  if (!tools.length) return total ? `None of the ${total} tools match. Try other words, or an empty query to list them all.` : 'No MCP tools are connected. The person adds servers in Settings.'
  const lines = tools.map((t) => `- ${t.name}${t.readOnly ? ' (reads only)' : ''}${t.params.length ? ` — takes ${t.params.join(', ')}` : ''}\n  ${t.description.trim().split('\n')[0].slice(0, 200)}`)
  return `${tools.length} of ${total} tools. Each is now available to call by name:\n${lines.join('\n')}`
}
