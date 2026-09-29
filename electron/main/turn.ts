import type { Conversation, Project, RunOptions, StreamEvent, TerminalEvent, Unlockable } from '../../shared/types'
import type { ConversationRole } from '../../shared/director'

export type Emit = (e: StreamEvent) => void
export type EmitTerminal = (e: TerminalEvent) => void

/**
 * One turn, as the tools see it: who is asking, where, on what, and the
 * few things a tool may do on the turn's behalf. Built once in run.ts and
 * handed to the modules that build the turn's capabilities (tools/core,
 * tools/director), so those can live outside the loop.
 */
export interface Turn {
  /** The request id: what the renderer knows the turn by, and what Stop aborts. */
  id: string
  conversationId: string
  conversation: Conversation | null
  project: Project | null
  projectId: string | null
  root: string | null
  unlocked: Unlockable[]
  role: ConversationRole
  model: string
  plan: boolean
  emit: Emit
  emitTerminal: EmitTerminal
  /** The turn's own abort signal, for anything that waits on its behalf. */
  signal: () => AbortSignal | undefined
  cancelled: () => boolean
  /** True once this run has read a web page; carried onto any edit it makes. */
  webUsed: () => boolean
  /** Records what the tool being executed has spent, on its result row. */
  spend: (amount: number) => void
  /** MCP tools the model has looked up this turn; their schemas ride along from the next step. */
  loadTools: (names: string[]) => void
  /** Another turn, run to its end while this one waits: a worker. */
  runNested: (opts: RunOptions & { requestId: string }, emit: Emit, emitTerminal: EmitTerminal) => Promise<void>
}
