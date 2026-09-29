import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { INTERVIEW_OPENING, filesOf } from '../shared/director'
import { GOAL_LABEL, MAX_TURNS, parseGoalCommand, type GoalState } from '../shared/goal'
import type {
  Conversation,
  Message,
  Project,
  AssembledSystem,
  Attachment,
  Prompt,
  TodoItem,
  StreamEvent
} from '../shared/types'
import { GENERAL_PROJECT_ID } from '../shared/types'
import { Sidebar } from './components/Sidebar'
import { Stream } from './components/Stream'
import { Composer, type Segment } from './components/Composer'
import { ModelPicker } from './components/ModelPicker'
import { Settings } from './components/Settings'
import { ProjectSheet } from './components/ProjectSheet'
import { DirectorSheet } from './components/DirectorSheet'
import { RunView } from './components/RunView'
import { ConversationHeader } from './components/ConversationHeader'
import { UsageSheet } from './components/UsageSheet'
import { ContextSheet } from './components/ContextSheet'
import { SearchSheet } from './components/SearchSheet'
import { LogSheet } from './components/LogSheet'
import { PromptSheet } from './components/PromptSheet'
import { Inspector } from './components/Inspector'
import { Approval } from './components/Approval'
import { estimateTokens, titleFrom } from './lib/format'
import { installGlobalHandlers, notify, ok } from './lib/notices'
import { unwrap } from './lib/unwrap'
import { useDrafts } from './hooks/useDrafts'
import { useInspector } from './hooks/useInspector'
import { useModels } from './hooks/useModels'
import { useTurns } from './hooks/useTurns'
import { useTerminal } from './hooks/useTerminal'
import { useDirector } from './hooks/useDirector'
import type { ModelParams } from '../shared/types'
import { FAN_OUT_MAX, planFanOut, variantLabel, layoutKey, parseLayout, ratingsKey, parseRatings, applyVote, replyKey, compareColumns, type FanVariant, type Ratings } from '../shared/fanout'

/** A window opened on one conversation, from the hash; it shows that and nothing else. */
const POPPED = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pop')

import { ingestFiles } from './lib/clipboard'
import { Parameters, filterParams, mergeParams } from './components/Parameters'
import { unreadable } from '../shared/attachments'
import { Notices } from './components/Notices'
import { deepestLeaf, pathTo, siblingStep } from './lib/tree'
import { Sheet } from './components/Sheet'
import { runFiles } from '../shared/director'
import { api } from './lib/api'
import { useLiveLength } from './lib/live'
import { moveBy } from '../shared/sidebar'

type Sheet =
  | { kind: 'none' }
  | { kind: 'settings' }
  | { kind: 'models' }
  | { kind: 'usage' }
  | { kind: 'context' }
  | { kind: 'search' }
  | { kind: 'params' }
  | { kind: 'log' }
  | { kind: 'prompt' }
  | { kind: 'project'; projectId: string | null }
  | { kind: 'director'; projectId: string; fromInterview?: string | null }
  | { kind: 'pick-project' }

