import { useMemo, useState } from 'react'
import type { ModelInfo } from '../../shared/types'
import { formatPrice, formatTokens } from '../lib/format'
import { capabilitiesOf, knobsOf, readsImages, summarise } from '../../shared/models'
import { ChevronDown, ChevronRight, Refresh, Star } from './Icons'
import { Sheet } from './Sheet'

interface Props {
  models: ModelInfo[]
  favorites: string[]
  current: string | null
  loading: boolean
  error: string | null
  onPick: (modelId: string) => void
  onToggleFavorite: (modelId: string) => void
  onRefresh: () => void
  onClose: () => void
}

export function ModelPicker({
  models,
  favorites,
  current,
  loading,
  error,
  onPick,
  onToggleFavorite,
  onRefresh,
  onClose
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [toolsOnly, setToolsOnly] = useState(false)
  const [imagesOnly, setImagesOnly] = useState(false)
  const [thinksOnly, setThinksOnly] = useState(false)
  const [freeOnly, setFreeOnly] = useState(false)
  /** Which row has its details open. One at a time; the list stays scannable. */
  const [openId, setOpenId] = useState<string | null>(null)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = models.filter((m) => {
      if (toolsOnly && !m.supportsTools) return false
      if (imagesOnly && !readsImages(m)) return false
      if (thinksOnly && !m.supportsReasoning) return false
      if (freeOnly && m.promptPrice > 0) return false
      if (!q) return true
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    })
    // Favorites first, then alphabetical — the order stays stable while you type.
    return matched.sort((a, b) => {
      const fa = favorites.includes(a.id) ? 0 : 1
      const fb = favorites.includes(b.id) ? 0 : 1
      return fa - fb || a.name.localeCompare(b.name)
    })
  }, [models, favorites, query, toolsOnly, imagesOnly, thinksOnly, freeOnly])

  return (
    <Sheet
      title="Choose a model"
      panel="sheet__panel--picker"
      onClose={onClose}
      aside={
        // The count follows the filters, so an empty result is explained.
        <span className="sounding">
          {shown.length === models.length ? `${models.length} available` : `${shown.length} of ${models.length}`}
        </span>
      }
      actions={
        <button className="icon-btn" onClick={onRefresh} title="Reload from OpenRouter" aria-label="Reload from OpenRouter">
          <Refresh />
        </button>
      }
    >

        <div className="picker__search">
          <input
            className="input input--mono"
            autoFocus
            placeholder="Search models"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="picker__filters">
          <button className="chip" aria-pressed={toolsOnly} onClick={() => setToolsOnly((v) => !v)}>
            Supports tools
          </button>
          <button
            className="chip"
            aria-pressed={imagesOnly}
            onClick={() => setImagesOnly((v) => !v)}
          >
            Reads images
          </button>
          <button
            className="chip"
            aria-pressed={thinksOnly}
            onClick={() => setThinksOnly((v) => !v)}
          >
            Reasons
          </button>
          <button className="chip" aria-pressed={freeOnly} onClick={() => setFreeOnly((v) => !v)}>
            Free
          </button>
        </div>

        <div className="sheet__body" style={{ paddingTop: 0 }}>
          {loading && <p className="hint">Loading models…</p>}
          {error && <div className="note note--bad">{error}</div>}
          {!loading && !error && shown.length === 0 && (
            <p className="hint">No models match that search.</p>
          )}

          {shown.map((m) => {
            const caps = capabilitiesOf(m)
            const open = openId === m.id
            const blurb = summarise(m.description)
            const knobs = knobsOf(m)

            return (
              /*
                Three separate controls, not one button with clickable things
                inside it: picking, favouriting and reading the detail are
                different acts, and only real buttons are reachable by keyboard.
              */
              <div className="model" key={m.id} aria-current={m.id === current}>
                <div className="model__row">
                  <button
                    className="star"
                    data-on={favorites.includes(m.id)}
                    aria-pressed={favorites.includes(m.id)}
                    title={favorites.includes(m.id) ? 'Remove from favourites' : 'Favourite'}
                    onClick={() => onToggleFavorite(m.id)}
                   aria-label={favorites.includes(m.id) ? 'Remove from favourites' : 'Favourite'}>
                    <Star size={14} />
                  </button>

                  <button className="model__pick" onClick={() => onPick(m.id)}>
                    <span className="model__name">
                      <span className="model__title">{m.name}</span>
                      <span className="model__id">{m.id}</span>
                    </span>

                    <span className="model__meta">
                      <span className="model__caps">
                        {/* What it can be given, and what it can do with it. */}
                        {caps.map((c) => (
                          <span className="row__badge" key={c.key} title={c.title}>
                            {c.label}
                          </span>
                        ))}

                      {/*
                        A model whose price doubles past a prompt threshold is a real
                        budgeting fact, so it is on the row rather than buried.
                      */}
                      {m.tiers.length > 0 && (
                        <span
                          className="row__badge row__badge--warn"
                          title={m.tiers
                            .map(
                              (t) =>
                                `Above ${formatTokens(t.minPromptTokens)} prompt tokens: ` +
                                `${formatPrice(t.promptPrice)}/${formatPrice(t.completionPrice)} per million`
                            )
                            .join('\n')}
                        >
                          tiered
                        </span>
                      )}
                      </span>

                      <span className="sounding" title="Context window">
                        {formatTokens(m.contextLength)}
                      </span>

                      <span className="sounding" title="per million tokens, in / out">
                        {formatPrice(m.promptPrice)}/{formatPrice(m.completionPrice)}
                      </span>

                      {m.cacheReadPrice !== null && (
                        <span
                          className="sounding model__cache"
                          data-explicit={m.caching === 'explicit'}
                          title={
                            m.caching === 'explicit'
                              ? `Cached reads cost ${formatPrice(m.cacheReadPrice)} per million, but this provider only caches where the request sets an explicit breakpoint.`
                              : `Cached reads cost ${formatPrice(m.cacheReadPrice)} per million, applied automatically.`
                          }
                        >
                          ⌁{formatPrice(m.cacheReadPrice)}
                        </span>
                      )}
                    </span>
                  </button>

                  <button
                    className="model__more"
                    aria-expanded={open}
                    aria-label={`Details for ${m.name}`}
                    onClick={() => setOpenId(open ? null : m.id)}
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                </div>

                {open && (
                  <div className="model__detail">
                    {blurb && <p className="model__blurb">{blurb}</p>}
                    <dl className="model__facts">
                      <dt className="sounding">Context</dt>
                      <dd>{m.contextLength.toLocaleString()} tokens</dd>
                      <dt className="sounding">Reply limit</dt>
                      <dd>
                        {m.maxCompletionTokens
                          ? `${m.maxCompletionTokens.toLocaleString()} tokens`
                          : 'not published'}
                      </dd>
                      <dt className="sounding">Accepts</dt>
                      <dd>{m.inputModalities.join(', ')}</dd>
                      <dt className="sounding">Caching</dt>
                      <dd>
                        {m.caching === 'none'
                          ? 'none offered'
                          : m.caching === 'automatic'
                            ? 'automatic'
                            : 'on explicit breakpoints'}
                      </dd>
                      {/*
                        OpenRouter drops a parameter a model does not support
                        without saying so, which makes a setting that does
                        nothing look like one that works. This is the list
                        Parameters offers, and why.
                      */}
                      <dt className="sounding">Honours</dt>
                      <dd>{knobs.length ? knobs.join(', ') : 'nothing beyond the prompt'}</dd>
                    </dl>
                  </div>
                )}
              </div>
            )
          })}
        </div>
    </Sheet>
  )
}
