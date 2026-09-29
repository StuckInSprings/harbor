/**
 * What a model can actually do, said plainly.
 *
 * OpenRouter returns the capabilities as raw arrays — input_modalities,
 * supported_parameters — which are exactly the wrong shape for choosing a
 * model. The question in front of someone at the picker is "can I send it this
 * screenshot", and that was previously answerable only by picking the model,
 * attaching the image and watching the request fail.
 */

import type { ModelInfo } from './types'

export interface Capability {
  key: string
  label: string
  /** The hover text. Says what it means for using the model, not what the field is. */
  title: string
}

const MODALITY: { modality: string; label: string; title: string }[] = [
  {
    modality: 'image',
    label: 'images',
    title: 'Reads images. Screenshots and photos can be attached to a message.'
  },
  {
    modality: 'file',
    label: 'files',
    title:
      'Accepts file uploads directly. PDFs work on any model regardless, ' +
      'since OpenRouter parses them to text before they are sent.'
  },
  { modality: 'audio', label: 'audio', title: 'Accepts audio alongside text.' },
  { modality: 'video', label: 'video', title: 'Accepts video alongside text.' }
]

/** The badges for one model, in a fixed order so rows scan down the list. */
export function capabilitiesOf(m: ModelInfo): Capability[] {
  const out: Capability[] = []
  for (const { modality, label, title } of MODALITY) {
    if (m.inputModalities.includes(modality)) out.push({ key: modality, label, title })
  }
  if (m.supportsTools) {
    out.push({
      key: 'tools',
      label: 'tools',
      title: 'Can call tools, so the agent can read files and run commands with it.'
    })
  }
  if (m.supportsReasoning) {
    out.push({
      key: 'reasoning',
      label: 'thinks',
      title: 'Can reason before answering. Turn it on in the composer; the trace is shown as it arrives.'
    })
  }
  return out
}

export const readsImages = (m: ModelInfo): boolean => m.inputModalities.includes('image')

/**
 * The sampling controls the model actually honours.
 *
 * OpenRouter silently drops a parameter a model does not support, so knowing
 * this before choosing is the difference between a setting that works and one
 * that appears to.
 */
const PARAM_LABEL: Record<string, string> = {
  temperature: 'temperature',
  top_p: 'top p',
  top_k: 'top k',
  min_p: 'min p',
  top_a: 'top a',
  max_tokens: 'reply limit',
  seed: 'seed',
  frequency_penalty: 'frequency penalty',
  presence_penalty: 'presence penalty',
  repetition_penalty: 'repetition penalty',
  stop: 'stop sequences',
  response_format: 'JSON mode',
  structured_outputs: 'structured outputs',
  logit_bias: 'logit bias',
  logprobs: 'logprobs',
  tool_choice: 'tool choice'
}

export function knobsOf(m: ModelInfo): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of m.supportedParameters) {
    const label = PARAM_LABEL[p]
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push(label)
  }
  return out
}

/**
 * One sentence of the model's own description.
 *
 * OpenRouter's descriptions run to several paragraphs of marketing, and the
 * first sentence is nearly always the only part that says what the model is.
 */
export function summarise(description: string, max = 240): string {
  const text = description.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.length <= max) return text
  const stop = text.lastIndexOf('. ', max)
  if (stop > 60) return text.slice(0, stop + 1)
  return `${text.slice(0, max).trimEnd()}…`
}

/*
  Who caches without being asked, and who needs explicit cache_control
  breakpoints. Straight from OpenRouter's prompt-caching documentation — the
  distinction matters because on an explicit provider, caching simply does not
  happen unless the request marks a breakpoint.
*/
export const AUTOMATIC_CACHE = ['openai/', 'deepseek/', 'x-ai/', 'moonshotai/', 'groq/', 'z-ai/']
export const EXPLICIT_CACHE = ['anthropic/', 'qwen/', 'google/']
/** Whether a model needs the request to mark a breakpoint for caching to happen at all. */
export const needsCacheBreakpoint = (modelId: string): boolean => EXPLICIT_CACHE.some((p) => modelId.startsWith(p))
