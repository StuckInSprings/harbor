/**
 * Sampler presets.
 *
 * Open-weight models are tuned by their samplers more than by anything else
 * in the request, and the values that make one write well are not the values
 * that make it answer precisely. A preset is a named set of those values:
 * four built in as starting points, and whatever the person saves.
 *
 * A preset covers the samplers only. The reply limit, the seed and the
 * reasoning settings are about the request, not the voice, and are left as
 * they were when one is applied.
 */

import type { ModelParams } from './types'

export interface Preset {
  name: string
  params: ModelParams
  /** Built in; cannot be removed. */
  builtIn?: boolean
}

export const SAMPLER_KEYS: (keyof ModelParams)[] = [
  'temperature',
  'topP',
  'topK',
  'minP',
  'topA',
  'repetitionPenalty',
  'frequencyPenalty',
  'presencePenalty'
]

export const BUILT_IN: Preset[] = [
  { name: 'precise', builtIn: true, params: { temperature: 0.2, topP: 0.9 } },
  { name: 'balanced', builtIn: true, params: { temperature: 0.7, topP: 0.95, minP: 0.05 } },
  {
    name: 'prose',
    builtIn: true,
    params: { temperature: 1.05, minP: 0.05, repetitionPenalty: 1.05 }
  },
  {
    name: 'dialogue',
    builtIn: true,
    params: { temperature: 0.9, minP: 0.08, repetitionPenalty: 1.1, presencePenalty: 0.3 }
  }
]

/** The stored setting: the person's own presets, in the order they were saved. */
export const PRESETS_SETTING = 'param_presets'

export function parsePresets(raw: string | null | undefined): Preset[] {
  if (!raw) return []
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const out: Preset[] = []
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const { name, params } = p as Record<string, unknown>
    if (typeof name !== 'string' || !name.trim()) continue
    if (!params || typeof params !== 'object' || Array.isArray(params)) continue
    out.push({ name: name.trim(), params: samplersOf(params as ModelParams) })
  }
  return out
}

export const serialisePresets = (list: Preset[]): string =>
  JSON.stringify(list.filter((p) => !p.builtIn).map((p) => ({ name: p.name, params: p.params })))

/** Just the sampler keys, with numbers only. */
export function samplersOf(params: ModelParams): ModelParams {
  const out: ModelParams = {}
  for (const key of SAMPLER_KEYS) {
    const v = params[key]
    if (typeof v === 'number' && Number.isFinite(v)) (out as Record<string, unknown>)[key] = v
  }
  return out
}

/** The preset's samplers over the current settings, everything else untouched. */
export function applyPreset(own: ModelParams, preset: Preset): ModelParams {
  const next: ModelParams = { ...own }
  for (const key of SAMPLER_KEYS) delete next[key]
  return { ...next, ...preset.params }
}

/** Whether the current samplers are exactly this preset's. */
export function matchesPreset(own: ModelParams, preset: Preset): boolean {
  const mine = samplersOf(own)
  const theirs = samplersOf(preset.params)
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)])
  for (const k of keys) {
    if ((mine as Record<string, unknown>)[k] !== (theirs as Record<string, unknown>)[k]) return false
  }
  return true
}

/** Adds or replaces by name. Built-in names are taken. */
export function savePreset(list: Preset[], name: string, params: ModelParams): Preset[] | { error: string } {
  const clean = name.trim()
  if (!clean) return { error: 'A preset needs a name.' }
  if (BUILT_IN.some((b) => b.name.toLowerCase() === clean.toLowerCase())) {
    return { error: `${clean} is a built-in preset. Pick another name.` }
  }
  const params_ = samplersOf(params)
  if (Object.keys(params_).length === 0) return { error: 'Nothing is set, so there is nothing to save.' }
  const without = list.filter((p) => p.name.toLowerCase() !== clean.toLowerCase())
  return [...without, { name: clean, params: params_ }]
}
