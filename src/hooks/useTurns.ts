import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Message, StreamEvent, TodoItem, ToolRun } from '../../shared/types'
import { toolLabel, type Activity, type Phase } from '../../shared/activity'
import type { LiveView } from '../components/Stream'
import { notify } from '../lib/notices'
import { unwrap } from '../lib/unwrap'
import { api } from '../lib/api'
import { clearLive, setLive } from '../lib/live'

/** Everything the renderer holds about one turn in flight. */
export interface LiveTurn {
  requestId: string
  conversationId: string
  /** '' until the first step opens a message. */
  messageId: string
  text: string
  reasoning: string
  tools: ToolRun[]
  todos: TodoItem[]
  activity: Activity | null
  lastEventAt: number
}

/** What the shell does when a turn's events touch state that is not the turn's. */
export interface TurnCallbacks {
  /** The transcript to show, for a conversation on screen. */
  showMessages: (list: Message[]) => void
  refreshConversations: () => Promise<void>
  refreshSpend: () => Promise<void>
  onTodos: (conversationId: string, items: TodoItem[]) => void
  onRemembered: (count: number) => void
  onWorker: (e: Extract<StreamEvent, { type: 'worker' }>) => void
  onCompacted: (summarised: number) => void
  onTrimmed: (results: number, images: number) => void
  onGoal: (conversationId: string, state: string, note: string) => void
  onWrote: (path: string, onScreen: boolean) => void
  /** After the turn's row is stored, before the live view goes; the failure is noted here too. */
  onEnded: (conversationId: string, failed: boolean) => void
}

/**
 * Turns in flight, keyed by request. There used to be one slot, which meant
 * a slow agent run in one conversation blocked every other. Main has always
 * keyed everything by request; this is the renderer keeping up.
 *
 * The ref is the source of truth for event handlers, which must read the
 * text accumulated so far without waiting for a render; the state is the
 * same object handed to React so it re-renders.
 */
