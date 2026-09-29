// A tiny MCP server over stdio, for the tests: one tool that only reads, one that "writes", one that fails.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo-fixture', version: '0.0.1' })
server.registerTool('echo', { description: 'Echoes the text back, upper case.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: 'text', text: String(text).toUpperCase() }] }))
server.registerTool('write_note', { description: 'Writes a note somewhere.', inputSchema: { note: z.string() } }, async ({ note }) => ({ content: [{ type: 'text', text: `wrote: ${note}` }] }))
server.registerTool('fail', { description: 'Always fails.', inputSchema: {} }, async () => ({ isError: true, content: [{ type: 'text', text: 'it broke' }] }))
server.registerTool('big', { description: 'Returns a lot.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'x'.repeat(250_000) }] }))
await server.connect(new StdioServerTransport())
