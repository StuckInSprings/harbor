import type { ModelInfo, ModelParams, ReasoningEffort } from './types'

/** Every effort OpenRouter knows, from most to least; a model lists a subset. */
export const EFFORT_ORDER: readonly ReasoningEffort[] = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']

/**
 * The efforts to offer for a model: what it lists, in order. A model that
 * reasons but lists none takes no effort at all, only a token budget; a
 * model whose listing is unknown gets the three every provider took before
 * the listing existed.
 */
export function effortsFor(model: ModelInfo | null): ReasoningEffort[] {
  if (!model) return ['low', 'medium', 'high']
  if (!model.supportsReasoning) return []
  if (!model.reasoning) return ['low', 'medium', 'high']
  return model.reasoning.efforts
}

/**
 * Which parameter each field maps to in OpenRouter's `supported_parameters`,
 * and therefore whether it is worth sending at all. Shared between the
 * interface, which decides what to show, and the tests, so the two cannot
 * drift apart.
 */
export const PARAM_REQUIRES: Record<keyof ModelParams, string> = {
  temperature: 'temperature',
  topP: 'top_p',
  topK: 'top_k',
  minP: 'min_p',
  topA: 'top_a',
  repetitionPenalty: 'repetition_penalty',
  maxTokens: 'max_tokens',
  seed: 'seed',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
  reasoningEffort: 'reasoning',
  reasoningMaxTokens: 'reasoning'
}

/** Conversation settings win over project defaults, key by key. */
export function mergeParams(base: ModelParams, override: ModelParams): ModelParams {
  return { ...base, ...override }
}

/**
 * Drops anything the chosen model does not advertise.
 *
 * This matters because OpenRouter silently ignores a parameter a model does not
 * support, so sending one hopefully is indistinguishable from it working.
 */
export function filterParams(params: ModelParams, model: ModelInfo | null): ModelParams {
  if (!model) return params
  const out: ModelParams = {}
  for (const [key, needs] of Object.entries(PARAM_REQUIRES) as [keyof ModelParams, string][]) {
    if (params[key] === undefined) continue
    if (!model.supportedParameters.includes(needs)) continue
    // An effort the model does not list is sent as nothing rather than as a guess.
    if (key === 'reasoningEffort' && model.reasoning && !model.reasoning.efforts.includes(params.reasoningEffort as ReasoningEffort)) continue
    ;(out as Record<string, unknown>)[key] = params[key]
  }
  return out
}
