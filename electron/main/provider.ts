import type { ModelInfo, ModelParams } from '../../shared/types'
import type { ReportedPhase } from '../../shared/activity'
import type { Routing } from '../../shared/routing'
import type { CompletionResult } from './openrouter'

/**
 * What the turn loop needs from whoever serves the model. OpenRouter is the
 * one implementation today; the shape is written down so a second (a local
 * endpoint speaking the OpenAI dialect, say) is a module that fills it in,
 * not a rewrite of the loop. The request registry (begin, cancel, signal) is
 * the client's own and stays outside this.
 */
export interface StreamRequest {
  model: string
  messages: unknown[]
  tools?: unknown[]
  plugins?: unknown[]
  reasoning?: boolean
  params?: ModelParams
  routing?: Routing
  /**
   * Pins the provider that served the last cached request for this
   * conversation, so the cache it holds is the one asked; OpenRouter
   * otherwise routes each request afresh.
   */
  sessionId?: string
}

export interface Provider {
  /** One streamed completion for a request id the client has registered. */
  streamCompletion(
    requestId: string,
    body: StreamRequest,
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void,
    onPhase?: (phase: ReportedPhase) => void
  ): Promise<CompletionResult>
  /** One plain reply, for housekeeping: bounded, stoppable, never touches the conversation. */
  complete(
    model: string,
    messages: { role: string; content: string }[],
    opts?: { maxTokens?: number; signal?: AbortSignal; timeoutMs?: number }
  ): Promise<string>
  /** One plain reply with its cost, for side calls such as the oracle. */
  chatOnce(
    model: string,
    messages: { role: string; content: string }[],
    opts: { maxTokens: number; seed?: number; temperature?: number; topP?: number; topK?: number; signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ content: string; cost: number; promptTokens: number; completionTokens: number }>
  fetchModels(): Promise<ModelInfo[]>
  contextLengthOf(modelId: string): Promise<number>
}
