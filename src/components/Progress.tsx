import { useState } from 'react'

import { Check, ChevronDown, ChevronRight } from './Icons'

/**
 * The agent's checklist, in the panel rather than the chat. It rewrites
 * itself every few seconds while a run is on, which is why it never lived in
 * the transcript; and it is worth keeping after the run ends, since what got
 * done is the shortest account of the turn. Folds away with a click.
 */
export interface ProgressItem {
  content: string
  status: 'pending' | 'active' | 'done' | 'blocked'
}

export function Progress({ items, live }: { items: ProgressItem[]; live: boolean }): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  if (items.length === 0) return null
  const done = items.filter((t) => t.status === 'done').length
  // What waits on the person comes first, apart, since it is the one thing they can move.
  const waiting = items.filter((t) => t.status === 'blocked')
  const rest = items.filter((t) => t.status !== 'blocked')
  return (
    <section className="progress" data-live={live}>
      <button className="progress__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="progress__title">Progress</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="progress__count sounding">
          {done} of {items.length}
        </span>
      </button>
      {open && waiting.length > 0 && (
        <>
          <div className="progress__sub">Waiting on you</div>
          <ul className="progress__list">
            {waiting.map((t, i) => (
              <li className="progress__item" data-status="blocked" key={`w${i}-${t.content}`}>
                <span className="progress__mark" aria-hidden="true">!</span>
                <span className="progress__text">{t.content}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && (
        <ul className="progress__list">
          {rest.map((t, i) => (
            <li className="progress__item" data-status={t.status} key={`${i}-${t.content}`}>
              <span className="progress__mark" aria-hidden="true">
                {t.status === 'done' && <Check size={11} />}
              </span>
              <span className="progress__text">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
