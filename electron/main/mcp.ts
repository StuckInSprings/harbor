import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as db from './db'
import * as log from './log'
import { SERVERS_SETTING, parseServers, toolName, type McpServerConfig, type ToolListing } from '../../shared/mcp'

/**
 * The MCP servers this session is connected to, and their tools. Each is a
 * process Harbor started (stdio) or an endpoint it reached (HTTP); the
 * tools they offer are listed once on connect and made callable by name.
 * Their output is capped like any tool's and spilled when large.
 */

export interface McpTool {
  server: string
  name: string
  description: string
  inputSchema: unknown
  readOnly: boolean
}

interface Live {
  config: McpServerConfig
  client: Client | null
  tools: McpTool[]
  error: string | null
  connectedAt: number | null
}

const servers = new Map<string, Live>()
const CONNECT_MS = 20_000
const CALL_MS = 120_000
/** A result larger than this is cut; the tool loop spills the rest to a file. */
const MAX_TEXT = 200_000

export interface ServerStatus {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  trusted: boolean
  connected: boolean
  tools: number
  error: string | null
}

export const status = (): ServerStatus[] =>
  [...servers.values()].map((s) => ({ name: s.config.name, transport: s.config.transport, enabled: s.config.enabled, trusted: s.config.trusted, connected: !!s.client, tools: s.tools.length, error: s.error }))

/** What the setting says, parsed; a bad setting is a status line, not a crash. */
export function configured(): { servers: McpServerConfig[]; error?: string } {
  return parseServers(db.getSetting(SERVERS_SETTING) ?? '')
}

async function connectOne(config: McpServerConfig): Promise<Live> {
  const live: Live = { config, client: null, tools: [], error: null, connectedAt: null }
  if (!config.enabled) return live
  const client = new Client({ name: 'harbor', version: '0.1.0' })
  try {
    const transport =
      config.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(config.url as string))
        : new StdioClientTransport({ command: config.command as string, args: config.args ?? [], env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) }, stderr: 'pipe' })
    await client.connect(transport, { timeout: CONNECT_MS })
    const listed = await client.listTools(undefined, { timeout: CONNECT_MS })
    live.client = client
    live.connectedAt = Date.now()
    live.tools = listed.tools.map((t) => ({
      server: config.name,
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      readOnly: t.annotations?.readOnlyHint === true
    }))
    log.info('mcp', 'connected', { server: config.name, transport: config.transport, tools: live.tools.length })
  } catch (e) {
    live.error = (e as Error).message
    log.warn('mcp', 'could not connect', { server: config.name, error: live.error })
    await client.close().catch(() => undefined)
  }
  return live
}

/** Connects every configured server; a server that fails is listed with its error and the rest carry on. */
export async function init(): Promise<void> {
  await closeAll()
  const { servers: list, error } = configured()
  if (error) {
    log.warn('mcp', 'servers setting is not usable', { error })
    return
  }
  const lives = await Promise.all(list.map(connectOne))
  for (const l of lives) servers.set(l.config.name, l)
}

export async function closeAll(): Promise<void> {
  for (const s of servers.values()) await s.client?.close().catch(() => undefined)
  servers.clear()
}

/** Every tool of every connected server. */
export function tools(): McpTool[] {
  return [...servers.values()].flatMap((s) => s.tools)
}

export function toolByName(name: string): McpTool | undefined {
  return tools().find((t) => toolName(t.server, t.name) === name)
}

export function listing(): ToolListing[] {
  return tools().map((t) => ({
    name: toolName(t.server, t.name),
    description: t.description,
    params: Object.keys(((t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}) as object),
    readOnly: t.readOnly
  }))
}

export const trusted = (server: string): boolean => servers.get(server)?.config.trusted === true

/** One call. Text content is joined; anything else is named; a result the server marks as an error is an error here. */
export async function call(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const live = servers.get(server)
  if (!live?.client) throw new Error(`The MCP server "${server}" is not connected${live?.error ? `: ${live.error}` : ''}.`)
  const at = Date.now()
  const result = await live.client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_MS, signal })
  const content = (result.content ?? []) as { type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[]
  const parts = content.map((c) => {
    if (c.type === 'text') return c.text ?? ''
    if (c.type === 'image') return `[an image, ${c.mimeType ?? 'unknown type'}, which this tool loop does not carry]`
    if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`
    return `[${c.type}]`
  })
  let text = parts.join('\n').trim()
  if (!text && result.structuredContent) text = JSON.stringify(result.structuredContent, null, 2)
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n[cut at ${MAX_TEXT.toLocaleString()} characters]`
  log.info('mcp', result.isError ? 'tool failed' : 'tool done', { server, tool, ms: log.since(at), chars: text.length })
  if (result.isError) throw new Error(text || `${tool} failed without saying why.`)
  return text || '(the tool returned nothing)'
}
