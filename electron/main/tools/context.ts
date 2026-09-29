import type { TodoItem, Unlockable } from '../../../shared/types'
import type { Dispatch } from '../../../shared/director'

/**
 * What a tool may reach while it runs. The file tools reach the jail and the
 * checkpoint store directly; everything that spends money, waits on a person
 * or runs another turn comes in as a capability, built for the turn by the
 * module that owns it (core, director) and stubbed by the tests.
 */
export interface ToolContext {
  projectId: string | null
  /** True once this run has read a web page; carried onto any edit it makes. */
  webUsed: () => boolean
  root: string
  /** Deny-list categories this project has opened up; empty means fully locked. */
  unlocked: Unlockable[]
  runId: string
  conversationId: string
  /** Read-only turn. The write tools are withheld, and refused if asked for anyway. */
  plan: boolean
  /** Where writes may land; empty means anywhere in the project. */
  writeGlobs: string[]
  /** Behind a director's approval gate: a refusal says the gate is a button. */
  gated?: boolean
  /** Why a path may not be written whatever the globs say: the requirements, another run's folder. */
  frozen?: (path: string) => string | null
  onTodos: (items: TodoItem[]) => void
  onWrote: (path: string) => void
  /** Handles the deny list, the sandbox, approval and execution; see core.ts. Outside the sandbox is always asked. */
  runCommand: (command: string, timeoutSec?: number, unsandboxed?: boolean, background?: boolean) => Promise<string>
  /** What a background command printed since last looked, waiting for a pattern if asked. */
  commandOutput: (handle: string, waitFor: string | null, timeoutSec: number) => Promise<string>
  stopCommand: (handle: string) => Promise<string>
  /** Runs the project's hooks for a written path; returns what they said, or ''. */
  afterWrite: (path: string) => Promise<string>
  /** A worker's question to the person; resolves with their answer. */
  askPerson: (question: string) => Promise<string>
  /** A director's workers: brief them, wait, read what they return. */
  dispatch: (tasks: Dispatch[]) => Promise<string>
  /** A question to a second, stronger model; returns its answer. */
  askOracle: (question: string, material: string) => Promise<string>
  /** Looks up MCP tools and makes the ones found callable for the rest of the turn. */
  findTools: (query: string) => Promise<string>
  /** One call to an MCP server's tool, behind a card unless the tool only reads or the server is trusted. */
  callMcp: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>
  /** One worker for one task, from an ordinary conversation; this turn waits for its report. */
  delegate: (spec: { title: string; brief: string; model?: string; owns: string[]; readOnly: boolean; maxSpend: number }) => Promise<string>
  continueTask: (args: { taskId: string; message: string }) => Promise<string>
}