export default function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(POPPED)
  /* The conversation on screen, readable from handlers registered once. */
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  // A desktop notification was clicked: land on the conversation that asked.
  useEffect(() => api.onOpenConversation((id) => { if (!POPPED) setActiveId(id) }), [])
  const [messages, setMessages] = useState<Message[]>([])
  const [spendByProject, setSpendByProject] = useState<Record<string, number>>({})

  const refreshConversations = useCallback(async () => {
    setConversations(unwrap(await api.conversations.list()))
  }, [])
  // A run Claude started through the bridge, or a message it sent, lands in the sidebar without a click.
  useEffect(() => api.onConversationsChanged(() => void refreshConversations()), [refreshConversations])
  // What Claude wants the person to know: an interview waiting on them, a review of a run.
  const [reviewTick, setReviewTick] = useState(0)

  const { keyStatus, hasKey, canChat, models, favorites, modelsLoading, modelsError, lastModel, loadModels, toggleFavorite, pickModel, rememberModel, saveKey, clearKey } = useModels({ activeId, refreshConversations })
  const { draft, setDraft, prefill } = useDrafts(activeId, activeIdRef)
  // Bumped to give the box the caret without changing conversation: an Answer pressed in the run view.
  const [composerFocus, setComposerFocus] = useState(0)
  const refreshSpend = useCallback(async () => {
    const r = await api.usage.byProject()
    if (r.ok && r.data) setSpendByProject(r.data)
  }, [])
  const directorRef = useRef<{ onWorker: (e: Extract<StreamEvent, { type: 'worker' }>) => void } | null>(null)
  /* The turn state and its event handler; what the events touch elsewhere in the shell is answered here. */
  const { turns, turnsRef, activeTurns, liveByMessage, pendingTurns, beginTurn, endTurn, turnsIn, enter, stop } = useTurns(activeId, activeIdRef, {
    showMessages: setMessages,
    refreshConversations,
    refreshSpend,
    onTodos: (conv, items) => {
      setProgress((p) => ({ ...p, [conv]: items }))
      // The list lives in the panel; the first one opens it.
      setInspector((m) => (m === 'none' ? (rootRef.current ? 'explorer' : 'terminal') : m))
    },
    onRemembered: (count) => {
      setRemembered(count)
      setTimeout(() => setRemembered(0), 6000)
    },
    onWorker: (e) => directorRef.current?.onWorker(e),
    onCompacted: (summarised) =>
      notify(
        `This conversation had outgrown the model, so ${summarised} earlier messages were summarised onto a fresh branch before sending. The original is still there, one branch over.`,
        'info'
      ),
    onGoal: (conv, state, note) => {
      void refreshConversations()
      if (state !== 'pursuing' && activeIdRef.current === conv) notify(`Goal ${GOAL_LABEL[state as GoalState] ?? state}${note ? `: ${note}` : ''}.`, state === 'met' ? 'info' : 'warn')
    },
    onTrimmed: (results, images) =>
      notify(
        `To make room, ${[results ? `${results} older tool result${results === 1 ? '' : 's'}` : '', images ? `${images} older message${images === 1 ? "'s" : "s'"} images` : ''].filter(Boolean).join(' and ')} ${results + images === 1 ? 'was' : 'were'} cleared from what the model is sent. The transcript keeps them.`,
        'info'
      ),
    onWrote: (path, onScreen) => {
      setChangesTick((n) => n + 1)
      /*
        Edits land without a gate, so a write must not pass unremarked. But
        seizing the pane on every write is the wrong way to say so: it
        interrupts whatever you were reading to show a diff you did not ask
        for. Prose is the exception — when the agent writes markdown, the
        rendered result is the thing you actually want to see.
      */
      if (isMarkdown(path) && onScreen) showWritten(path)
      // Everything else raises a marker on the Changes button instead.
      else setUnreviewed(true)
    },
    onEnded: (conv, failed) => {
      if (failed) setFailedConvIds((set) => new Set(set).add(conv))
      setChangesTick((n) => n + 1)
    }
  })
  const { terminal, approvals } = useTerminal({ turnsIn, enter, openPane: () => setInspector((mode) => (mode === 'none' ? 'terminal' : mode)) })
  /** Which user message's replies are laid out side by side, if any. */
  const [compareParent, setCompareParent] = useState<string | null>(null)
  /* The project's saved fan-out set, and its ratings from blind votes; both live in settings, keyed by project. */
  const [layout, setLayout] = useState<FanVariant[]>([])
  const [ratings, setRatings] = useState<Ratings>({})
  const [changesTick, setChangesTick] = useState(0)
  const [agentOn, setAgentOn] = useState(true)
  const [webOn, setWebOn] = useState(false)
  const [reasoningOn, setReasoningOn] = useState(false)
  /** Agent turns without the write tools. Session state, like the other toggles. */
  const [planOn, setPlanOn] = useState(false)
  const [pending, setPending] = useState<Attachment[]>([])
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [systemPreview, setSystemPreview] = useState<AssembledSystem | null>(null)
  const [remembered, setRemembered] = useState(0)
  /** Conversations whose last turn failed, until they are opened again. */
  const [failedConvIds, setFailedConvIds] = useState<Set<string>>(new Set())

  const [sidebarOpen, setSidebarOpen] = useState(!POPPED && window.innerWidth >= 900)
  const { inspector, setInspector, toggleInspector, filePath, fileTick, openFile, showWritten, unreviewed, setUnreviewed, inspectorWidth, resizing, beginResize, resetResize } = useInspector()
  /** The last checklist each conversation's agent wrote; shown in the panel, kept after the run. */
  const [progress, setProgress] = useState<Record<string, TodoItem[]>>({})
  /** The active project's folder, readable from inside the event handler, which is bound once. */
  const rootRef = useRef<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>({ kind: 'none' })

  const active = conversations.find((c) => c.id === activeId) ?? null
  // A conversation's own project, archived or not; with none open, the first project still in view.
  const project = projects.find((p) => p.id === active?.projectId) ?? projects.find((p) => !p.archived) ?? projects[0] ?? null
  rootRef.current = project?.rootPath ?? null
  const model = active?.model ?? project?.defaultModel ?? lastModel
  const modelInfo = models.find((m) => m.id === model) ?? null
  const director = useDirector({
    reviewTick,
    active,
    tick: changesTick,
    live: activeTurns.length,
    model,
    refreshConversations,
    setActiveId,
    prefill,
    setDraft,
    closeSheet: () => setSheet({ kind: 'none' }),
    bumpChanges: () => setChangesTick((n) => n + 1),
    showMessages: (conv) => {
      if (activeIdRef.current !== conv) return
      void api.messages.list(conv).then((r) => {
        if (activeIdRef.current === conv) setMessages(unwrap(r))
      })
    }
  })
  directorRef.current = director
  const { runStatus, board, runWorkers, reviews, setSuggestion, workersRunning, workersWaiting, runView, setRunView, budgetEdit, setBudgetEdit, commitBudget, startInterview, startDirector, finishRun, approvePlan } = director
  useEffect(() => api.onBridgeNotice((n) => {
    if (POPPED) return
    if (n.kind === 'review') setReviewTick((t) => t + 1)
    // The run it is about may be new to the list; read it, then offer to go there.
    void refreshConversations().then(() => notify(n.text, 'info', { label: 'Open', run: () => { setActiveId(n.conversationId); setRunView(true) } }))
  }), [refreshConversations, setRunView])

  const path = useMemo(() => pathTo(messages, active?.leafId ?? null), [messages, active?.leafId])

  /* Conversation settings override project defaults, key by key. */
  const effectiveParams = useMemo(
    () => mergeParams(project?.params ?? {}, active?.params ?? {}),
    [project?.params, active?.params]
  )

  /* ------------------------------------------------------------- loading */

  const reloadMessages = useCallback(async () => {
    if (!activeId) return
    setMessages(unwrap(await api.messages.list(activeId)))
    setConversations(unwrap(await api.conversations.list()))
  }, [activeId])

  const refreshProjects = useCallback(async () => {
    setProjects(unwrap(await api.projects.list()))
  }, [])

  const refreshPrompts = useCallback(async (projectId: string | null) => {
    const r = await api.prompts.list(projectId)
    if (r.ok && r.data) setPrompts(r.data)
  }, [])

  useEffect(() => {
    void (async () => {
      await refreshProjects()
      await refreshConversations()
      await refreshSpend()
    })()
  }, [refreshProjects, refreshConversations, refreshSpend])

  // Rename from the context menu puts the cursor in the header title.
  useEffect(() => {
    if (renaming && renaming === activeId && titleRef.current) {
      titleRef.current.focus()
      titleRef.current.select()
      setRenaming(null)
    }
  }, [renaming, activeId, messages])

  useEffect(() => {
    void refreshPrompts(project?.id ?? null)
  }, [project?.id, refreshPrompts, sheet.kind])

  /*
    The gauge reports the real assembled prompt rather than an estimate of one
    part of it, so it has to refresh whenever anything feeding it changes.
  */
  useEffect(() => {
    void (async () => {
      const r = await api.context.system(
        project?.id ?? null,
        model ?? '',
        webOn,
        agentOn && planOn
      )
      if (r.ok && r.data) setSystemPreview(r.data)
    })()
  }, [project?.id, project?.systemPrompt, model, webOn, agentOn, planOn, sheet.kind, activeTurns.length])

  /*
    The menu bar's commands. The shortcuts live on the menu, where they can
    be read, and arrive here as one word each; a pop-out takes only the
    ones that make sense in a single conversation. Subscribed once, with
    refs for what changes, so a reply's every token does not resubscribe.
  */
  const commandRef = useRef<(command: string) => void>(() => {})
  useEffect(() => window.harbor.onCommand((command) => commandRef.current(command)), [])

  useEffect(() => {
    setCompareParent(null)
    if (!activeId) {
      setMessages([])
      return
    }
    void (async () => {
      setMessages(unwrap(await api.messages.list(activeId)))
    })()
  }, [activeId])

  useEffect(() => installGlobalHandlers(), [])

  useEffect(() => {
    const pid = project?.id ?? null
    void (async () => {
      setLayout(parseLayout(unwrap(await api.settings.get(layoutKey(pid)))))
      setRatings(parseRatings(unwrap(await api.settings.get(ratingsKey(pid)))))
    })()
  }, [project?.id])

  const saveLayout = useCallback(async (variants: FanVariant[]) => {
    setLayout(variants)
    await api.settings.set(layoutKey(project?.id ?? null), JSON.stringify(variants))
    notify(variants.length ? `Layout saved: ${variants.length} ${variants.length === 1 ? 'ask' : 'asks'}.` : 'Layout cleared.', 'info')
  }, [project?.id])

  /*
    A blind vote: the chosen reply beat every other column. The rating is
    the project's, read fresh so two windows do not overwrite each other's.
  */
  const vote = useCallback(async (winnerId: string) => {
    if (!compareParent) return
    const columns = compareColumns(messages, compareParent)
    const winner = columns.find((m) => m.id === winnerId)
    if (!winner) return
    const pid = project?.id ?? null
    const table = applyVote(parseRatings(unwrap(await api.settings.get(ratingsKey(pid)))), replyKey(winner), columns.filter((m) => m.id !== winnerId).map(replyKey))
    await api.settings.set(ratingsKey(pid), JSON.stringify(table))
    setRatings(table)
  }, [compareParent, messages, project?.id])

  const aside = useCallback(async (messageId: string, question: string) => {
    if (!activeId) throw new Error('No conversation.')
    return unwrap(await api.chat.aside(activeId, messageId, question))
  }, [activeId])

  const startTurn = useCallback(
    async (conversationId: string, parentId: string | null, useModel: string, variant?: { params?: Partial<ModelParams>; label?: string }) => {
      const requestId = crypto.randomUUID()
      // A fan-out asks models other than the one chosen, so each turn looks
      // up its own capabilities rather than borrowing the conversation's.
      const info = models.find((m) => m.id === useModel) ?? (useModel === model ? modelInfo : null)
      beginTurn(requestId, conversationId)
      setFailedConvIds((set) => {
        if (!set.has(conversationId)) return set
        const next = new Set(set)
        next.delete(conversationId)
        return next
      })

      const res = await api.chat.run(requestId, {
        conversationId,
        parentId,
        model: useModel,
        agent: agentOn,
        plan: planOn,
        web: webOn,
        // Only sent where the model advertises support, so it cannot be
        // silently dropped without anyone noticing.
        // A model that always reasons is asked to, whatever the toggle says; the request would fail otherwise.
        reasoning: info?.reasoning?.mandatory === true || (reasoningOn && info?.supportsReasoning === true),
        // Filtered here rather than in main, because this is where the model's
        // capabilities are known.
        params: filterParams({ ...effectiveParams, ...(variant?.params ?? {}) }, info),
        accepts: info?.inputModalities ?? ['text'],
        contextLength: info?.contextLength ?? 0,
        ...(variant?.label ? { label: variant.label } : {})
      })
      if (!res.ok) endTurn(requestId)
    },
    [agentOn, planOn, webOn, reasoningOn, model, modelInfo, models, effectiveParams, endTurn, beginTurn]
  )

  /*
    One user message, then a turn per model. With one model this is an
    ordinary send; with several it is a fan-out, and the replies open side by
    side so the best can be picked and continued from.
  */
  const submit = useCallback(async (askModels: (string | FanVariant)[]) => {
    const text = draft.trim()
    // An attachment on its own is a perfectly good message.
    if ((!text && pending.length === 0) || !model) return

    let conversationId = activeId
    let leaf: string | null = path.length ? path[path.length - 1].id : null

    if (!conversationId) {
      const home = project ?? projects.find((p) => !p.archived) ?? projects[0]
      if (!home) return
      const created = unwrap(await api.conversations.create(home.id, model))
      conversationId = created.id
      leaf = null
      setActiveId(created.id)
    }

    // The box is emptied only once the message is stored; a failed add
    // used to take the typed text and the attachments with it.
    const attached = pending
    const userMsg = unwrap(
      await api.messages.add(
        conversationId,
        leaf,
        'user',
        text,
        null,
        attached
      )
    )
    setDraft('')
    setPending([])

    const conv = conversations.find((c) => c.id === conversationId)
    if (!conv || conv.title === 'Untitled') {
      await api.conversations.rename(conversationId, titleFrom(text))
    }
    await api.conversations.setModel(conversationId, model)
    await rememberModel(model)
    setMessages(unwrap(await api.messages.list(conversationId)))

    const asked = planFanOut(model, askModels)
    if (asked.length > 1) setCompareParent(userMsg.id)
    await Promise.all(asked.map((v) => startTurn(conversationId, userMsg.id, v.model, { params: v.params, label: variantLabel(v) || undefined })))
  }, [draft, pending, model, activeId, path, project, projects, conversations, startTurn, rememberModel, setDraft])

  const send = useCallback(() => submit([]), [submit])

  /** Editing a message forks a sibling; the original branch stays put. */
  const editMessage = useCallback(
    async (messageId: string, text: string) => {
      if (!activeId || !model) return
      const original = messages.find((m) => m.id === messageId)
      if (!original) return
      const forked = unwrap(
        await api.messages.add(activeId, original.parentId, 'user', text, null)
      )
      setMessages(unwrap(await api.messages.list(activeId)))
      await startTurn(activeId, forked.id, model)
    },
    [activeId, model, messages, startTurn]
  )

  /** Retry answers the same question again, as a sibling reply. */
  const retryMessage = useCallback(
    async (messageId: string) => {
      if (!activeId) return
      const original = messages.find((m) => m.id === messageId)
      if (!original) return
      await startTurn(activeId, original.parentId, original.model ?? model ?? '')
    },
    [activeId, messages, model, startTurn]
  )

  const switchBranch = useCallback(
    async (m: Message, direction: -1 | 1) => {
      if (!activeId) return
      const step = siblingStep(messages, m, direction)
      if (!step) return
      const leaf = deepestLeaf(messages, step.target)
      await api.messages.setLeaf(activeId, leaf.id)
      await refreshConversations()
    },
    [activeId, messages, refreshConversations]
  )

  /** Continue from one of several replies: it becomes the branch on screen. */
  const pickBranch = useCallback(
    async (messageId: string) => {
      if (!activeId) return
      const target = messages.find((m) => m.id === messageId)
      if (!target) return
      await api.messages.setLeaf(activeId, deepestLeaf(messages, target).id)
      await refreshConversations()
      setCompareParent(null)
    },
    [activeId, messages, refreshConversations]
  )

  /* ----------------------------------------------------------- compaction */

  const compactNow = useCallback(async () => {
    if (!activeId || !model) return
    if (activeTurns.length > 0) {
      notify('Wait for the current turn to finish before compacting.', 'warn')
      return
    }
    const r = await api.chat.compact(activeId, model, modelInfo?.contextLength ?? 0)
    if (!r.ok || !r.data) {
      notify(r.error ?? 'Compaction failed.')
      return
    }
    setMessages(unwrap(await api.messages.list(activeId)))
    await refreshConversations()
    notify(
      `Compacted: ${r.data.summarised} earlier messages summarised, ${r.data.kept} kept. The original branch is one step back from the summary.`,
      'info'
    )
  }, [activeId, model, modelInfo?.contextLength, activeTurns, refreshConversations])

  const runCommand = useCallback(
    (name: string, args?: string) => {
      if (name === 'compact') void compactNow()
      if (name === 'goal') {
        if (!activeId) {
          notify('Open a conversation first; a goal belongs to one.', 'warn')
          return
        }
        const parsed = parseGoalCommand(args ?? '')
        if ('error' in parsed) {
          notify(parsed.error, 'warn')
          return
        }
        void (async () => {
          if ('off' in parsed) {
            await api.goal.clear(activeId)
            notify('The goal is cleared.', 'info')
          } else {
            await api.goal.set(activeId, parsed.goal, parsed.budget)
            notify(`Goal set. Send the first message; after each reply a judge says whether it is met, and the conversation carries on by itself until it is, or $${parsed.budget.toFixed(2)} is spent, or ${MAX_TURNS} turns pass. /goal off stops it.`, 'info')
          }
          await refreshConversations()
        })()
      }
    },
    [compactNow, activeId, refreshConversations]
  )

  commandRef.current = (command: string): void => {
    const home = projectRef.current?.id ?? projectsRef.current[0]?.id
    switch (command) {
      case 'compact':
        void compactNow()
        return
      case 'search':
        if (!POPPED) setSheet({ kind: 'search' })
        return
      case 'settings':
        if (!POPPED) setSheet({ kind: 'settings' })
        return
    }
    if (POPPED) return
    switch (command) {
      case 'new':
        if (home) void newConversationRef.current(home, false)
        break
      case 'ask':
        if (home) void newConversationRef.current(home, true)
        break
      case 'plan':
        setSheet({ kind: 'pick-project' })
        break
      case 'new-project':
        setSheet({ kind: 'project', projectId: null })
        break
      case 'sidebar':
        setSidebarOpen((v) => !v)
        break
      case 'terminal':
      case 'changes':
      case 'explorer':
        toggleInspector(command)
        break
      case 'context':
        setSheet({ kind: 'context' })
        break
      case 'usage':
        setSheet({ kind: 'usage' })
        break
      case 'log':
        setSheet({ kind: 'log' })
        break
    }
  }

  /** Jump to the branch a summary replaced. It is still there; this is just a leaf move. */
  const openOriginal = useCallback(
    async (leafId: string) => {
      if (!activeId) return
      const target = messages.find((m) => m.id === leafId)
      if (!target) return
      await api.messages.setLeaf(activeId, deepestLeaf(messages, target).id)
      await refreshConversations()
    },
    [activeId, messages, refreshConversations]
  )

  /* -------------------------------------------------------------- actions */

  /*
    Native menus, so the action comes back as a string and the confirmation for
    anything destructive has already happened in main.
  */
  const conversationMenu = async (c: Conversation): Promise<void> => {
    const r = await api.menu.show('conversation', {
      pinned: c.pinned,
      archived: c.archived
    })
    if (!r.ok || !r.data) return

    switch (r.data) {
      case 'rename':
        setActiveId(c.id)
        setRenaming(c.id)
        return
      case 'pin':
        await api.conversations.togglePinned(c.id)
        break
      case 'archive':
        await api.conversations.setArchived(c.id, !c.archived)
        if (!c.archived && c.id === activeId) setActiveId(null)
        break
      case 'delete':
        await api.conversations.remove(c.id)
        if (c.id === activeId) setActiveId(null)
        break
    }
    await refreshConversations()
  }

  /* Several at once. Deleting is the one that asks first; there is no undo for it. */
  const deleteMany = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return
    const n = ids.length
    const ok = unwrap(
      await api.dialog.confirm(
        `Delete ${n} conversation${n === 1 ? '' : 's'}?`,
        'Their messages go with them. This cannot be undone.',
        `Delete ${n}`
      )
    )
    if (!ok) return
    for (const id of ids) await api.conversations.remove(id)
    if (activeId && ids.includes(activeId)) setActiveId(null)
    await refreshConversations()
  }
  const archiveMany = async (ids: string[]): Promise<void> => {
    for (const id of ids) await api.conversations.setArchived(id, true)
    if (activeId && ids.includes(activeId)) setActiveId(null)
    await refreshConversations()
  }

  const selectionMenu = async (ids: string[]): Promise<boolean> => {
    const chosen = conversations.filter((c) => ids.includes(c.id))
    const r = await api.menu.show('selection', {
      count: ids.length,
      anyArchived: chosen.some((c) => c.archived)
    })
    if (!r.ok || !r.data) return false
    switch (r.data) {
      case 'archive':
        await archiveMany(ids)
        return true
      case 'unarchive':
        for (const id of ids) await api.conversations.setArchived(id, false)
        await refreshConversations()
        return true
      case 'delete': {
        const before = conversations.length
        await deleteMany(ids)
        // Cancelled at the sheet: the selection stays so they can try again or let go.
        return (unwrap(await api.conversations.list())).length !== before
      }
      case 'clear':
        return true
    }
    return false
  }

  /* The sidebar's order: shown at once, then stored; a failed store is reported and the list reloaded. */
  const reorderProjects = (ids: string[]): void => {
    setProjects((list) => [...list].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)))
    void api.projects.reorder(ids).then((r) => {
      if (!r.ok) void refreshProjects()
    })
  }

  const projectMenu = async (projectId: string): Promise<void> => {
    const at = projects.findIndex((p) => p.id === projectId)
    const r = await api.menu.show('project', {
      showingArchived: showArchived[projectId] === true,
      deletable: projects.length > 1,
      first: at === 0,
      last: at === projects.length - 1,
      archived: projects[at]?.archived === true,
      // Chats is where conversations with no project live; it cannot be put away.
      archivable: projectId !== GENERAL_PROJECT_ID
    })
    if (!r.ok || !r.data) return

    switch (r.data) {
      case 'new':
        await newConversation(projectId)
        return
      case 'interview':
        await startInterview(projectId)
        return
      case 'search':
        setSheet({ kind: 'search' })
        return
      case 'toggleArchived':
        setShowArchived((m) => ({ ...m, [projectId]: !m[projectId] }))
        return
      case 'settings':
        setSheet({ kind: 'project', projectId })
        return
      case 'archive': {
        const archiving = !projects[at]?.archived
        setProjects((list) => list.map((p) => (p.id === projectId ? { ...p, archived: archiving } : p)))
        const r2 = await api.projects.setArchived(projectId, archiving)
        if (!r2.ok) await refreshProjects()
        else notify(archiving ? `${projects[at]?.name ?? 'The project'} is archived. It is under Archived at the foot of the sidebar.` : `${projects[at]?.name ?? 'The project'} is back in the list.`, 'info')
        return
      }
      case 'moveUp':
      case 'moveDown':
        reorderProjects(moveBy(projects.map((p) => p.id), projectId, r.data === 'moveUp' ? -1 : 1))
        return
      case 'delete':
        await api.projects.remove(projectId)
        await refreshProjects()
        await refreshConversations()
        await refreshSpend()
        setActiveId(null)
        return
    }
  }

  /** Promoting a message by hand, which the scope always promised. */
  const rememberMessage = useCallback(
    async (text: string): Promise<void> => {
      if (!project) return
      await api.memory.add(project.id, text.slice(0, 280))
      setRemembered(1)
      setTimeout(() => setRemembered(0), 6000)
    },
    [project]
  )

  /** Pasted or dropped; the picker path ends up in the same place. */
  const attachFiles = async (files: File[]): Promise<void> => {
    const added = await ingestFiles(files)
    if (added.length === 0) return
    setPending((list) => {
      const seen = new Set(list.map((a) => a.hash))
      return [...list, ...added.filter((a) => !seen.has(a.hash))]
    })
  }

  /*
    The hotkey: a throwaway conversation in a pop-out, under the project on
    screen or the first there is, without touching what the main window shows.
  */
  const projectRef = useRef(project)
  projectRef.current = project
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const modelRef = useRef(model)
  modelRef.current = model
  const startTurnRef = useRef(startTurn)
  startTurnRef.current = startTurn
  const newConversationRef = useRef<(projectId: string, scratch?: boolean) => Promise<void>>(async () => {})
  useEffect(
    () =>
      api.onQuickQuestion((question) => {
        if (POPPED) return
        // From anywhere on the desktop the question belongs to no project.
        const home = projectsRef.current.find((p) => p.id === GENERAL_PROJECT_ID) ?? projectRef.current ?? projectsRef.current[0]
        const useModel = modelRef.current
        if (!home || !useModel) return
        void (async () => {
          const created = unwrap(await api.conversations.create(home.id, useModel, true))
          await refreshConversations()
          // From the launcher the words are already typed: sent before the window opens, so it opens on the answer arriving.
          if (question && question.trim()) {
            const asked = unwrap(await api.messages.add(created.id, null, 'user', question.trim(), null))
            await api.conversations.rename(created.id, titleFrom(question))
            void startTurnRef.current(created.id, asked.id, useModel)
          }
          await api.popOut(created.id)
        })()
      }),
    [refreshConversations]
  )
  /* The launcher picked a project that has no conversation yet: one is made, and shown. */
  useEffect(
    () =>
      api.onNewConversationIn((projectId) => {
        if (POPPED) return
        void (async () => {
          const created = unwrap(await api.conversations.create(projectId, modelRef.current))
          await refreshConversations()
          setActiveId(created.id)
        })()
      }),
    [refreshConversations]
  )

  /* A project file into the composer, by way of the jail. */
  const attachFromProject = async (path: string): Promise<void> => {
    if (!activeId) return
    const r = await api.attachments.fromProject(activeId, path)
    if (!r.ok || !r.data) {
      notify(r.error ?? `${path} could not be attached.`)
      return
    }
    const a = r.data
    setPending((list) => (list.some((x) => x.hash === a.hash) ? list : [...list, a]))
  }

  const addAttachments = async (): Promise<void> => {
    const r = await api.attachments.pick()
    // A file that is too large, or of a type Harbor cannot read, explains
    // itself here rather than the click appearing to do nothing.
    if (!r.ok) {
      notify(r.error ?? 'Those files could not be attached.')
      return
    }
    setPending((list) => {
      const seen = new Set(list.map((a) => a.hash))
      return [...list, ...(r.data ?? []).filter((a) => !seen.has(a.hash))]
    })
  }

  const newConversation = async (projectId: string, scratch = false): Promise<void> => {
    const created = unwrap(await api.conversations.create(projectId, model, scratch))
    await refreshConversations()
    setActiveId(created.id)
    setDraft('')
  }
  newConversationRef.current = newConversation

  /*
    A quick question is a conversation that is not kept. It runs like any
    other — same project, same tools — but it is never listed, never
    searched, never remembered from, and it is deleted the moment the person
    leaves it, unless they choose to keep it first. Leftovers from a quit are
    swept at the next start.
  */
  const conversationsRef = useRef<Conversation[]>([])
  conversationsRef.current = conversations
  const discardScratch = useCallback(
    async (id: string) => {
      const conv = conversationsRef.current.find((c) => c.id === id)
      if (!conv?.scratch) return
      // A pop-out window holding it keeps it alive; the pop-out's closing is when it goes.
      const popped = await api.isPoppedOut(id)
      if (popped.ok && popped.data) return
      const running = Object.values(turnsRef.current).filter((t) => t.conversationId === id)
      await Promise.all(running.map((t) => api.chat.cancel(t.requestId)))
      await api.conversations.remove(id)
      await refreshConversations()
    },
    [refreshConversations, turnsRef]
  )
  const prevActiveRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActiveRef.current
    prevActiveRef.current = activeId
    if (prev && prev !== activeId) void discardScratch(prev)
  }, [activeId, discardScratch])
  // The pop-out that was holding a throwaway has closed; unless it is on screen here, it goes now.
  useEffect(
    () =>
      api.onPopClosed((id) => {
        if (!POPPED && id !== activeIdRef.current) void discardScratch(id)
      }),
    [discardScratch]
  )
  const keepScratch = async (id: string): Promise<void> => {
    await api.conversations.keep(id)
    await refreshConversations()
  }

  const saveProject = async (patch: Partial<Project>): Promise<void> => {
    const target = sheet.kind === 'project' ? sheet.projectId : null
    if (target) await api.projects.update(target, patch)
    else {
      const created = unwrap(
        await api.projects.create(patch.name ?? 'Untitled', patch.rootPath ?? null)
      )
      await api.projects.update(created.id, patch)
    }
    await refreshProjects()
    setSheet({ kind: 'none' })
  }

  const removeProject = async (): Promise<void> => {
    if (sheet.kind !== 'project' || !sheet.projectId) return
    await api.projects.remove(sheet.projectId)
    await refreshProjects()
    await refreshConversations()
    await refreshSpend()
    setActiveId(null)
    setSheet({ kind: 'none' })
  }

  const deleteMessage = useCallback(
    async (id: string): Promise<void> => {
      await api.messages.remove(id)
      if (activeId) {
        setMessages(unwrap(await api.messages.list(activeId)))
        await refreshConversations()
      }
    },
    [activeId, refreshConversations]
  )

  /*
    The transcript is memoised, and re-renders on every streamed token
    otherwise; these are the same functions across renders so it does not.
  */
  const onPickBranch = useCallback((id: string) => void pickBranch(id), [pickBranch])
  const onDeleteMessage = useCallback((id: string) => void deleteMessage(id), [deleteMessage])
  const onEditMessage = useCallback((id: string, text: string) => void editMessage(id, text), [editMessage])
  const onRetryMessage = useCallback((id: string) => void retryMessage(id), [retryMessage])
  const onSwitchBranch = useCallback((m: Message, d: -1 | 1) => void switchBranch(m, d), [switchBranch])
  const onRememberMessage = useCallback((text: string) => void rememberMessage(text), [rememberMessage])
  const onOpenOriginal = useCallback((leafId: string) => void openOriginal(leafId), [openOriginal])
  const onVote = useCallback((id: string) => void vote(id), [vote])

  /** Writing prose is worth showing rendered; writing code is not. */
  const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path)

  /* --------------------------------------------------------------- render */

  /*
    Each part of the system prompt is its own band, because "System prompt" as
    a single number hid that skills and memory were in there too.
  */
  const TONES: Record<string, string> = {
    'Global instructions': '--ink-faint',
    'Project instructions': '--beacon',
    'Web caution': '--cardinal',
    'Skill index': '--starboard',
    Memory: '--beacon-dim'
  }

  // Counted once per transcript; the streamed text is counted on its own, since it changes per token.
  const historyTokens = useMemo(() => path.reduce((n, m) => n + estimateTokens(m.content), 0), [path])
  // The gauge reads the streaming length from the live store, at most twice a second.
  const liveChars = useLiveLength(activeTurns.map((t) => t.requestId))
  const segments = useMemo<Segment[]>(() => {
    return [
      ...(systemPreview?.sections ?? []).map((sec) => ({
        label: sec.label,
        tokens: sec.tokens,
        tone: TONES[sec.label] ?? '--shoal'
      })),
      { label: 'Conversation', tokens: historyTokens + Math.ceil(liveChars / 4), tone: '--shoal' },
      { label: 'Draft', tokens: estimateTokens(draft), tone: '--ink-dim' }
    ]
  }, [systemPreview, historyTokens, liveChars, draft])

  /*
    Agent mode needs somewhere to work and a model that can call tools. When it
    cannot run, say which of the two is missing rather than failing silently.
  */
  const agentReason = !project?.rootPath
    ? project?.id === GENERAL_PROJECT_ID
      ? 'A chat outside a project has no folder to work in. Start it inside a project to let the model use files.'
      : 'Set a project folder to let the model work with files.'
    : modelInfo && !modelInfo.supportsTools
      ? `${modelInfo.name} cannot call tools, so this is a plain chat.`
      : null

  const conversationStatus = useMemo(() => {
    const map: Record<string, 'running' | 'blocked' | 'failed'> = {}
    for (const id of failedConvIds) map[id] = 'failed'
    for (const t of Object.values(turns)) map[t.conversationId] = 'running'
    for (const id of workersRunning) map[id] = 'running'
    // Blocked outranks running: it is the one that needs you.
    for (const a of approvals) map[a.conversationId] = 'blocked'
    for (const id of workersWaiting.keys()) map[id] = 'blocked'
    return map
  }, [approvals, turns, failedConvIds, workersRunning, workersWaiting])

  /*
    A PDF works on any model because OpenRouter parses it server side, but an
    image needs a model that actually accepts one. Say so before the send
    rather than letting it be quietly ignored.
  */
  /*
    An attachment stays in the conversation, so this has to consider what is
    already there and not only what is about to be sent. Warning once at the
    composer left a conversation that quietly failed on every later turn.
  */
  const visionWarning = useMemo(() => {
    const accepts = modelInfo?.inputModalities ?? ['text']
    if (!modelInfo) return null

    const inHistory: Attachment[] = []
    for (const m of path) {
      if (m.role !== 'user' || !m.attachments) continue
      try {
        inHistory.push(...(JSON.parse(m.attachments) as Attachment[]))
      } catch {
        /* a malformed row should not break the composer */
      }
    }

    const blockedNow = unreadable(pending, accepts)
    if (blockedNow.length > 0) {
      return `${modelInfo.name} cannot read ${blockedNow[0].kind}s. Pick a model that can, or remove it.`
    }

    const blockedBefore = unreadable(inHistory, accepts)
    if (blockedBefore.length > 0) {
      return `${blockedBefore.length === 1 ? 'An attachment' : `${blockedBefore.length} attachments`} earlier in this conversation cannot be read by ${modelInfo.name}, and will be left out.`
    }
    return null
  }, [modelInfo, pending, path])

  const conversationCost = path.reduce((sum, m) => sum + (m.cost ?? 0), 0)

  return (
    <div
      className="shell"
      data-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-popped={POPPED ? 'true' : undefined}
      data-inspector={inspector === 'none' ? 'closed' : 'open'}
      data-resizing={resizing}
      style={{ ['--inspector-w' as string]: `${inspectorWidth}px` }}
    >
      {sidebarOpen && (
        <Sidebar
          projects={projects}
          conversations={conversations}
          activeId={activeId}
          spendByProject={spendByProject}
          status={conversationStatus}
          onSelect={(id) => {
            setActiveId(id)
            // Floating over a narrow window, the sidebar goes when a conversation is chosen from it.
            if (window.innerWidth < 900) setSidebarOpen(false)
            setFailedConvIds((set) => {
              if (!set.has(id)) return set
              const next = new Set(set)
              next.delete(id)
              return next
            })
          }}
          onNew={(id) => void newConversation(id)}
          onAsk={(id) => void newConversation(id, true)}
          // A run is asked about before it is started: the sheet names the project and what an interview is.
          onInterview={() => setSheet({ kind: 'pick-project' })}
          onNewProject={() => setSheet({ kind: 'project', projectId: null })}
          onOpenContext={() => setSheet({ kind: 'context' })}
          onOpenSearch={() => setSheet({ kind: 'search' })}
          onConversationMenu={(c) => void conversationMenu(c)}
          onDeleteMany={deleteMany}
          onArchiveMany={archiveMany}
          onSelectionMenu={selectionMenu}
          onProjectMenu={(id) => void projectMenu(id)}
          onReorderProjects={reorderProjects}
          showArchived={showArchived}
          onEditProject={(id) => setSheet({ kind: 'project', projectId: id })}
          onOpenUsage={() => setSheet({ kind: 'usage' })}
          onOpenSettings={() => setSheet({ kind: 'settings' })}
          onOpenLog={() => setSheet({ kind: 'log' })}
          onToggle={() => setSidebarOpen(false)}
        />
      )}

      <main className="conv">
        <ConversationHeader
          active={active}
          project={project}
          popped={!!POPPED}
          sidebarOpen={sidebarOpen}
          onShowSidebar={() => setSidebarOpen(true)}
          titleRef={titleRef}
          onTitleChange={(title) => {
            if (active) setConversations((cs) => cs.map((c) => (c.id === active.id ? { ...c, title } : c)))
          }}
          onTitleBlur={() => {
            if (active) void api.conversations.rename(active.id, active.title)
          }}
          conversationCost={conversationCost}
          onStartDirector={() => {
            // The director plans from this interview's requirements, in this interview's run folder.
            if (project) setSheet({ kind: 'director', projectId: project.id, fromInterview: active?.role === 'interview' ? active.id : null })
          }}
          runView={runView}
          onToggleRunView={() => setRunView((v) => !v)}
          runStatus={runStatus}
          waitingOnYou={board.filter((t) => t.status === 'blocked').length + workersWaiting.size}
          onShowWaiting={() => {
            setRunView(true)
            // After the run view is on screen.
            setTimeout(() => document.getElementById('run-waiting')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
          }}
          budgetEdit={budgetEdit}
          setBudgetEdit={setBudgetEdit}
          commitBudget={() => {
            if (active) void commitBudget(active.id)
          }}
          busy={(active ? activeTurns.some((t) => t.conversationId === active.id) : false) || workersRunning.size > 0}
          onFinishRun={() => {
            if (active) void finishRun(active.id)
          }}
          onApprovePlan={() => {
            if (active) void approvePlan(active.id)
          }}
          onKeepScratch={() => {
            if (active) void keepScratch(active.id)
          }}
          onDiscardScratch={() => {
            if (!active) return
            const id = active.id
            setActiveId(null)
            void discardScratch(id)
          }}
          inspector={inspector}
          toggleInspector={toggleInspector}
          unreviewed={unreviewed}
          onOpenChanges={() => {
            setUnreviewed(false)
            toggleInspector('changes')
          }}
          goal={active?.goal ? { text: active.goal, state: (active.goalState ?? 'pursuing') as GoalState, turns: active.goalTurns } : null}
          onClearGoal={() => {
            if (!active) return
            void api.goal.clear(active.id).then(() => refreshConversations())
          }}
        />

        {active?.role === 'director' && runView ? (
          <RunView
            status={runStatus}
            board={board}
            workers={runWorkers}
            running={workersRunning}
            asking={workersWaiting}
            directorBusy={activeTurns.some((t) => t.conversationId === active.id)}
            lastMessage={[...path].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? ''}
            onOpenWorker={(id) => setActiveId(id)}
            onApprove={() => void approvePlan(active.id)}
            onFinish={() => void finishRun(active.id)}
            reviews={reviews}
            onTakeSuggestion={(reviewId, index, text) => {
              // Into the director's box, for the person to read, change and send: Claude's word never reaches the director on its own.
              setDraft(text)
              setRunView(false)
              void setSuggestion(reviewId, index, 'sent')
            }}
            onDismissSuggestion={(reviewId, index) => void setSuggestion(reviewId, index, 'dismissed')}
            onAnswer={(t) => {
              // The item named at the start of a new line, so several can be answered in one reply.
              const head = `**${t.id} (${t.title}):** `
              setDraft(draft.trim() ? `${draft.trimEnd()}\n\n${head}` : head)
              setComposerFocus((n) => n + 1)
            }}
          />
        ) : active || path.length > 0 ? (
          <Stream
            conversationId={activeId}
            all={messages}
            path={path}
            live={liveByMessage}
            pending={pendingTurns}
            compareParent={compareParent}
            onCompare={setCompareParent}
            onPickBranch={onPickBranch}
            onDelete={onDeleteMessage}
            onEdit={onEditMessage}
            onRetry={onRetryMessage}
            onSwitch={onSwitchBranch}
            onRemember={onRememberMessage}
            onOpenOriginal={onOpenOriginal}
            ratings={ratings}
            onVote={onVote}
            onAside={aside}
          />
        ) : (
          <div className="empty">
            <div className="empty__title">Harbor</div>
            <p className="empty__body">
              {hasKey
                ? 'Pick a model and start a conversation. Everything you write stays on this machine.'
                : 'Add an OpenRouter key in Settings, then pick a model and start.'}
            </p>
            {!hasKey && (
              <button className="btn btn--primary" onClick={() => setSheet({ kind: 'settings' })}>
                Open Settings
              </button>
            )}
          </div>
        )}

        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          onStop={() => void stop()}
          // A worker waiting on you keeps its turn open; what you type is the answer, so the box must send.
          streaming={activeTurns.length > 0 && !(active && workersWaiting.has(active.id))}
          fanOut={
            model
              ? {
                  candidates: planFanOut(model, favorites, FAN_OUT_MAX + 6).map((v) => ({
                    id: v.model,
                    name: models.find((m) => m.id === v.model)?.name ?? v.model,
                    current: v.model === model
                  })),
                  layout,
                  onAsk: (variants) => void submit(variants),
                  onSaveLayout: (variants) => void saveLayout(variants)
                }
              : null
          }
          model={model}
          onPickModel={() => setSheet({ kind: 'models' })}
          onOpenParams={active ? () => setSheet({ kind: 'params' }) : null}
          segments={segments}
          focusKey={`${active?.id ?? ''}:${composerFocus}`}
          contextLength={modelInfo?.contextLength ?? 0}
          disabled={!canChat}
          agent={{
            on: agentOn,
            toggle: () => setAgentOn((v) => !v),
            reason: agentReason
          }}
          plan={
            agentOn && !agentReason
              ? { on: planOn, toggle: () => setPlanOn((v) => !v) }
              : null
          }
          auto={
            agentOn && !agentReason && project?.rootPath
              ? {
                  on: project.autoApprove,
                  toggle: () => {
                    void (async () => {
                      await api.projects.update(project.id, { autoApprove: !project.autoApprove })
                      await refreshProjects()
                    })()
                  }
                }
              : null
          }
          web={{ on: webOn, toggle: () => setWebOn((v) => !v) }}
          reasoning={
            modelInfo?.supportsReasoning
              ? modelInfo.reasoning?.mandatory
                ? { on: true, toggle: () => {}, locked: true }
                : { on: reasoningOn, toggle: () => setReasoningOn((v) => !v) }
              : null
          }
          prompts={prompts}
          onCommand={runCommand}
          onInspectPrompt={() => setSheet({ kind: 'prompt' })}
          attachments={pending}
          onAttach={() => void addAttachments()}
          onFiles={(files) => void attachFiles(files)}
          onRemoveAttachment={(hash) =>
            setPending((list) => list.filter((a) => a.hash !== hash))
          }
          visionWarning={visionWarning}
          approvals={
            <Approval
              approvals={approvals.filter((a) => a.conversationId === activeId)}
              onDecide={(id, decision) => void api.commands.decide(id, decision)}
            />
          }
          notices={<Notices />}
          placeholder={active?.role === 'interview' && messages.length === 0 ? INTERVIEW_OPENING : undefined}
          todos={
            active?.role === 'director' && runStatus && !runStatus.approved && board.length > 0 ? (
              <div className="gate">
                <span>
                  The plan is written. Read <code>{filesOf(active.runDir).design}</code> and <code>{filesOf(active.runDir).tasks}</code>, then
                  press Approve plan. Saying so in the chat does not open the gate.
                </span>
                <button className="btn btn--small btn--primary gate__go" onClick={() => void approvePlan(active.id)}>
                  Approve plan
                </button>
              </div>
            ) : remembered > 0 ? (
              /* Extraction happens without being asked, so it says so. */
              <button className="remembered" onClick={() => setSheet({ kind: 'context' })}>
                Remembered {remembered} {remembered === 1 ? 'thing' : 'things'} from this
                conversation. Review in Context.
              </button>
            ) : null
          }
        />
      </main>

      {inspector !== 'none' && (
        <Inspector
          mode={inspector}
          conversationId={activeId}
          changesTick={changesTick}
          blocks={activeId ? (terminal[activeId] ?? []) : []}
          onRunCommand={(cmd) => {
            if (!activeId) return
            void api.commands
              .runFromTerminal(activeId, cmd)
              .then((r) => ok(r, 'That command could not be run.'))
          }}
          onKill={(handle) => void api.commands.kill(handle)}
          onReverted={() => void reloadMessages()}
          filePath={filePath}
          fileTick={fileTick}
          // Closing the file goes back to the tree, with the file still marked in it.
          progress={
            active?.role === 'director' && board.length > 0
              ? board.map((t) => ({ content: `${t.id} — ${t.title}`, status: t.status }))
              : activeId
                ? (progress[activeId] ?? [])
                : []
          }
          progressLive={activeTurns.some((t) => t.todos.length > 0)}
          onCloseFile={() => setInspector('explorer')}
          onClose={() => setInspector('none')}
          rootPath={project?.rootPath ?? ''}
          rootName={project?.rootPath?.split('/').pop() ?? project?.name ?? ''}
          onOpenFile={openFile}
          onAttachFile={(p) => void attachFromProject(p)}
          onResizeStart={beginResize}
          onResizeReset={resetResize}
        />
      )}

      {sheet.kind === 'models' && (
        <ModelPicker
          models={models}
          favorites={favorites}
          current={model}
          loading={modelsLoading}
          error={modelsError}
          onPick={(id) => {
            setSheet({ kind: 'none' })
            // A cache is per model: a warm one is left behind by a switch, and the next turn pays in full.
            const lastReply = [...path].reverse().find((m) => m.role === 'assistant' && (m.cachedTokens ?? 0) > 0)
            if (active && id !== model && lastReply) notify('Switching models leaves this conversation\'s cached prefix behind; the next turn is billed in full and warms a new one.', 'info')
            void pickModel(id)
          }}
          onToggleFavorite={(id) => void toggleFavorite(id)}
          onRefresh={() => void loadModels()}
          onClose={() => setSheet({ kind: 'none' })}
        />
      )}

      {sheet.kind === 'settings' && (
        <Settings
          status={keyStatus}
          project={project}
          models={models}
          onSave={saveKey}
          onClear={() => void clearKey()}
          onClose={() => setSheet({ kind: 'none' })}
        />
      )}

      {sheet.kind === 'prompt' && (
        <PromptSheet system={systemPreview} onClose={() => setSheet({ kind: 'none' })} />
      )}

      {sheet.kind === 'params' && active && (
        <Sheet title="Parameters" aside={<span className="sounding">{modelInfo?.name ?? model}</span>} onClose={() => setSheet({ kind: 'none' })}>
            <div className="sheet__body">
              <p className="tabs__blurb">
                For this conversation. Anything left alone follows the project.
              </p>
              <Parameters
                model={modelInfo}
                effective={effectiveParams}
                own={active.params}
                inheritLabel="project"
                onChange={(next) => {
                  setConversations((cs) =>
                    cs.map((c) => (c.id === active.id ? { ...c, params: next } : c))
                  )
                  void api.conversations.setParams(active.id, next)
                }}
              />
            </div>
        </Sheet>
      )}

      {sheet.kind === 'log' && <LogSheet onClose={() => setSheet({ kind: 'none' })} />}

      {sheet.kind === 'search' && (
        <SearchSheet
          projects={projects}
          onOpen={(id) => setActiveId(id)}
          onClose={() => setSheet({ kind: 'none' })}
        />
      )}

      {sheet.kind === 'context' && (
        <ContextSheet project={project} onClose={() => setSheet({ kind: 'none' })} />
      )}

      {sheet.kind === 'usage' && (
        <UsageSheet projects={projects} onClose={() => setSheet({ kind: 'none' })} />
      )}

      {sheet.kind === 'pick-project' && (
        <Sheet title="Plan a run" aside={<span className="sounding">in which project?</span>} onClose={() => setSheet({ kind: 'none' })}>
            <div className="sheet__body">
              <p className="tabs__blurb">
                Choosing a project starts an interview in it: a conversation that gathers the requirements into the project's own _director folder, for a director to plan and work from. Nothing runs until you approve the plan.
              </p>
              <div className="pick">
                {projects.filter((p) => p.id !== GENERAL_PROJECT_ID && !p.archived).map((p) => (
                  <button
                    key={p.id}
                    className="pick__row"
                    aria-current={p.id === project?.id}
                    disabled={!p.rootPath}
                    title={p.rootPath ?? 'This project has no folder, so a run has nowhere to work.'}
                    onClick={() => void startInterview(p.id)}
                   aria-label={p.rootPath ?? 'This project has no folder, so a run has nowhere to work.'}>
                    <span className="pick__name">{p.name}</span>
                    <span className="sounding pick__path">{p.rootPath ?? 'no folder'}</span>
                  </button>
                ))}
              </div>
            </div>
        </Sheet>
      )}
      {sheet.kind === 'director' &&
        (() => {
          const target = projects.find((p) => p.id === sheet.projectId)
          return target ? (
            <DirectorSheet
              project={target}
              models={models}
              currentModel={model ?? ''}
              requirements={runFiles(conversations.find((c) => c.id === sheet.fromInterview)?.runDir ?? '').requirements}
              fromInterview={!!sheet.fromInterview}
              onStart={(m, b, r) => startDirector(target.id, m, b, r, sheet.fromInterview ?? null)}
              onClose={() => setSheet({ kind: 'none' })}
            />
          ) : null
        })()}
      {sheet.kind === 'project' && (
        <ProjectSheet
          project={projects.find((p) => p.id === sheet.projectId) ?? null}
          models={models}
          spend={sheet.projectId ? (spendByProject[sheet.projectId] ?? 0) : 0}
          onSave={(patch) => void saveProject(patch)}
          onDelete={sheet.projectId && projects.length > 1 ? () => void removeProject() : null}
          onClose={() => setSheet({ kind: 'none' })}
        />
      )}
    </div>
  )
}