export function useTurns(activeId: string | null, activeIdRef: RefObject<string | null>, callbacks: TurnCallbacks): {
  turns: Record<string, LiveTurn>
  turnsRef: RefObject<Record<string, LiveTurn>>
  /** The turns in the conversation on screen. */
  activeTurns: LiveTurn[]
  /** Those with a message row, keyed by it: they stream into it. */
  liveByMessage: Record<string, LiveView>
  /** Those without one yet: each shows a waiting line of its own. */
  pendingTurns: Activity[]
  anyRunning: boolean
  beginTurn: (requestId: string, conversationId: string) => void
  updateTurn: (requestId: string, fn: (t: LiveTurn) => LiveTurn) => void
  endTurn: (requestId: string) => void
  turnsIn: (conversationId: string) => LiveTurn[]
  enter: (requestId: string, phase: Phase, detail?: string) => void
  stop: () => Promise<void>
} {
  const [turns, setTurns] = useState<Record<string, LiveTurn>>({})
  const turnsRef = useRef<Record<string, LiveTurn>>({})
  // The handler below is subscribed once; it reads the latest callbacks through this.
  const cb = useRef(callbacks)
  cb.current = callbacks

  const activeTurns = useMemo(() => Object.values(turns).filter((t) => t.conversationId === activeId), [turns, activeId])
  // The text itself is in the live store (src/lib/live.ts); a row subscribes to its own turn's.
  const liveByMessage = useMemo(() => {
    const map: Record<string, LiveView> = {}
    for (const t of activeTurns) {
      if (t.messageId) map[t.messageId] = { requestId: t.requestId, tools: t.tools, activity: t.activity }
    }
    return map
  }, [activeTurns])
  const pendingTurns = useMemo(() => activeTurns.filter((t) => !t.messageId && t.activity).map((t) => t.activity as Activity), [activeTurns])

  const updateTurn = useCallback((requestId: string, fn: (t: LiveTurn) => LiveTurn): void => {
    const cur = turnsRef.current[requestId]
    if (!cur) return
    turnsRef.current = { ...turnsRef.current, [requestId]: fn(cur) }
    setTurns(turnsRef.current)
  }, [])

  /*
    A token is not a state update. The text lands in the ref, so handlers
    read it fresh, and in the live store, which tells the one row showing
    it once per frame; React state changes only when the phase does.
  */
  const appendLive = useCallback((requestId: string, field: 'text' | 'reasoning', piece: string): void => {
    const cur = turnsRef.current[requestId]
    if (!cur) return
    const next = { ...cur, [field]: cur[field] + piece, lastEventAt: Date.now() }
    turnsRef.current = { ...turnsRef.current, [requestId]: next }
    setLive(requestId, { text: next.text, reasoning: next.reasoning })
  }, [])

  const endTurn = useCallback((requestId: string): void => {
    if (!turnsRef.current[requestId]) return
    clearLive(requestId)
    const rest = { ...turnsRef.current }
    delete rest[requestId]
    turnsRef.current = rest
    setTurns(rest)
  }, [])

  const beginTurn = useCallback((requestId: string, conversationId: string): void => {
    const now = Date.now()
    turnsRef.current = {
      ...turnsRef.current,
      [requestId]: { requestId, conversationId, messageId: '', text: '', reasoning: '', tools: [], todos: [], activity: { phase: 'assembling', since: now }, lastEventAt: now }
    }
    setTurns(turnsRef.current)
  }, [])

  const turnsIn = useCallback((convId: string): LiveTurn[] => Object.values(turnsRef.current).filter((t) => t.conversationId === convId), [])

  /*
    Entering a phase restarts its clock; staying in one does not, so the time
    shown while writing is the time spent writing rather than the time since
    the last token. A detail that changes within a phase — a second tool
    starting — updates the label and leaves the clock alone.
  */
  const enter = useCallback(
    (requestId: string, phase: Phase, detail?: string) => {
      updateTurn(requestId, (t) => {
        const a = t.activity
        if (a?.phase === phase) return a.detail === detail ? t : { ...t, activity: { ...a, detail } }
        return { ...t, activity: { phase, detail, since: Date.now() } }
      })
    },
    [updateTurn]
  )

  /*
    A backstop for silence. Every known way a turn can die now reports itself,
    but a spinner that never resolves is the worst failure mode there is — it
    looks like the app working. If nothing at all arrives for long enough, say
    so and let go, rather than waiting forever on a turn that is not coming.
  */
  const anyRunning = Object.keys(turns).length > 0
  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => {
      for (const t of Object.values(turnsRef.current)) {
        // Longer than any watchdog in main, so the specific diagnosis wins.
        if (Date.now() - t.lastEventAt < 240_000) continue
        notify('A turn went quiet and was given up on. Nothing was received for four minutes. The Log may say where it stopped.')
        void api.log.write('error', 'renderer', 'gave up on a silent turn after 4 minutes')
        void api.chat.cancel(t.requestId)
        endTurn(t.requestId)
      }
    }, 15_000)
    return () => clearInterval(timer)
  }, [anyRunning, endTurn])

  /*
    A turn is driven by the main process, which owns the database, the tools
    and the path jail. The renderer starts one and then just watches events.
  */
  useEffect(() => {
    return api.chat.onEvent((e: StreamEvent & { owner?: string }) => {
      let run: LiveTurn | undefined = turnsRef.current[e.requestId]
      /*
        A turn this window did not start — a director's worker, a run resumed
        elsewhere — is picked up the moment its conversation is on screen,
        so opening a worker mid-task shows it working rather than a stale
        transcript. Its current message is the newest one on disk.
      */
      const inProgress = e.type === 'begin' || e.type === 'delta' || e.type === 'reasoning' || e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'phase' || e.type === 'todos'
      if (!run && e.owner && e.owner === activeIdRef.current && inProgress) {
        const now = Date.now()
        const owner = e.owner
        const adopted: LiveTurn = { requestId: e.requestId, conversationId: owner, messageId: '', text: '', reasoning: '', tools: [], todos: [], activity: { phase: 'writing', since: now }, lastEventAt: now }
        turnsRef.current = { ...turnsRef.current, [e.requestId]: adopted }
        setTurns(turnsRef.current)
        run = adopted
        void (async () => {
          const list = unwrap(await api.messages.list(owner))
          if (activeIdRef.current === owner) cb.current.showMessages(list)
          const last = [...list].reverse().find((m) => m.role === 'assistant')
          if (last) updateTurn(e.requestId, (t) => (t.messageId ? t : { ...t, messageId: last.id }))
        })()
      }
      if (!run) return
      const id = e.requestId
      const conv = run.conversationId
      // The time of the last event is read by the watchdog off the ref; it need not render.
      if (e.type !== 'delta' && e.type !== 'reasoning') updateTurn(id, (t) => ({ ...t, lastEventAt: Date.now() }))
      // Another conversation's turn must not redraw this one.
      const onScreen = activeIdRef.current === conv
      const reload = async (): Promise<void> => {
        if (activeIdRef.current === conv) cb.current.showMessages(unwrap(await api.messages.list(conv)))
      }

      switch (e.type) {
        case 'begin':
          // Each loop step gets its own message; reload so the finished step
          // takes its place in the transcript before the next one streams.
          clearLive(id)
          updateTurn(id, (t) => ({ ...t, messageId: e.messageId, text: '', reasoning: '', tools: [] }))
          void (async () => {
            await reload()
            await cb.current.refreshConversations()
          })()
          return
        case 'phase':
          enter(id, e.phase, e.detail)
          return
        case 'delta':
          appendLive(id, 'text', e.text)
          if (run.activity?.phase !== 'writing') enter(id, 'writing')
          return
        case 'reasoning':
          appendLive(id, 'reasoning', e.text)
          if (run.activity?.phase !== 'thinking') enter(id, 'thinking')
          return
        case 'tool_start':
          updateTurn(id, (t) => ({ ...t, tools: [...t.tools, e.call] }))
          enter(id, 'tool', toolLabel(turnsRef.current[id]?.tools ?? []))
          return
        case 'tool_end':
          updateTurn(id, (t) => ({ ...t, tools: t.tools.map((c) => (c.callId === e.call.callId ? e.call : c)) }))
          return
        case 'todos':
          updateTurn(id, (t) => ({ ...t, todos: e.items }))
          // The end of a run clears the live list with an empty one; the panel keeps what was done.
          if (e.items.length > 0) cb.current.onTodos(conv, e.items)
          return
        case 'remembered':
          cb.current.onRemembered(e.count)
          return
        case 'worker':
          cb.current.onWorker(e)
          return
        case 'compacted':
          // The branch on screen has been replaced under this turn's feet.
          void (async () => {
            await reload()
            await cb.current.refreshConversations()
          })()
          cb.current.onCompacted(e.summarised)
          return
        case 'trimmed':
          cb.current.onTrimmed(e.results, e.images)
          return
        case 'goal':
          cb.current.onGoal(e.conversationId, e.state, e.note)
          return
        case 'wrote':
          cb.current.onWrote(e.path, onScreen)
          return
        case 'error':
        case 'done': {
          const failed = e.type === 'error'
          // Main has already written whatever the row should say.
          void (async () => {
            // The stored row first, then the live view goes: the other way
            // round the reply collapsed to nothing for one round trip.
            await reload()
            endTurn(id)
            cb.current.onEnded(conv, failed)
            await cb.current.refreshConversations()
            await cb.current.refreshSpend()
          })()
        }
      }
    })
  }, [activeIdRef, enter, updateTurn, appendLive, endTurn])

  const stop = useCallback(async () => {
    await Promise.all(activeTurns.map((t) => api.chat.cancel(t.requestId)))
  }, [activeTurns])

  return { turns, turnsRef, activeTurns, liveByMessage, pendingTurns, anyRunning, beginTurn, updateTurn, endTurn, turnsIn, enter, stop }
}
