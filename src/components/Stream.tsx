import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, Citation, Message, ToolRun } from '../../shared/types'
import { Markdown } from './Markdown'
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Pencil, Refresh, Trash } from './Icons'
import { formatCost, shortModel } from '../lib/format'
import { siblingPositions } from '../lib/tree'
import { useThumbnail } from '../lib/thumbnails'
import { AttachmentChip } from './AttachmentChip'
import { ToolRow } from './ToolRow'
import { Activity } from './Activity'
import type { Activity as Turn } from '../../shared/activity'
import { compareColumns, blindOrder, replyKey, type Ratings } from '../../shared/fanout'
import { cacheLine, cacheVerdict } from '../../shared/cache'
import { api } from '../lib/api'
import { useLive } from '../lib/live'
import { splitStable } from '../lib/stream'

/** What a message row shows while its turn is still running; the text itself is read from the live store by the turn's id. */
export interface LiveView {
  requestId: string
  tools: ToolRun[]
  activity: Turn | null
}

/*
  The body of a reply as it streams: only this subscribes to the tokens,
  so a frame of streaming re-renders this and nothing above it. The text
  is cut at the last paragraph break outside a code fence; what is before
  the cut is parsed once and kept, and only the tail is parsed as it grows.
*/
function LiveBody({ requestId, thinking }: { requestId: string; thinking: boolean }): React.JSX.Element {
  const { text, reasoning } = useLive(requestId)
  const { stable, tail } = splitStable(text)
  return (
    <>
      {reasoning && <Reasoning text={reasoning} tokens={null} live={thinking} />}
      {stable && <Markdown text={stable} />}
      {tail.trim() !== '' && <Markdown text={tail} />}
    </>
  )
}

/** The waiting line for a streaming turn, with the thought it is on, read live. */
function LiveActivity({ requestId, turn, compact }: { requestId: string; turn: Turn; compact?: boolean }): React.JSX.Element {
  const { reasoning } = useLive(requestId)
  return <Activity turn={turn} reasoning={reasoning} compact={compact} />
}

/*
  Tool calls are stored as JSON on the row and read on every render of
  the transcript. Parsed once per distinct string and kept, so a row's
  calls are the same array each time and ToolRow can skip unchanged ones.
*/
const CALLS = new Map<string, ToolRun[]>()
function callsOf(raw: string): ToolRun[] {
  const hit = CALLS.get(raw)
  if (hit) return hit
  const parsed = parseCalls(raw)
  if (CALLS.size > 400) CALLS.delete(CALLS.keys().next().value as string)
  CALLS.set(raw, parsed)
  return parsed
}

/** How many of the newest messages a long transcript shows before "earlier"; the rest come on request. */
const TAIL = 60

/** Mirrors subjectOf in electron/main/tools.ts, for messages loaded from disk. */
function subjectOf(name: string, raw: string): string {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(raw || '{}')
  } catch {
    return ''
  }
  if (name === 'search') return String(args.query ?? '')
  if (name === 'run_command') return String(args.command ?? '')
  if (name === 'todo_write') return `${(args.todos as unknown[] | undefined)?.length ?? 0} items`
  return String(args.path ?? '')
}

