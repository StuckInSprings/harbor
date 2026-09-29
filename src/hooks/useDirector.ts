import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { Conversation, StreamEvent } from '../../shared/types'
import { APPROVAL_MESSAGE, DIRECTOR_OPENING, type RunWorker, type Task } from '../../shared/director'
import { notify } from '../lib/notices'
import { unwrap } from '../lib/unwrap'
import { api } from '../lib/api'
import type { Review, SuggestionState } from '../../shared/bridge'

export interface RunStatus {
  budget: number
  approved: boolean
  spent: number
  branch: string | null
  base: string | null
}

/**
 * A director's run as the shell shows it: where it stands, what its board
 * says, which workers are out and which are waiting on the person. Read
 * from main when the conversation changes, when a turn ends, and when a
 * file is written, since the board is a file the director keeps.
 */
export function useDirector(opts: {
  active: Conversation | null
  /** Anything that may have moved the board or the spend: a write, a turn ending. */
  tick: number
  /** Turns in flight in the conversation on screen; a change is a turn starting or ending. */
  live: number
  model: string | null
  refreshConversations: () => Promise<void>
  setActiveId: (id: string | null) => void
  /** A draft written for a conversation before it is on screen. */
  prefill: (id: string, text: string) => void
  setDraft: (text: string) => void
  closeSheet: () => void
  bumpChanges: () => void
  showMessages: (conversationId: string) => void
  /** Bumped when Claude posts a review through the bridge. */
  reviewTick: number
}): {
  runStatus: RunStatus | null
  board: Task[]
  runWorkers: RunWorker[]
  /** Claude's reviews of the run on screen, newest first. */
  reviews: Review[]
  setSuggestion: (reviewId: string, index: number, state: SuggestionState) => Promise<void>
  workersRunning: Set<string>
  workersWaiting: Map<string, string>
  runView: boolean
  setRunView: Dispatch<SetStateAction<boolean>>
  budgetEdit: string | null
  setBudgetEdit: (text: string | null) => void
  commitBudget: (id: string) => Promise<void>
  /** A worker event from a turn: the sidebar shows it running or waiting under its project. */
  onWorker: (e: Extract<StreamEvent, { type: 'worker' }>) => void
  startInterview: (projectId: string) => Promise<void>
  startDirector: (projectId: string, directorModel: string, budget: number, rehearsal?: boolean, fromInterview?: string | null) => Promise<void>
  finishRun: (id: string) => Promise<void>
  approvePlan: (id: string) => Promise<void>
} {
  const { active, tick, live, model, refreshConversations, setActiveId, prefill, setDraft, closeSheet, bumpChanges, showMessages, reviewTick } = opts
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null)
  const [board, setBoard] = useState<Task[]>([])
  const [runWorkers, setRunWorkers] = useState<RunWorker[]>([])
  const [reviews, setReviews] = useState<Review[]>([])
  const [workersRunning, setWorkersRunning] = useState<Set<string>>(() => new Set())
  // Workers waiting on an answer from the person, with the question each asked.
  const [workersWaiting, setWorkersWaiting] = useState<Map<string, string>>(() => new Map())
  /** A director shows its run by default; the chat is a click away. */
  const [runView, setRunView] = useState(true)
  /** The budget being typed in the header, or null when it is not being edited. */
  const [budgetEdit, setBudgetEdit] = useState<string | null>(null)

  useEffect(() => {
    if (!active || active.role !== 'director') {
      setRunStatus(null)
      setBoard([])
      setReviews([])
      return
    }
    let stale = false
    const load = async (): Promise<void> => {
      const [st, bd, ws, rv] = await Promise.all([
        api.director.status(active.id),
        api.director.board(active.id),
        api.director.workers(active.id),
        api.reviews.list(active.id)
      ])
      if (stale) return
      setReviews(rv.ok ? (rv.data ?? []) : [])
      setRunStatus(st.ok ? (st.data ?? null) : null)
      setBoard(bd.ok ? (bd.data ?? []) : [])
      setRunWorkers(ws.ok ? (ws.data ?? []) : [])
    }
    void load()
    // While workers run, the view follows them every few seconds.
    const timer = workersRunning.size > 0 ? setInterval(() => void load(), 5_000) : null
    return () => {
      stale = true
      if (timer) clearInterval(timer)
    }
  }, [active?.id, active?.role, active?.approved, tick, live, workersRunning.size, reviewTick]) // eslint-disable-line react-hooks/exhaustive-deps

  /* What the person did with one of Claude's suggestions: took it to the director, or put it aside. */
  const setSuggestion = useCallback(async (reviewId: string, index: number, state: SuggestionState): Promise<void> => {
    const r = await api.reviews.setState(reviewId, index, state)
    const next = r.ok ? r.data : null
    if (next) setReviews((list) => list.map((x) => (x.id === reviewId ? next : x)))
  }, [])

  const commitBudget = useCallback(
    async (id: string): Promise<void> => {
      const text = budgetEdit
      setBudgetEdit(null)
      if (text === null) return
      const amount = Number(text)
      if (!Number.isFinite(amount) || amount < 0) return
      await api.conversations.setBudget(id, amount)
      const st = await api.director.status(id)
      if (st.ok) setRunStatus(st.data ?? null)
      await refreshConversations()
    },
    [budgetEdit, refreshConversations]
  )

  const onWorker = useCallback(
    (e: Extract<StreamEvent, { type: 'worker' }>): void => {
      setWorkersRunning((set) => {
        const next = new Set(set)
        if (e.state === 'done') next.delete(e.conversationId)
        else next.add(e.conversationId)
        return next
      })
      setWorkersWaiting((map) => {
        const next = new Map(map)
        if (e.state === 'waiting') next.set(e.conversationId, e.question ?? '')
        else next.delete(e.conversationId)
        return next
      })
      void refreshConversations()
      if (e.state === 'done') showMessages(e.conversationId)
    },
    [refreshConversations, showMessages]
  )

  /* The interviewer writes the requirements a director will plan from; it is its own conversation. */
  const startInterview = useCallback(
    async (projectId: string): Promise<void> => {
      const created = unwrap(await api.conversations.create(projectId, model, false, 'interview'))
      closeSheet()
      await refreshConversations()
      setActiveId(created.id)
      setDraft('')
    },
    [model, closeSheet, refreshConversations, setActiveId, setDraft]
  )

  const startDirector = useCallback(
    async (projectId: string, directorModel: string, budget: number, rehearsal = false, fromInterview: string | null = null): Promise<void> => {
      const created = unwrap(await api.conversations.startDirector(projectId, directorModel, budget, rehearsal, fromInterview))
      await refreshConversations()
      closeSheet()
      setActiveId(created.id)
      // The first turn is the person's to send: one Return, and the director reads and plans.
      prefill(created.id, DIRECTOR_OPENING)
    },
    [refreshConversations, closeSheet, setActiveId, prefill]
  )

  const finishRun = useCallback(
    async (id: string): Promise<void> => {
      const ok = unwrap(
        await api.dialog.confirm(
          'Finish this run?',
          'A log of every dispatch, report and failure is written into the run\'s folder under _director/runs/, and the worker conversations are archived. They stay searchable.',
          'Finish'
        )
      )
      if (!ok) return
      const r = unwrap(await api.director.finish(id))
      notify(`Run log written to ${r.path}; ${r.workers} worker conversation${r.workers === 1 ? '' : 's'} archived.`, 'info')
      await refreshConversations()
      bumpChanges()
    },
    [refreshConversations, bumpChanges]
  )

  const approvePlan = useCallback(
    async (id: string): Promise<void> => {
      await api.conversations.approve(id)
      await refreshConversations()
      prefill(id, APPROVAL_MESSAGE)
    },
    [refreshConversations, prefill]
  )

  return { runStatus, board, runWorkers, reviews, setSuggestion, workersRunning, workersWaiting, runView, setRunView, budgetEdit, setBudgetEdit, commitBudget, onWorker, startInterview, startDirector, finishRun, approvePlan }
}
