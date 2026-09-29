import type { ConversationRole } from './director'
/** Types shared between the main process and the renderer. */

import type { ReportedPhase } from './activity'
import type { Hook } from './hooks'

export type { Hook }

/** Deny-list categories a project can open up. Empty means fully locked. */
export type Unlockable = 'git' | 'deps' | 'env' | 'keys'

/*
  The general scope: chats that belong to no project. Stored as a project
  row, since everything a conversation owns hangs off one, but it has no
  folder, no instructions of its own unless the person writes some, and it
  cannot be removed. The interface shows it as Chats, above the projects.
*/
export const GENERAL_PROJECT_ID = 'general'
export const GENERAL_PROJECT_NAME = 'Chats'

export interface Project {
  id: string
  name: string
  rootPath: string | null
  systemPrompt: string
  defaultModel: string | null
  unlocked: Unlockable[]
  /** Fold the system prompt into the first user turn instead of a system role. */
  systemAsUser: boolean
  /** Defaults for conversations in this project. */
  params: ModelParams
  /** Commands run after the agent writes a file; see shared/hooks.ts. */
  hooks: Hook[]
  /** Where the agent may write, as globs relative to the root; empty means anywhere. */
  writeGlobs: string[]
  /** Files in the project folder read into every prompt — what the project has learned. */
  contextFiles: string[]
  /** Run commands without asking, inside a folder under version control. The hard deny list still holds. */
  autoApprove: boolean
  /** Model tiers a director picks from, as `name = model | note` lines; see shared/tiers.ts. */
  tiers: string
  /** Put away: listed only under Archived in the sidebar, and left out of the plan picker, the launcher and the director's choice of where a task runs. */
  archived: boolean
  createdAt: number
  updatedAt: number
}

export interface Conversation {
  id: string
  projectId: string
  title: string
  model: string | null
  pinned: boolean
  /** Hidden from the sidebar but kept, and still findable in search. */
  archived: boolean
  /** A throwaway: never listed, never searched, deleted when left unless kept. */
  scratch: boolean
  /** What the conversation is for: an ordinary chat, an interview, a director, or a worker. */
  role: ConversationRole
  /** A director's ceiling in dollars; 0 means none was set. */
  budget: number
  /** A director's plan has been read and approved. */
  approved: boolean
  /** For a worker: the director conversation it belongs to. */
  runId: string | null
  /** For a worker: the paths its brief lets it change. Empty means the project's own allowance. */
  writeGlobs: string[]
  /** For a director: one task end to end, then stop. */
  rehearsal: boolean
  /** For a director: the branch made for the run, when one could be; and the commit it started from. */
  runBranch: string | null
  runBase: string | null
  /** The folder a run's files live in: an interview's, and the director it started. Null for a run from before folders. */
  runDir: string | null
  /** Overrides the project's defaults; empty means inherit. */
  params: ModelParams
  /** A condition the conversation works toward on its own; see shared/goal.ts. */
  goal: string | null
  goalState: string | null
  /** Turns taken toward it, dollars it may spend, when it was set, and turns in a row without a tool call. */
  goalTurns: number
  goalBudget: number
  goalSince: number | null
  goalIdle: number
  /** The message at the tip of the branch currently on screen. */
  leafId: string | null
  createdAt: number
  updatedAt: number
}

export type Role = 'user' | 'assistant' | 'system' | 'tool'

/** One saved state of a file, across every conversation in the project. */
export interface FileVersion {
  checkpointId: string
  conversationId: string
  conversationTitle: string
  /** The content after this write; null if the write deleted it. */
  hash: string | null
  created: boolean
  undone: boolean
  createdAt: number
}

/** One row of a directory listing, for the explorer. */
export interface WorkspaceEntry {
  name: string
  kind: 'dir' | 'file'
  size: number
  /** Milliseconds since the epoch; 0 for a folder. */
  modifiedAt: number
}

export interface Message {
  id: string
  conversationId: string
  /** null for the root of a branch. Conversations are trees, not lists. */
  parentId: string | null
  role: Role
  content: string
  model: string | null
  reasoning: string | null
  error: string | null
  /** JSON array of tool calls this assistant message asked for. */
  toolCalls: string | null
  /**
   * JSON array of the provider's reasoning blocks, kept verbatim so they can
   * be sent back on the next step of a tool loop; some providers require it.
   */
  reasoningDetails: string | null
  /** JSON array of Citation, when the turn read from the web. */
  citations: string | null
  /** JSON array of Attachment on a user message. */
  attachments: string | null
  /** Set on role 'tool' rows, linking a result back to its call. */
  toolCallId: string | null
  /**
   * Cleared from what the model is sent, to make room: a tool result
   * replaced by a stub, a user message's images dropped. The row keeps its
   * content for the transcript. Never unset, so the cached prefix is stable.
   */
  trimmed: boolean
  /**
   * Set on the root of a compacted branch: the leaf of the branch it
   * summarises, so the original is one click away.
   */
  summaryOf: string | null
  promptTokens: number | null
  completionTokens: number | null
  /** Prompt tokens served from the provider's cache, at a fraction of the price. */
  cachedTokens: number | null
  /** Prompt tokens the provider wrote to its cache this turn, for the next. */
  cacheWriteTokens: number | null
  /**
   * A fingerprint of the cacheable prefix this reply was asked with (the
   * instructions, the tool names, the model). Two replies with different
   * prints could not have shared a cache, which is the commonest reason a
   * turn is billed in full.
   */
  prefixHash: string | null
  reasoningTokens: number | null
  cost: number | null
  /** How a fanned-out reply was asked, when not as the conversation is set: "t=1.2". */
  label: string | null
  createdAt: number
}

