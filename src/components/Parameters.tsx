import { useEffect, useState } from 'react'
import type { ModelInfo, ModelParams } from '../../shared/types'
import {
  BUILT_IN,
  PRESETS_SETTING,
  applyPreset,
  matchesPreset,
  parsePresets,
  savePreset,
  serialisePresets,
  type Preset
} from '../../shared/presets'
export { filterParams, mergeParams } from '../../shared/params'
import { effortsFor } from '../../shared/params'
import { api } from '../lib/api'

/**
 * Sampling controls.
 *
 * Only what the chosen model advertises is shown. OpenRouter drops an
 * unsupported parameter without complaint, so a slider for something the model
 * ignores would look exactly like one that works — which is worse than not
 * offering it.
 *
 * Every control has an unset state that inherits, rather than a default value
 * pretending to be a choice.
 */

interface Control {
  key: keyof ModelParams
  /** The name OpenRouter uses in supported_parameters. */
  needs: string
  label: string
  hint: string
  min: number
  max: number
  step: number
}

const CONTROLS: Control[] = [
  {
    key: 'temperature',
    needs: 'temperature',
    label: 'Temperature',
    hint: 'Lower is steadier, higher wanders more.',
    min: 0,
    max: 2,
    step: 0.05
  },
  {
    key: 'topP',
    needs: 'top_p',
    label: 'Top P',
    hint: 'Considers only the most likely tokens adding up to this share.',
    min: 0,
    max: 1,
    step: 0.05
  },
  {
    key: 'topK',
    needs: 'top_k',
    label: 'Top K',
    hint: 'Considers only this many candidates at each step. 0 is off.',
    min: 0,
    max: 200,
    step: 1
  },
  {
    key: 'minP',
    needs: 'min_p',
    label: 'Min P',
    hint: 'Drops any token under this share of the top one. 0.05 keeps a creative model coherent at high temperature; the sampler open-weight models are tuned around.',
    min: 0,
    max: 0.5,
    step: 0.01
  },
  {
    key: 'topA',
    needs: 'top_a',
    label: 'Top A',
    hint: 'Like min P, but the bar rises with how sure the model already is. 0 is off.',
    min: 0,
    max: 1,
    step: 0.01
  },
  {
    key: 'repetitionPenalty',
    needs: 'repetition_penalty',
    label: 'Repetition penalty',
    hint: '1 is off. 1.05 to 1.15 stops an open-weight model looping on its own phrasing; higher starts to cost it vocabulary.',
    min: 1,
    max: 1.5,
    step: 0.01
  },
  {
    key: 'frequencyPenalty',
    needs: 'frequency_penalty',
    label: 'Frequency penalty',
    hint: 'Discourages repeating the same tokens.',
    min: -2,
    max: 2,
    step: 0.1
  },
  {
    key: 'presencePenalty',
    needs: 'presence_penalty',
    label: 'Presence penalty',
    hint: 'Discourages returning to the same subjects.',
    min: -2,
    max: 2,
    step: 0.1
  }
]

interface Props {
  model: ModelInfo | null
  /** The values in force, whether set here or inherited. */
  effective: ModelParams
  /** What this level sets; a missing key means inherit. */
  own: ModelParams
  onChange: (next: ModelParams) => void
  inheritLabel: string
}