/*
  Web results are injected server side rather than arriving as a tool call, so
  without this they would be the one context addition Harbor cannot show. The
  citations put them back on screen.
*/
function Citations({ raw }: { raw: string }): React.JSX.Element {
  let items: Citation[] = []
  try {
    items = JSON.parse(raw) as Citation[]
  } catch {
    return <></>
  }
  if (items.length === 0) return <></>

  return (
    <div className="cites">
      <div className="cites__head sounding">read from the web</div>
      {items.map((c, i) => (
        <button
          key={c.url}
          className="cites__row"
          onClick={() => void api.openExternal(c.url)}
          title={c.url}
         aria-label={c.url}>
          <span className="cites__n sounding">{i + 1}</span>
          <span className="cites__title">{c.title}</span>
          <span className="cites__host sounding">{hostOf(c.url)}</span>
        </button>
      ))}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/*
  Reasoning is shown but folded away. It is often longer than the answer, and
  it is not the answer — but hiding it entirely would leave you paying for
  tokens you can never see.
*/
function Reasoning({
  text,
  tokens,
  live = false
}: {
  text: string
  tokens: number | null
  /** Still arriving, so it is offered in the present tense and can be watched. */
  live?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="tools">
      <button className="tools__head" onClick={() => setOpen((v) => !v)}>
        <span className="tools__chevron">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="tools__label">
          {live ? 'Thinking' : `Thought${tokens ? ` for ${tokens} tokens` : ''}`}
        </span>
        {live && <span className="tools__spinner" aria-label="thinking" />}
      </button>
      {open && <pre className="tools__pre reasoning">{text}</pre>}
    </div>
  )
}

/** What a side question needs from the app: the answer, from the reply's own model, kept nowhere. */
export type AskAside = (messageId: string, question: string) => Promise<{ content: string; cost: number; model: string }>

/**
 * A question about one reply, asked beside it. The answer is shown under
 * the reply and is not a message: the conversation the model sees is not
 * one token longer for it. For "is this consistent with the brief" and
 * "what did it leave out" — the questions that used to cost a turn.
 */
function Aside({ messageId, ask, onClose }: { messageId: string; ask: AskAside; onClose: () => void }): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<{ content: string; cost: number; model: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const go = async (): Promise<void> => {
    if (!question.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      setAnswer(await ask(messageId, question))
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }
  return (
    <div className="aside">
      <div className="aside__ask">
        <input
          className="aside__input"
          placeholder="Ask about this reply; the answer stays out of the conversation"
          value={question}
          disabled={busy}
          autoFocus
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void go()
            if (e.key === 'Escape') onClose()
          }}
        />
        <button className="btn" disabled={busy || !question.trim()} onClick={() => void go()}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <div className="msg__error">{error}</div>}
      {answer && (
        <div className="aside__answer">
          <Markdown text={answer.content} />
          <div className="sounding">
            {shortModel(answer.model)} · {formatCost(answer.cost)} · not kept in the conversation
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Replies side by side. Each column is one reply under the same user
 * message — from a fan-out, or from retries — streaming if it still is,
 * with a way to carry on from it. Picking one is only a leaf move: the
 * others stay where they are, reachable with the switcher.
 *
 * Blind, the names come off and the columns are shuffled, so the vote is
 * for the words; the vote reveals them, and the project's ratings move.
 */
function Compare({
  parentId,
  columns,
  live,
  results,
  ratings,
  onPick,
  onVote,
  onAside,
  onClose
}: {
  parentId: string
  columns: Message[]
  live: Record<string, LiveView>
  results: Map<string, Message>
  ratings: Ratings
  onPick: (id: string) => void
  onVote: (id: string) => void
  onAside: AskAside
  onClose: () => void
}): React.JSX.Element {
  const [blind, setBlind] = useState(false)
  const [voted, setVoted] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  const shown = blind ? blindOrder(columns, parentId) : columns
  const done = columns.every((m) => !live[m.id])
  const letter = (i: number): string => String.fromCharCode(65 + i)
  return (
    <section className="compare">
      <div className="compare__head">
        <span className="sounding">
          {columns.length} replies, side by side
          {voted ? ' · voted' : ''}
        </span>
        <span className="compare__tools">
          {done && !voted && columns.length > 1 && (
            <button className="btn" onClick={() => setBlind((b) => !b)} title="Hide who wrote which, and vote for the best; the vote moves the project's ratings" aria-label="Hide who wrote which, and vote for the best; the vote moves the project's ratings">
              {blind ? 'Show names' : 'Judge blind'}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      <div
        className="compare__grid"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` }}
      >
        {shown.map((m, i) => {
          const view = live[m.id]
          const body = m.content
          const rating = ratings[replyKey(m)]
          return (
            <div className="compare__col" key={m.id} data-winner={voted === m.id || undefined}>
              <div className="compare__model">
                <span>
                  {blind ? `Reply ${letter(i)}` : m.model ? shortModel(m.model) : 'reply'}
                  {!blind && m.label && <span className="compare__label"> {m.label}</span>}
                </span>
                {!blind && !view && (
                  <span className="sounding">
                    {rating && `${Math.round(rating.rating)} after ${rating.games} · `}
                    {m.cost !== null && formatCost(m.cost)}
                  </span>
                )}
              </div>
              <div className="compare__body">
                {m.error ? (
                  <div className="msg__error">{m.error}</div>
                ) : (
                  <>
                    {view ? (
                      <LiveBody requestId={view.requestId} thinking={view.activity?.phase === 'thinking'} />
                    ) : (
                      <>
                        {m.reasoning && <Reasoning text={m.reasoning} tokens={m.reasoningTokens} />}
                        {body.trim() !== '' && <Markdown text={body} />}
                      </>
                    )}
                    {m.toolCalls && !view && (
                      <ToolRow calls={callsOf(m.toolCalls)} results={results} running={false} />
                    )}
                    {view && view.tools.length > 0 && (
                      <ToolRow calls={view.tools} results={results} running />
                    )}
                    {view && view.activity && view.activity.phase !== 'writing' && (
                      <LiveActivity requestId={view.requestId} turn={view.activity} compact={view.tools.length > 0} />
                    )}
                    {view && view.activity?.phase === 'writing' && <span className="cursor" />}
                  </>
                )}
              </div>
              {!view && (
                <div className="compare__actions">
                  {blind && !voted ? (
                    <button
                      className="btn btn--primary"
                      onClick={() => {
                        setVoted(m.id)
                        setBlind(false)
                        onVote(m.id)
                      }}
                      title="This one beat the others"
                    >
                      Best
                    </button>
                  ) : (
                    <button className="btn compare__pick" onClick={() => onPick(m.id)}>
                      Continue from this one
                    </button>
                  )}
                  {!blind && (
                    <button className="btn" onClick={() => setAsking((id) => (id === m.id ? null : m.id))} title="A question about this reply, answered beside it and kept out of the conversation">
                      Ask about it
                    </button>
                  )}
                </div>
              )}
              {asking === m.id && !blind && <Aside messageId={m.id} ask={onAside} onClose={() => setAsking(null)} />}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Images render inline; everything else is named so you know what was sent. */
function Attachments({ raw }: { raw: string }): React.JSX.Element {
  let items: Attachment[] = []
  try {
    items = JSON.parse(raw) as Attachment[]
  } catch {
    return <></>
  }
  if (items.length === 0) return <></>

  return (
    <div className="msg__atts">
      {items.map((a) => (
        <SentAttachment key={a.hash} attachment={a} />
      ))}
    </div>
  )
}

/** Larger than the composer chip, since here it is the content, not a label. */
function SentAttachment({ attachment }: { attachment: Attachment }): React.JSX.Element {
  const url = useThumbnail(attachment)
  if (attachment.kind === 'image') {
    return url ? (
      <img className="msg__img" src={url} alt={attachment.name} title={attachment.name} />
    ) : (
      <span className="thumb__loading msg__img" />
    )
  }
  return <AttachmentChip attachment={attachment} />
}

function parseCalls(raw: string): ToolRun[] {
  try {
    const list = JSON.parse(raw) as {
      id: string
      function: { name: string; arguments: string }
    }[]
    return list.map((c) => ({
      callId: c.id,
      name: c.function.name,
      subject: subjectOf(c.function.name, c.function.arguments),
      args: c.function.arguments
    }))
  } catch {
    return []
  }
}

interface Props {
  /** Every message in the conversation — needed to reason about branches. */
  /** Changes when a different conversation is opened. */
  conversationId: string | null
  all: Message[]
  /** The root-to-leaf path actually on screen. */
  path: Message[]
  /** Turns still running in this conversation, by the message they stream into. */
  live: Record<string, LiveView>
  /** Turns that have not opened a message yet: a waiting line each. */
  pending: Turn[]
  /** The user message whose replies are laid out side by side, if any. */
  compareParent: string | null
  onCompare: (parentId: string | null) => void
  /** Continue from one of the compared replies. */
  onPickBranch: (messageId: string) => void
  onDelete: (id: string) => void
  onEdit: (id: string, text: string) => void
  onRetry: (id: string) => void
  onSwitch: (m: Message, direction: -1 | 1) => void
  onRemember: (text: string) => void
  /** From a compaction summary back to the branch it replaced. */
  onOpenOriginal: (leafId: string) => void
  /** The project's ratings from blind votes, by model and variant. */
  ratings: Ratings
  onVote: (messageId: string) => void
  onAside: AskAside
}

function StreamView({
  conversationId,
  all,
  path,
  live,
  pending,
  compareParent,
  onCompare,
  onPickBranch,
  onDelete,
  onEdit,
  onRetry,
  onSwitch,
  onRemember,
  onOpenOriginal,
  ratings,
  onVote,
  onAside
}: Props): React.JSX.Element {
  const [asideFor, setAsideFor] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  // Follow a streaming reply only while the reader is already at the bottom, so
  // scrolling back to read something earlier does not get yanked away.
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = near
    setAtBottom(near)
  }

  /*
    Coalesced into one frame. A fast stream fires this per token, and setting
    scrollTop directly avoids the layout work scrollIntoView does each time.
  */
  const follow = useCallback((force = false) => {
    if (!stick.current && !force) return
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const el = scroller.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  /*
    Opening a conversation starts at its latest message. Without resetting,
    having scrolled up in the previous one would leave the next opening at the
    top, which reads as the wrong conversation.
  */
  useEffect(() => {
    stick.current = true
    setAtBottom(true)
    follow(true)
  }, [conversationId, follow])

  /*
    liveTools belongs here: during a tool-heavy run the transcript grows with
    no new message and no streamed text, and without it the view would sit
    still exactly when there is most to watch.
  */
  useEffect(() => {
    follow()
  }, [path.length, live, pending.length, follow])

  /*
    The messages of a conversation just opened arrive after the switch, and
    they keep growing after they render: markdown lays out, code highlights,
    images load. Scrolling once lands above the bottom. So whenever the
    content changes size and the reader has not scrolled away, the view
    follows it down; a scroll up by the reader is what lets it go.
  */
  useEffect(() => {
    const el = inner.current
    if (!el) return
    const ro = new ResizeObserver(() => follow())
    ro.observe(el)
    return () => ro.disconnect()
  }, [follow])

  const toBottom = (): void => {
    stick.current = true
    setAtBottom(true)
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }

  /*
    The message menu lives here because editing state does. Native menu, so the
    action comes back as a string.
  */
  const menu = async (m: Message): Promise<void> => {
    const r = await api.menu.show('message', { role: m.role })
    if (!r.ok || !r.data) return
    if (r.data === 'copy') await navigator.clipboard.writeText(m.content)
    else if (r.data === 'edit') beginEdit(m)
    else if (r.data === 'retry') onRetry(m.id)
    else if (r.data === 'remember') onRemember(m.content)
    else if (r.data === 'delete') onDelete(m.id)
  }

  const beginEdit = (m: Message): void => {
    setEditingId(m.id)
    setEditText(m.content)
  }

  const commitEdit = (): void => {
    if (editingId && editText.trim()) onEdit(editingId, editText.trim())
    setEditingId(null)
  }

  // Tool results are folded into the row of the call that produced them.
  // Every branch is indexed, since a comparison shows replies off the path.
  // Both indexes are per transcript, not per render: a render is every frame while a reply streams.
  const toolResults = useMemo(() => {
    const map = new Map<string, Message>()
    for (const m of all) if (m.role === 'tool' && m.toolCallId) map.set(m.toolCallId, m)
    return map
  }, [all])
  const positions = useMemo(() => siblingPositions(all), [all])
  // For each reply, the reply before it on the path and what sits between: what the cache line reasons from.
  const prevReplies = useMemo(() => {
    const map = new Map<string, { prev: Message | null; between: Message[] }>()
    let prev: Message | null = null
    let between: Message[] = []
    for (const m of path) {
      if (m.role === 'assistant' && !m.error) {
        map.set(m.id, { prev, between })
        prev = m
        between = []
      } else between.push(m)
    }
    return map
  }, [path])
  const onPath = useMemo(() => path.filter((m) => m.role !== 'tool'), [path])

  /*
    In a comparison the path is cut at the replies being compared: below that
    point the branches disagree, so only one could be shown, and showing it
    would quietly pick a winner.
  */
  const cut = compareParent
    ? onPath.findIndex((m) => m.parentId === compareParent && m.role === 'assistant')
    : -1
  const onScreen = cut === -1 ? onPath : onPath.slice(0, cut)
  /*
    A long transcript is shown from its tail. Every message used to be
    mounted, and a conversation of a few hundred replies was thousands of
    nodes laid out for a scroll nobody was at. The earlier ones come back
    in pages, on request; a new conversation starts over.
  */
  const [earlier, setEarlier] = useState(0)
  useEffect(() => setEarlier(0), [conversationId])
  const hidden = Math.max(0, onScreen.length - TAIL - earlier)
  const visible = hidden > 20 ? onScreen.slice(hidden) : onScreen
  const held = hidden > 20 ? hidden : 0
  const columns = compareParent ? compareColumns(all, compareParent) : []

  return (
    <div className="stream-wrap">
      <div className="stream" ref={scroller} onScroll={onScroll}>
        <div className="stream__inner" ref={inner}>
          {held > 0 && (
            <button className="stream__earlier" onClick={() => setEarlier((n) => n + 100)}>
              Show {Math.min(held, 100)} earlier {Math.min(held, 100) === 1 ? 'message' : 'messages'} · {held} above
            </button>
          )}
          {visible.map((m) => {
            const view = live[m.id]
            const isStreaming = view !== undefined
            const body = m.content
            const activity = view?.activity ?? null
            const liveTools = view?.tools ?? []
            const { index, count } = positions.get(m.id) ?? { index: 1, count: 1 }
            const editing = editingId === m.id
            const cache = m.role === 'assistant' ? cacheVerdict(m, prevReplies.get(m.id)?.prev ?? null, prevReplies.get(m.id)?.between ?? []) : null

            // A run of tool-only steps is one sequence, so they sit close together.
            const toolsOnly = m.role === 'assistant' && !!m.toolCalls && m.content.trim() === ''

            return (
              <article
                key={m.id}
                className={`msg msg--${m.role}${toolsOnly ? ' msg--tools' : ''}`}
                onContextMenu={() => void menu(m)}
              >
                {editing ? (
                  <div className="edit">
                    <textarea
                      className="edit__input"
                      autoFocus
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingId(null)
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitEdit()
                      }}
                    />
                    <div className="edit__bar">
                      <span className="sounding">Saving forks a new branch</span>
                      <button className="btn" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                      <button className="btn btn--primary" onClick={commitEdit}>
                        Save
                      </button>
                    </div>
                  </div>
                ) : m.role === 'system' ? (
                  <div className="msg__note">{m.content}</div>
                ) : (
                  <div className="msg__body">
                    {m.summaryOf ? (
                      /*
                        The root of a compacted branch. It reads as the model
                        reads it, and carries the way back, since a summary
                        you cannot check against the original is a claim.
                      */
                      <div className="summary">
                        <div className="summary__head">
                          <span className="sounding">compacted</span>
                          <button
                            className="summary__back"
                            onClick={() => onOpenOriginal(m.summaryOf as string)}
                          >
                            Show the original branch
                          </button>
                        </div>
                        <Markdown text={body} />
                      </div>
                    ) : m.role === 'user' ? (
                      <>
                        {m.attachments && <Attachments raw={m.attachments} />}
                        {body}
                      </>
                    ) : m.error ? (
                      <div className="msg__error">
                        <span>{m.error}</span>
                        <button className="btn btn--small" onClick={() => onRetry(m.id)} title="Ask again, as a sibling reply">
                          Retry
                        </button>
                      </div>
                    ) : (
                      <>
                        {isStreaming ? (
                          <LiveBody requestId={view.requestId} thinking={activity?.phase === 'thinking'} />
                        ) : (
                          <>
                            {m.reasoning && <Reasoning text={m.reasoning} tokens={m.reasoningTokens} />}
                            {body.trim() !== '' && <Markdown text={body} />}
                          </>
                        )}
                        {m.toolCalls && (
                          <ToolRow
                            calls={callsOf(m.toolCalls)}
                            results={toolResults}
                            running={false}
                          />
                        )}
                        {isStreaming && liveTools.length > 0 && (
                          <ToolRow calls={liveTools} results={toolResults} running />
                        )}
                        {/*
                          The row above already names the tool, so only the
                          clock is added — the number is what a long command
                          needs, not the name twice.
                        */}
                        {isStreaming && activity?.phase === 'tool' && liveTools.length > 0 && (
                          <Activity turn={activity} compact />
                        )}
                        {/*
                          The cursor is enough while text is arriving — you can
                          see it working. Every other phase looks identical from
                          outside, so it is named instead.
                        */}
                        {isStreaming && activity?.phase === 'writing' && (
                          <span className="cursor" />
                        )}
                        {isStreaming &&
                          activity &&
                          activity.phase !== 'writing' &&
                          !(activity.phase === 'tool' && liveTools.length > 0) && (
                            <LiveActivity requestId={view.requestId} turn={activity} />
                          )}
                        {m.citations && <Citations raw={m.citations} />}
                      </>
                    )}
                  </div>
                )}

                {!isStreaming &&
                  !editing &&
                  m.role !== 'system' &&
                  !(m.role === 'assistant' && m.content.trim() === '') && (
                    <div className="msg__foot">
                      <div className="msg__actions">
                      {count > 1 && m.role === 'assistant' && (
                        <button
                          className="msg__word"
                          title={`Compare the ${count} replies side by side`}
                          onClick={() => onCompare(m.parentId)}
                        >
                          {count} replies
                        </button>
                      )}
                      {count > 1 && (
                        <span className="branch">
                          <button
                            className="branch__step"
                            disabled={index === 1}
                            onClick={() => onSwitch(m, -1)}
                            title="Previous version"
                           aria-label="Previous version">
                            <ChevronLeft size={12} />
                          </button>
                          <span className="sounding">
                            {index}/{count}
                          </span>
                          <button
                            className="branch__step"
                            disabled={index === count}
                            onClick={() => onSwitch(m, 1)}
                            title="Next version"
                           aria-label="Next version">
                            <ChevronRight size={12} />
                          </button>
                        </span>
                      )}

                      <button
                        className="icon-btn"
                        title="Copy"
                        onClick={() => void navigator.clipboard.writeText(m.content)}
                       aria-label="Copy">
                        <Copy size={13} />
                      </button>

                      {m.role === 'user' && (
                        <button
                          className="icon-btn"
                          title="Edit and fork"
                          onClick={() => beginEdit(m)}
                         aria-label="Edit and fork">
                          <Pencil size={13} />
                        </button>
                      )}

                      {m.role === 'assistant' && (
                        <button className="icon-btn" title="Retry" onClick={() => onRetry(m.id)} aria-label="Retry">
                          <Refresh size={13} />
                        </button>
                      )}

                      <button className="icon-btn" title="Delete" onClick={() => onDelete(m.id)} aria-label="Delete">
                        <Trash size={13} />
                      </button>

                      {m.role === 'assistant' && (
                        <button className="msg__word" title="A question about this reply, answered beside it and kept out of the conversation" onClick={() => setAsideFor((id) => (id === m.id ? null : m.id))}>
                          ask about it
                        </button>
                      )}
                      {m.content.trim() !== '' && (
                        <button className="msg__word" title="Keep this as a memory for the project" onClick={() => onRemember(m.content)}>
                          remember
                        </button>
                      )}
                      </div>
                      <div className="msg__meta">
                      {m.model && (
                        <span className="sounding">
                          {shortModel(m.model)}
                          {m.label ? ` ${m.label}` : ''}
                        </span>
                      )}
                      {m.completionTokens !== null && (
                        <span className="sounding">
                          {m.promptTokens ?? 0} in · {m.completionTokens} out
                        </span>
                      )}
                      {cache && cache.rate !== null && ((m.cachedTokens ?? 0) > 0 || cache.missed) && (
                        <span
                          className="sounding"
                          data-miss={cache.missed || undefined}
                          title={`${m.cachedTokens ?? 0} of ${m.promptTokens ?? 0} prompt tokens read from the provider's cache.${cache.note ? ` ${cache.note}` : ''}`}
                        >
                          {cacheLine(cache)}
                          {cache.missed ? ' · miss' : ''}
                        </span>
                      )}
                      {(m.reasoningTokens ?? 0) > 0 && (
                        <span className="sounding">{m.reasoningTokens} reasoning</span>
                      )}
                      {m.cost !== null && <span className="sounding">{formatCost(m.cost)}</span>}
                      </div>
                    </div>
                  )}
                {asideFor === m.id && !isStreaming && <Aside messageId={m.id} ask={onAside} onClose={() => setAsideFor(null)} />}
              </article>
            )
          })}
          {/*
            Before the first step opens a message there is no row to put this
            in, and that gap — prompt assembly and the first request — used to
            show nothing at all.
          */}
          {cut !== -1 && compareParent && (
            <Compare
              parentId={compareParent}
              columns={columns}
              live={live}
              results={toolResults}
              ratings={ratings}
              onPick={onPickBranch}
              onVote={onVote}
              onAside={onAside}
              onClose={() => onCompare(null)}
            />
          )}
          {pending.map((a, i) => (
            <article className="msg msg--assistant" key={`pending-${i}`}>
              <div className="msg__body">
                <Activity turn={a} />
              </div>
            </article>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      {/* Only shown once the reader has scrolled away from the newest message. */}
      {!atBottom && (
        <button className="to-bottom" onClick={toBottom} title="Jump to the latest message" aria-label="Jump to the latest message">
          <ChevronDown size={14} />
        </button>
      )}
    </div>
  )
}

/** Re-rendered only when a prop changes; the shell hands it the same callbacks across renders for that reason. */
export const Stream = memo(StreamView)