/** A price tier that kicks in once the prompt passes a size threshold. */
export interface PriceTier {
  minPromptTokens: number
  promptPrice: number
  completionPrice: number
}

export interface ModelInfo {
  id: string
  name: string
  contextLength: number
  maxCompletionTokens: number | null
  /** USD per million tokens throughout. */
  promptPrice: number
  completionPrice: number
  /** Reading a cached prompt is far cheaper; writing one usually costs a premium. */
  cacheReadPrice: number | null
  cacheWritePrice: number | null
  /** Some models double in price above a prompt size — see pricing.overrides. */
  tiers: PriceTier[]
  /** Accepts images, files, audio or video alongside text. */
  inputModalities: string[]
  /** Whether caching happens on its own or needs explicit cache_control breakpoints. */
  caching: 'automatic' | 'explicit' | 'none'
  supportsTools: boolean
  supportsReasoning: boolean
  /** What OpenRouter says about the model's reasoning: which efforts it takes, its default, and whether it can be turned off. */
  reasoning: ModelReasoning
  /** Raw supported_parameters, so the interface can offer only what applies. */
  supportedParameters: string[]
  description: string
}

export type ReasoningEffort = 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none'
export interface ModelReasoning {
  /** The model always reasons; the toggle cannot turn it off. */
  mandatory: boolean
  /** Reasons unless asked not to. */
  defaultEnabled: boolean
  /** The efforts this model accepts, in OpenRouter's order; empty when it takes none, or when unknown. */
  efforts: ReasoningEffort[]
  defaultEffort: ReasoningEffort | null
}

export interface KeyStatus {
  present: boolean
  /** Populated from OpenRouter's /key endpoint when a key is set. */
  label?: string
  usage?: number
  limit?: number | null
}

/** Emitted from main to the renderer while a turn runs. */
export type StreamEvent =
  | { type: 'begin'; requestId: string; messageId: string }
  /*
    Where the turn has got to, for the phases that produce no other event.
    Everything else the waiting line says is inferred from the events below.
  */
  | { type: 'phase'; requestId: string; phase: ReportedPhase; detail?: string }
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'reasoning'; requestId: string; text: string }
  | { type: 'tool_start'; requestId: string; call: ToolRun }
  | { type: 'tool_end'; requestId: string; call: ToolRun }
  | { type: 'todos'; requestId: string; items: TodoItem[] }
  | { type: 'wrote'; requestId: string; path: string }
  /** The branch was compacted before this turn was sent; see shared/compact.ts. */
  | { type: 'compacted'; requestId: string; summarised: number; summaryId: string }
  /** Old tool results and images were cleared from the context to make room. */
  | { type: 'trimmed'; requestId: string; results: number; images: number }
  /** A goal was judged after a turn: it goes on, or it is over and why. */
  | { type: 'goal'; requestId: string; conversationId: string; state: string; note: string; turns: number }
  | { type: 'remembered'; requestId: string; count: number }
  /** A director's worker started or finished; the sidebar shows it running. */
  | { type: 'worker'; requestId: string; conversationId: string; state: 'started' | 'done' | 'waiting'; question?: string }
  | {
      type: 'done'
      requestId: string
      promptTokens: number | null
      completionTokens: number | null
      cachedTokens: number | null
      reasoningTokens: number | null
      cost: number | null
    }
  | { type: 'error'; requestId: string; message: string }

/**
 * Sampling and reasoning controls.
 *
 * Every field is optional and omitted when unset, because OpenRouter silently
 * drops a parameter a model does not support — so sending one hopefully looks
 * identical to it working. Harbor only sends what the chosen model advertises.
 */
export interface ModelParams {
  temperature?: number
  topP?: number
  topK?: number
  /** Drops tokens under this share of the top token's probability. The creative-model sampler. */
  minP?: number
  /** Like min_p, scaled by the top token's probability squared. */
  topA?: number
  /** Multiplicative; 1 is off. Open-weight models loop without it. */
  repetitionPenalty?: number
  maxTokens?: number
  seed?: number
  frequencyPenalty?: number
  presencePenalty?: number
  reasoningEffort?: ReasoningEffort
  reasoningMaxTokens?: number
}