export function Parameters({
  model,
  effective,
  own,
  onChange,
  inheritLabel
}: Props): React.JSX.Element {
  const supports = (needs: string): boolean =>
    !model || model.supportedParameters.includes(needs)

  const set = (key: keyof ModelParams, value: number | string | undefined): void => {
    const next = { ...own }
    if (value === undefined || value === '') delete next[key]
    else (next as Record<string, unknown>)[key] = value
    onChange(next)
  }

  const shown = CONTROLS.filter((c) => supports(c.needs))
  const canReason = !model || model.supportsReasoning
  const efforts = effortsFor(model)
  const canMaxTokens = supports('max_tokens')
  const canSeed = supports('seed')

  /*
    Presets are the person's, kept in one setting for every project, since
    "prose" means the same thing wherever it is used. Applying one sets the
    samplers at this level and leaves the reply limit, seed and reasoning as
    they were.
  */
  const [saved, setSaved] = useState<Preset[]>([])
  const [naming, setNaming] = useState<string | null>(null)
  const [presetError, setPresetError] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      const r = await api.settings.get(PRESETS_SETTING)
      if (r.ok) setSaved(parsePresets(r.data))
    })()
  }, [])
  const persist = (list: Preset[]): void => {
    setSaved(list)
    void api.settings.set(PRESETS_SETTING, serialisePresets(list))
  }
  const presets = [...BUILT_IN, ...saved]
  const anySampler = shown.length > 0

  if (shown.length === 0 && !canReason && !canMaxTokens && !canSeed) {
    return (
      <p className="hint">
        {model?.name ?? 'This model'} takes no sampling parameters.
      </p>
    )
  }

  return (
    <div className="params">
      {anySampler && (
        <div className="param">
          <div className="param__head">
            <span className="param__label">Presets</span>
            <span className="sounding">samplers only</span>
          </div>
          <div className="presets">
            {presets.map((p) => {
              const on = matchesPreset(own, p)
              return (
                <span className="presets__item" key={p.name}>
                  <button
                    className="chip"
                    aria-pressed={on}
                    title={Object.entries(p.params)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(' · ')}
                    onClick={() => onChange(applyPreset(own, p))}
                   aria-label={Object.entries(p.params)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(' · ')}>
                    {p.name}
                  </button>
                  {!p.builtIn && (
                    <button
                      className="presets__forget"
                      title={`Forget ${p.name}`}
                      onClick={() => persist(saved.filter((s) => s.name !== p.name))}
                    >
                      ×
                    </button>
                  )}
                </span>
              )
            })}
            {naming === null ? (
              <button className="chip presets__save" onClick={() => setNaming('')}>
                save current as…
              </button>
            ) : (
              <input
                className="input presets__name"
                autoFocus
                placeholder="preset name"
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNaming(null)
                  if (e.key === 'Enter') {
                    const r = savePreset(saved, naming, own)
                    if ('error' in r) setPresetError(r.error)
                    else {
                      persist(r)
                      setNaming(null)
                      setPresetError(null)
                    }
                  }
                }}
                onBlur={() => setNaming(null)}
              />
            )}
          </div>
          <span className="param__hint">
            {presetError ??
              'Starting points for open-weight models. Prose and dialogue lean on min P and a repetition penalty, which is where those models are actually tuned.'}
          </span>
        </div>
      )}

      {shown.map((c) => {
        const isSet = own[c.key] !== undefined
        const value = (effective[c.key] as number | undefined) ?? c.min
        return (
          <div className="param" key={c.key}>
            <div className="param__head">
              <span className="param__label">{c.label}</span>
              <span className="sounding">
                {isSet ? value : `${inheritLabel}${effective[c.key] !== undefined ? ` · ${value}` : ''}`}
              </span>
              {isSet && (
                <button className="param__clear" onClick={() => set(c.key, undefined)}>
                  reset
                </button>
              )}
            </div>
            <input
              className="param__range"
              type="range"
              min={c.min}
              max={c.max}
              step={c.step}
              value={value}
              onChange={(e) => set(c.key, Number(e.target.value))}
            />
            <span className="param__hint">{c.hint}</span>
          </div>
        )
      })}

      {canMaxTokens && (
        <label className="param">
          <span className="param__label">Reply limit</span>
          <input
            className="input input--mono"
            type="number"
            min={1}
            max={model?.maxCompletionTokens ?? 200000}
            placeholder={`${inheritLabel}${effective.maxTokens ? ` · ${effective.maxTokens}` : ' · no limit'}`}
            value={own.maxTokens ?? ''}
            onChange={(e) => set('maxTokens', e.target.value === '' ? undefined : Number(e.target.value))}
          />
          <span className="param__hint">
            Caps the reply, and with it the cost of a runaway answer.
            {model?.maxCompletionTokens
              ? ` This model allows up to ${model.maxCompletionTokens.toLocaleString()}.`
              : ''}
          </span>
        </label>
      )}

      {canSeed && (
        <label className="param">
          <span className="param__label">Seed</span>
          <input
            className="input input--mono"
            type="number"
            placeholder={`${inheritLabel} · none`}
            value={own.seed ?? ''}
            onChange={(e) => set('seed', e.target.value === '' ? undefined : Number(e.target.value))}
          />
          <span className="param__hint">
            The same seed and prompt tends to give the same answer, which makes a
            comparison mean something.
          </span>
        </label>
      )}

      {canReason && efforts.length > 0 && (
        <div className="param">
          <span className="param__label">Reasoning effort</span>
          <div className="param__choices">
            {efforts.map((level) => (
              <button
                key={level}
                className="chip"
                aria-pressed={own.reasoningEffort === level}
                onClick={() =>
                  set('reasoningEffort', own.reasoningEffort === level ? undefined : level)
                }
              >
                {level}
              </button>
            ))}
          </div>
          <span className="param__hint">
            How long to think before answering, when the reasoning toggle is on.
            {model?.reasoning?.defaultEffort ? ` The model's own default is ${model.reasoning.defaultEffort}.` : ''}
            {effective.reasoningEffort && own.reasoningEffort === undefined
              ? ` ${inheritLabel}: ${effective.reasoningEffort}.`
              : ''}
          </span>
        </div>
      )}
    </div>
  )
}

