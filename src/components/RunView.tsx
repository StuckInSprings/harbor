import { Fragment, useEffect, useState } from 'react'
import type { RunWorker, Task } from '../../shared/director'
import { BUDGET_RESERVE } from '../../shared/director'
import { Markdown } from './Markdown'
import { formatMoney } from '../lib/format'
import type { Review } from '../../shared/bridge'

/**
 * A director-led project, seen whole rather than as a chat: where the
 * money stands, the board with who holds each task, the workers running
 * now with their last line, what waits on the person, and the director's
 * latest word. Opening a task opens its worker's conversation, which
 * streams live from that moment.
 *
 * When Claude oversees the run through the bridge, its reviews are here
 * too: a verdict, a summary, and suggestions the person takes to the
 * director (into the box, to read and change before sending) or puts aside.
 */
export function RunView({
  status,
  board,
  workers,
  running,
  asking,
  directorBusy,
  lastMessage,
  onOpenWorker,
  onApprove,
  onFinish,
  reviews,
  onTakeSuggestion,
  onDismissSuggestion,
  onAnswer
}: {
  status: { budget: number; approved: boolean; spent: number; branch: string | null; base: string | null } | null
  board: Task[]
  workers: RunWorker[]
  running: Set<string>
  /** Workers waiting on the person, with the question each asked. */
  asking: Map<string, string>
  directorBusy: boolean
  lastMessage: string
  onOpenWorker: (id: string) => void
  onApprove: () => void
  onFinish: () => void
  reviews: Review[]
  onTakeSuggestion: (reviewId: string, index: number, text: string) => void
  onDismissSuggestion: (reviewId: string, index: number) => void
  /** Start an answer to a blocked item: its id and title into the box, and the caret there. */
  onAnswer: (task: Task) => void
}): React.JSX.Element {
  // Board rows opened to show what is under them; a blocked item's questions show without asking.
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const toggle = (id: string): void =>
    setOpened((set) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (running.size === 0) return
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [running.size])

  const budget = status?.budget ?? 0
  const spent = status?.spent ?? 0
  const share = budget > 0 ? Math.min(1, spent / budget) : 0
  const byTask = new Map<string, RunWorker[]>()
  for (const w of workers) byTask.set(w.taskId, [...(byTask.get(w.taskId) ?? []), w])
  const live = workers.filter((w) => running.has(w.id))
  const waiting = board.filter((t) => t.status === 'blocked')
  const done = board.filter((t) => t.status === 'done').length
  const elapsed = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`)

  return (
    <div className="run-view">
      <div className="run-view__inner">
        <section className="run-view__money">
          <div className="run-view__bar" title={budget > 0 ? `Workers stop at ${Math.round((1 - BUDGET_RESERVE) * 100)}%; the rest is the director's` : 'No ceiling'}>
            <span className="run-view__fill" style={{ width: `${share * 100}%` }} />
            {budget > 0 && <span className="run-view__reserve" style={{ left: `${(1 - BUDGET_RESERVE) * 100}%` }} />}
          </div>
          <div className="run-view__moneyline">
            <span>
              {formatMoney(spent)} {budget > 0 ? `of ${formatMoney(budget)}` : 'spent, no ceiling'}
            </span>
            <span className="sounding">
              {done} of {board.length} done · {live.length} running
              {status?.branch ? ` · ${status.branch}` : status?.base ? ` · from ${status.base}` : ''}
            </span>
            {status && !status.approved && board.length > 0 && (
              <button className="btn btn--small btn--primary" onClick={onApprove}>
                Approve plan
              </button>
            )}
            {status?.approved && (
              <button className="btn btn--small" disabled={directorBusy || live.length > 0} onClick={onFinish} title="Write the run log and archive the workers">
                Finish run
              </button>
            )}
          </div>
        </section>

        {waiting.length > 0 && (
          <section className="run-view__section" id="run-waiting" aria-label="Waiting on you">
            <h3 className="run-view__h run-view__h--warn">
              Waiting on you · {waiting.length}
            </h3>
            <ul className="run-view__list">
              {waiting.map((t) => (
                <li key={t.id} className="run-view__waiting">
                  <div className="run-view__whead">
                    <span>
                      <span className="run-view__id">{t.id}</span> {t.title}
                    </span>
                    <button className="btn btn--small btn--primary" onClick={() => onAnswer(t)} title={`Start a reply to ${t.id} in the box below`}>
                      Answer
                    </button>
                  </div>
                  {t.detail && (
                    <div className="prose run-view__detail">
                      <Markdown text={t.detail} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="sounding">
              Answer one, several, or say one can wait; the director reads your reply on its next turn and marks the board.
            </p>
          </section>
        )}

        {reviews.length > 0 && (
          <section className="run-view__section" aria-label="Claude's review">
            <h3 className="run-view__h">Claude's review</h3>
            <ReviewCard review={reviews[0]} onTake={onTakeSuggestion} onDismiss={onDismissSuggestion} />
            {reviews.length > 1 && (
              <details className="run-view__earlier">
                <summary className="sounding">
                  {reviews.length - 1} earlier review{reviews.length === 2 ? '' : 's'}
                </summary>
                {reviews.slice(1).map((r) => (
                  <ReviewCard key={r.id} review={r} onTake={onTakeSuggestion} onDismiss={onDismissSuggestion} />
                ))}
              </details>
            )}
          </section>
        )}

        {live.length > 0 && (
          <section className="run-view__section">
            <h3 className="run-view__h">Running now</h3>
            <ul className="run-view__list">
              {live.map((w) => (
                <li key={w.id} className="run-view__worker" onClick={() => onOpenWorker(w.id)} title="Open this worker; it streams live">
                  <span className="row__spinner" />
                  <span className="run-view__id">{w.taskId}</span>
                  <span className="run-view__wtitle">{w.title}</span>
                  <span className="sounding">
                    {elapsed(now - w.createdAt)} · {w.steps} steps · {formatMoney(w.cost)}
                  </span>
                  {asking.has(w.id) ? (
                    <span className="run-view__last" style={{ color: 'var(--beacon)' }}>Asks you: {asking.get(w.id)}</span>
                  ) : (
                    w.lastLine && <span className="run-view__last">{w.lastLine}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="run-view__section">
          <h3 className="run-view__h">Board</h3>
          {board.length === 0 ? (
            <p className="sounding">{status?.approved ? 'No board yet.' : 'The director writes the board when it has read the requirements.'}</p>
          ) : (
            <table className="run-view__table">
              <thead>
                <tr>
                  <th></th>
                  <th>task</th>
                  <th>worker</th>
                  <th>cost</th>
                  <th>last</th>
                </tr>
              </thead>
              <tbody>
                {board.map((t) => {
                  const ws = byTask.get(t.id) ?? []
                  const w = ws[ws.length - 1]
                  const shown = opened.has(t.id)
                  return (
                    <Fragment key={t.id}>
                    <tr data-status={t.status} className={w || t.detail ? 'run-view__row--open' : ''} onClick={() => (w ? onOpenWorker(w.id) : t.detail && toggle(t.id))}>
                      <td className="run-view__mark" aria-label={t.status}>
                        {t.status === 'done' ? '✓' : t.status === 'active' ? '…' : t.status === 'blocked' ? '!' : ''}
                      </td>
                      <td>
                        {t.detail && (
                          <button
                            className="run-view__disclose"
                            aria-expanded={shown}
                            aria-label={shown ? `Hide what is under ${t.id}` : `Show what is under ${t.id}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggle(t.id)
                            }}
                          >
                            {shown ? '▾' : '▸'}
                          </button>
                        )}
                        <span className="run-view__id">{t.id}</span> {t.title}
                      </td>
                      <td className="sounding">
                        {w ? `${w.model.split('/').pop()}${ws.length > 1 ? ` · attempt ${ws.length}` : ''}${asking.has(w.id) ? ' · waiting on you' : running.has(w.id) ? ' · running' : w.stopped ? ' · stopped' : ''}` : ''}
                      </td>
                      <td className="sounding">{ws.length ? `${formatMoney(ws.reduce((n, x) => n + x.cost, 0))}` : ''}</td>
                      <td className="run-view__last">{w?.lastLine ?? ''}</td>
                    </tr>
                    {shown && t.detail && (
                      <tr className="run-view__detailrow">
                        <td></td>
                        <td colSpan={4}>
                          <div className="prose run-view__detail">
                            <Markdown text={t.detail} />
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        {lastMessage.trim() && (
          <section className="run-view__section">
            <h3 className="run-view__h">The director, last</h3>
            <div className="prose run-view__prose">
              <Markdown text={lastMessage} />
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

/* One review: the verdict and when, the summary, and each suggestion with what the person did with it. */
function ReviewCard({ review, onTake, onDismiss }: { review: Review; onTake: (reviewId: string, index: number, text: string) => void; onDismiss: (reviewId: string, index: number) => void }): React.JSX.Element {
  const when = new Date(review.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <div className="run-view__review" data-verdict={review.verdict}>
      <div className="run-view__verdict">
        <span className="run-view__chip">{review.verdict}</span>
        <span className="sounding">{when}</span>
      </div>
      <div className="prose">
        <Markdown text={review.summary} />
      </div>
      {review.suggestions.length > 0 && (
        <ul className="run-view__list">
          {review.suggestions.map((sg, i) => (
            <li key={i} className="run-view__suggestion" data-state={sg.state}>
              <span className="run-view__stext">
                {sg.task && <span className="run-view__id">{sg.task} </span>}
                {sg.text}
              </span>
              {sg.state === 'open' ? (
                <span className="run-view__sactions">
                  <button className="btn btn--small" onClick={() => onTake(review.id, i, sg.task ? `${sg.task}: ${sg.text}` : sg.text)} title="Put this in the director's box, to read and change before you send it">
                    Send to director
                  </button>
                  <button className="btn btn--small" onClick={() => onDismiss(review.id, i)}>
                    Dismiss
                  </button>
                </span>
              ) : (
                <span className="sounding">{sg.state === 'sent' ? 'Taken to the director' : 'Dismissed'}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