/** A turn is driven entirely by the main process; see electron/main/run.ts. */
export interface RunOptions {
  conversationId: string
  /** Message to continue from; null starts a fresh branch. */
  parentId: string | null
  model: string
  /** Off for a plain chat turn, or when the model cannot call tools. */
  agent: boolean
  /** Let the model search the web. Billed per search, on top of tokens. */
  web: boolean
  /** Ask for reasoning, on models that can produce it. */
  reasoning: boolean
  /** Agent turn without the write tools: look and propose, change nothing. */
  plan: boolean
  /** Already filtered to what this model supports. */
  params: ModelParams
  /** The model's input modalities, so attachments it cannot read are left out. */
  accepts: string[]
  /** The model's context window, so a prompt that will not fit is compacted first. 0 when unknown. */
  contextLength: number
  /** A fan-out variant's name, kept on the reply so two from one model can be told apart. */
  label?: string
  /** The turn this one runs inside, when a worker's; its trace hangs under the caller's. */
  parentRequestId?: string
}

export interface TodoItem {
  content: string
  status: 'pending' | 'active' | 'done'
}

/** A page the model read, as reported by OpenRouter's url_citation annotations. */
/** A file attached to one message. Bytes live in the blob store, not the row. */
export interface Attachment {
  hash: string
  name: string
  mime: string
  kind: 'image' | 'pdf' | 'text'
  size: number
}

export interface Citation {
  url: string
  title: string
  excerpt: string
}

export interface ToolRun {
  callId: string
  name: string
  /** One line describing what was asked for, e.g. the path or query. */
  subject: string
  args: string
  result?: string
  ok?: boolean
}

export type ApprovalDecision = 'once' | 'always' | 'deny' | 'timeout' | 'cancelled'

/** Terminal traffic travels on its own channel, separate from chat events. */
export type TerminalEvent =
  | {
      type: 'approval'
      conversationId: string
      approvalId: string
      command: string
      /** Asked to run outside the sandbox: the fence is off for this one. */
      unsandboxed?: boolean
      /** Why this reached the person rather than running: the judge's reason. */
      note?: string
      cwd: string
    }
  | {
      type: 'approval_resolved'
      conversationId: string
      approvalId: string
      decision: ApprovalDecision
    }
  | {
      type: 'start'
      conversationId: string
      handle: string
      command: string
      source: 'agent' | 'you' | 'hook'
    }
  | {
      type: 'chunk'
      conversationId: string
      handle: string
      text: string
      stream: 'stdout' | 'stderr'
    }
  | {
      type: 'end'
      conversationId: string
      handle: string
      exitCode: number | null
      timedOut: boolean
    }

export interface AllowedCommand {
  id: string
  pattern: string
  createdAt: number
}

export interface PromptSection {
  label: string
  text: string
  chars: number
  tokens: number
}

/** Exactly what goes in the system message, as the turn loop assembles it. */
export interface AssembledSystem {
  sections: PromptSection[]
  text: string
  tokens: number
  cached: boolean
  cacheNote: string
  memoryIds: string[]
}

export interface LogLine {
  at: number
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
  detail?: Record<string, unknown>
}

export interface SearchResult {
  kind: 'conversation' | 'message' | 'memory' | 'skill' | 'prompt'
  conversationId: string | null
  title: string
  snippet: string
  projectId: string | null
}

export interface Prompt {
  id: string
  projectId: string | null
  name: string
  body: string
  createdAt: number
}

export interface Skill {
  name: string
  description: string
  body: string
  projectId: string | null
  path: string
}

export interface KnowledgeSource {
  id: string
  projectId: string
  path: string
  chunks: number
  indexedAt: number | null
  createdAt: number
}

export type IndexProgress =
  | { sourceId: string; state: 'indexing'; file: string; done: number; total: number }
  | { sourceId: string; state: 'done'; files: number; chunks: number; skipped: number }
  | { sourceId: string; state: 'error'; message: string }

export interface Memory {
  id: string
  projectId: string
  text: string
  sourceConvId: string | null
  sourceMsgId: string | null
  extractedBy: string | null
  enabled: boolean
  pinned: boolean
  lastUsedAt: number | null
  createdAt: number
  /** Who this came from: something the person said, or something the model concluded from the work. */
  origin: 'person' | 'model'
  /** False while a new memory waits for the person to keep or drop it, when Settings asks for that. */
  reviewed: boolean
  /** Set when a later fact contradicted it; kept, not deleted, so the history can be read. */
  invalidatedAt: number | null
  invalidatedBy: string | null
}

/** The whole tree as one commit in Harbor's shadow repository, either side of an agent turn. */
export interface TreeSnapshot {
  id: string
  /** The turn it belongs to. */
  runId: string
  conversationId: string
  projectId: string
  kind: 'before' | 'after' | 'restore'
  sha: string
  createdAt: number
}

export interface Checkpoint {
  id: string
  runId: string
  conversationId: string
  path: string
  beforeHash: string | null
  afterHash: string | null
  /** True when the write created the file, so undo deletes it again. */
  created: boolean
  /** The run that made this edit had read untrusted web content. */
  webUsed: boolean
  undone: boolean
  createdAt: number
}

export interface DailyCost {
  day: string
  total: number
  messages: number
}

export interface Result<T> {
  ok: boolean
  data?: T
  error?: string
}
