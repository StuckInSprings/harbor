import type { Attachment, Message, RunOptions, TodoItem, ToolRun } from '../../shared/types'
import * as db from './db'
import * as or from './openrouter'
import { toolSchemas, execute, subjectOf, validateArgs, type ToolContext } from './tools'
import { coreOps } from './tools/core'
import { directorOps, runCeiling } from './tools/director'
import type { Emit, EmitTerminal, Turn } from './turn'
import { pathToLeaf } from './thread'
import * as attachments from './attachments'
import { canSendTo, noteForOmitted } from '../../shared/attachments'
import * as skills from './skills'
import * as memory from './memory'
import * as log from './log'
import * as routing from './routing'
import * as compaction from './compact'
import * as shadow from './shadow'
import * as otel from './otel'
import * as worktrees from './worktrees'
import { stillRunning, toolLabel } from '../../shared/activity'
import { BUDGET_RESERVE, writeScope } from '../../shared/director'
import { PLAN_TIER, parseTiers, tierModel } from '../../shared/tiers'
import { assembleSystem, toWireSystem } from './context'
import { TRIM_AT, chooseTrim, estimateWireTokens, resultStub, shouldCompact } from '../../shared/compact'
import { spillIfLarge } from './spill'
import { rulesForPath, scopedBlock } from './rules'
import { createHash } from 'node:crypto'

/**
 * A turn, owned end to end by the main process.
 *
 * The renderer asks for a turn and watches events; everything else — assembling
 * the prompt, running the tool loop, writing messages — happens here, because
 * this is where the database, the tools and the path jail live. Phase 5 adds
 * skills, knowledge and memory to buildPrompt for the same reason.
 */

/**
 * How many tool calls a single turn may make before stopping to ask, when
 * the person has not said otherwise. Twenty-five was a loop-catcher that
 * caught every real piece of work instead; the setting overrides it, and
 * zero means no ceiling at all — the Stop button and the budget are the
 * limits then.
 */
const STEP_CEILING = 100
export const STEP_SETTING = 'step_ceiling'
function stepCeiling(): number {
  const raw = db.getSetting(STEP_SETTING)
  if (raw === null || raw === undefined || raw.trim() === '') return STEP_CEILING
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : STEP_CEILING
}
/** A run is meant to be left alone, and its limit is money, not steps; this only catches a loop. */
const UNATTENDED_STEP_CEILING = 400


interface WireMessage {
  role: string
  content: string
  tool_calls?: unknown
  tool_call_id?: string
  reasoning_details?: unknown
}

/**
 * A user message with attachments becomes a content-parts array rather than a
 * string. Async because the bytes live in the blob store, not the row.
 */
async function toWireAsync(m: Message, accepts: string[], model: string): Promise<WireMessage | null> {
  const plain = toWire(m, model)
  if (!plain || m.role !== 'user' || !m.attachments) return plain

  let list: Attachment[] = []
  try {
    list = JSON.parse(m.attachments) as Attachment[]
  } catch {
    return plain
  }
  if (list.length === 0) return plain

  const parts: unknown[] = []
  if (m.content.trim()) parts.push({ type: 'text', text: m.content })
  for (const a of list) {
    // Cleared to make room: the picture went, a line saying so stays.
    if (m.trimmed && (a.kind === 'image' || a.kind === 'pdf')) {
      parts.push({ type: 'text', text: `[${a.name} was attached here and was cleared from the context to make room.]` })
      continue
    }
    /*
      Sending an image to a model that cannot read one fails the request, and
      the attachment stays in the conversation — so without this every later
      turn fails the same way and the conversation can never be used again.
    */
    if (!canSendTo(a, accepts)) {
      parts.push({ type: 'text', text: noteForOmitted(a) })
      continue
    }
    const part = await attachments.toContentPart(a)
    if (part) parts.push(part)
  }
  return { role: 'user', content: parts as unknown as string }
}

/**
 * Two user messages in a row, joined into one. It happens whenever a row
 * between them is dropped from the wire (a reply that errored, a blank
 * one) and at the head of a compacted branch, whose summary is a user
 * message followed by the first kept user message; and some providers
 * refuse a conversation shaped like that.
 */
export function coalesceUsers(history: WireMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  const parts = (c: unknown): unknown[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : (c as unknown[]))
  for (const m of history) {
    const prev = out[out.length - 1]
    if (m.role === 'user' && prev?.role === 'user') {
      if (typeof prev.content === 'string' && typeof m.content === 'string') {
        prev.content = `${prev.content}\n\n${m.content}`
      } else {
        prev.content = [...parts(prev.content), ...parts(m.content)] as unknown as string
      }
      continue
    }
    out.push({ ...m })
  }
  return out
}

/**
 * A stored message as the model sees it. `model` is the one being asked
 * now: an assistant row carries its provider's reasoning blocks back only
 * when the same model wrote them, since the blocks are signed per provider
 * and another one would refuse them.
 */
export function toWire(m: Message, model = ''): WireMessage | null {
  if (m.error) return null
  if (m.role === 'tool') {
    return { role: 'tool', content: m.trimmed ? resultStub(m.content) : m.content, tool_call_id: m.toolCallId ?? '' }
  }
  const reasoning = (): { reasoning_details?: unknown } => {
    if (!m.reasoningDetails || !model || m.model !== model) return {}
    try {
      const parsed: unknown = JSON.parse(m.reasoningDetails)
      return Array.isArray(parsed) && parsed.length ? { reasoning_details: parsed } : {}
    } catch {
      return {}
    }
  }
  if (m.role === 'assistant' && m.toolCalls) {
    return { role: 'assistant', content: m.content, tool_calls: JSON.parse(m.toolCalls), ...reasoning() }
  }
  if (m.content.trim() === '') return null
  if (m.role === 'assistant') return { role: 'assistant', content: m.content, ...reasoning() }
  return { role: m.role, content: m.content }
}

async function buildPrompt(
  conversationId: string,
  parentId: string | null,
  accepts: string[],
  system: unknown | null,
  /*
    Some models want their instructions inside the user turn rather than in a
    system role. Two consecutive user messages upset some providers, so the
    text is folded into the first one instead of being prepended as its own.
  */
  foldIntoFirstUser = '',
  model = ''
): Promise<unknown[]> {
  const all = db.listMessages(conversationId)
  const resolved = await Promise.all(
    pathToLeaf(all, parentId).map((m) => toWireAsync(m, accepts, model))
  )
  const history = coalesceUsers(resolved.filter((m): m is WireMessage => m !== null))

  if (foldIntoFirstUser) {
    const first = history.findIndex((m) => m.role === 'user')
    if (first >= 0) {
      history[first] = {
        ...history[first],
        content: `${foldIntoFirstUser}\n\n---\n\n${history[first].content}`
      }
    } else {
      history.unshift({ role: 'user', content: foldIntoFirstUser })
    }
    return history
  }

  return system ? [system, ...history] : history
}

/**
 * Nothing may leave a turn without telling the renderer.
 *
 * The work below has a try/catch around its loop, but the setup before it —
 * loading skills, assembling context — did not. ipc.ts starts a turn with
 * `void`, so anything thrown there was swallowed and no error event was ever
 * emitted, leaving the interface waiting on a reply that was never coming.
 */
/** Which conversation each running request belongs to, so an event can say. */
const owners = new Map<string, string>()
export const conversationOf = (requestId: string): string | undefined => owners.get(requestId)
/** The turns still running, by request: owners outlives a turn by a few seconds, this does not. */
const running = new Map<string, string>()
/** The requests running in a conversation now; empty when it is idle. */
export const runningIn = (conversationId: string): string[] => [...running].filter(([, c]) => c === conversationId).map(([r]) => r)

export async function runTurn(
  opts: RunOptions & { requestId: string },
  emit: Emit,
  emitTerminal: EmitTerminal
): Promise<void> {
  const started = Date.now()
  owners.set(opts.requestId, opts.conversationId)
  running.set(opts.requestId, opts.conversationId)
  const span = otel.startTurn(
    opts.requestId,
    {
      'gen_ai.agent.name': db.getConversation(opts.conversationId)?.role ?? 'chat',
      'gen_ai.request.model': opts.model,
      'gen_ai.conversation.id': opts.conversationId,
      'harbor.request.id': opts.requestId,
      'harbor.agent': opts.agent,
      'harbor.plan': opts.plan,
      'harbor.web': opts.web
    },
    opts.parentRequestId
  )
  log.info('turn', 'start', {
    id: opts.requestId.slice(0, 8),
    model: opts.model,
    agent: opts.agent,
    plan: opts.plan,
    web: opts.web,
    reasoning: opts.reasoning
  })
  try {
    await runTurnInner(opts, emit, emitTerminal)
    log.info('turn', 'end', { id: opts.requestId.slice(0, 8), ms: log.since(started) })
    span.end({ 'harbor.cost_usd': db.conversationCost(opts.conversationId) })
  } catch (e) {
    owners.delete(opts.requestId)
    log.error('turn', 'failed outside the loop', {
      id: opts.requestId.slice(0, 8),
      ms: log.since(started),
      error: (e as Error).message
    })
    span.end({}, (e as Error).message)
    emit({ type: 'error', requestId: opts.requestId, message: (e as Error).message })
    or.endRequest(opts.requestId)
  } finally {
    running.delete(opts.requestId)
    // After the last event has gone out, since the renderer reads the owner off it.
    setTimeout(() => owners.delete(opts.requestId), 5_000)
  }
}

async function runTurnInner(
  opts: RunOptions & { requestId: string },
  emit: Emit,
  emitTerminal: EmitTerminal
): Promise<void> {
  const { requestId, conversationId } = opts
  let model = opts.model
  let contextLength = opts.contextLength
  or.beginRequest(requestId)
  emit({ type: 'phase', requestId, phase: 'assembling' })

  const conversation = db.getConversation(conversationId)
  const project = conversation ? db.getProject(conversation.projectId) : null
  const root = worktrees.rootOverride(conversationId) ?? project?.rootPath ?? null
  /*
    The whole tree, before an agent turn touches it and after it has: the
    way back from what a command did, which the checkpoints cannot see. A
    worker in a worktree has git's own history there and is skipped.
  */
  const snapshots = !!(opts.agent && project?.rootPath && root === project.rootPath)
  const treeSnapshot = async (kind: 'before' | 'after'): Promise<void> => {
    if (!snapshots || !project?.rootPath) return
    const sha = await shadow.snapshot(project.id, project.rootPath, `${kind} turn ${requestId.slice(0, 8)} in ${conversationId.slice(0, 8)}`)
    if (sha) db.addSnapshot({ runId: requestId, conversationId, projectId: project.id, kind, sha })
  }
  await treeSnapshot('before')

  const projectId = project?.id ?? null
  const available = projectId ? await skills.list(projectId, root) : []
  const hasKnowledge = projectId ? db.listSources(projectId).some((s) => s.chunks > 0) : false

  /*
    One assembly path, shared with the prompt inspector, so what is shown is
    what is sent. See electron/main/context.ts.
  */
  const contextAt = Date.now()
  const plan = opts.agent && opts.plan === true
  /*
    A plan-mode turn runs on the project's `plan` tier when it names one:
    a model that thinks well can plan while a cheaper one edits. The
    swap costs a cache miss, which the cache line will name.
  */
  if (plan && project?.tiers) {
    const planModel = tierModel(parseTiers(project.tiers), PLAN_TIER, opts.model)
    if (planModel !== opts.model) {
      model = planModel
      contextLength = (await or.contextLengthOf(planModel)) || opts.contextLength
      log.info('turn', 'plan mode on the plan tier', { asked: opts.model, model: planModel })
    }
  }
  const role = conversation?.role ?? 'chat'
  const scopeOf = (isApproved: boolean): { writeGlobs: string[]; gated: boolean; frozen: (path: string) => string | null } => {
    const w = writeScope({ role, approved: isApproved, runDir: conversation?.runDir ?? null, workerGlobs: conversation?.writeGlobs ?? [], projectGlobs: project?.writeGlobs ?? [] })
    return { writeGlobs: w.globs, gated: w.gated, frozen: w.frozen }
  }
  let approved = conversation?.approved ?? false
  let assembled = await assembleSystem({ projectId, model, web: opts.web, plan, role, conversationId })
  log.info('turn', 'context assembled', {
    ms: log.since(contextAt),
    skills: available.length,
    knowledge: hasKnowledge,
    chars: assembled.text.length
  })
  if (assembled.memoryIds.length) db.markMemoriesUsed(assembled.memoryIds)
  const asUser = project?.systemAsUser === true
  let system = asUser ? null : toWireSystem(assembled)

  // MCP tools the model has looked up this turn; their schemas ride along from the next step.
  const loadedTools = new Set<string>()
  // Rules files whose instructions have been appended to a result this turn.
  const rulesSeen = new Set<string>()
  const pickTools = (): unknown[] | undefined =>
    opts.agent
      ? toolSchemas({
          hasWorkspace: !!root,
          hasSkills: available.length > 0,
          hasKnowledge,
          plan,
          role,
          approved,
          loaded: loadedTools
        })
      : undefined
  let tools = pickTools()

  let parentId = opts.parentId
  let steps = 0
  /** The model request in flight, as a span, so a failure ends it with the reason. */
  let openStep: otel.Handle | null = null
  let todos: TodoItem[] = []
  let lastAssistantId: string | null = null
  // The reply being streamed, so a Stop keeps what had arrived.
  let partial: { id: string; text: string } | null = null
  let sawWeb = false
  /** What the tool being executed has spent, recorded on its result row. */
  let toolSpend = 0

  const turn: Turn = {
    id: requestId,
    conversationId,
    conversation,
    project,
    projectId,
    root,
    unlocked: project?.unlocked ?? [],
    role,
    model,
    plan,
    emit,
    emitTerminal,
    signal: () => or.signalFor(requestId),
    cancelled: () => or.isCancelled(requestId),
    webUsed: () => sawWeb,
    spend: (amount) => {
      toolSpend += amount
    },
    loadTools: (names) => {
      for (const n of names) loadedTools.add(n)
      tools = pickTools()
    },
    runNested: runTurn
  }

  const ctx: ToolContext = {
    projectId,
    webUsed: () => sawWeb,
    root: root ?? '',
    unlocked: project?.unlocked ?? [],
    runId: requestId,
    conversationId,
    plan,
    // Who may write what, by role; see writeScope. The requirements and other runs' folders are frozen by the jail, not by a prompt.
    ...scopeOf(approved),
    onTodos: (items) => {
      todos = items
      emit({ type: 'todos', requestId, items })
    },
    onWrote: (path) => emit({ type: 'wrote', requestId, path }),
    ...coreOps(turn),
    ...directorOps(turn)
  }

  /*
    Room, checked before every step. A prompt that will not fit used to fail
    with context_length_exceeded, and once it was checked only before the
    first step, so a hundred-step run outgrew its window mid-turn anyway.
    Three things happen in order, each only if the one before was not
    enough: old tool results and images are cleared from the context (marked
    on the row, so the cached prefix rebuilds once and then holds); then the
    older part is summarised onto a fresh branch and the turn carries on
    from there, the original untouched. Compaction always cuts at a user
    message, so a tool call is never parted from its result.
  */
  const roomCheck = async (): Promise<void> => {
    if (!(contextLength > 0) || !parentId) return
    const measure = async (): Promise<number> =>
      estimateWireTokens(await buildPrompt(conversationId, parentId, opts.accepts, system, asUser ? assembled.text : '', model))
    let promptTokens = await measure()
    if (promptTokens > TRIM_AT * contextLength) {
      const path = pathToLeaf(db.listMessages(conversationId), parentId)
      const trim = chooseTrim(path)
      if (trim.results.length || trim.images.length) {
        db.markTrimmed([...trim.results, ...trim.images].map((m) => m.id))
        log.info('compact', 'context trimmed; the cache prefix rebuilds once', { results: trim.results.length, images: trim.images.length, promptTokens, contextLength })
        emit({ type: 'trimmed', requestId, results: trim.results.length, images: trim.images.length })
        promptTokens = await measure()
      }
    }
    const reserve = Math.min(opts.params.maxTokens ?? 8192, Math.floor(contextLength / 4))
    if (!shouldCompact(promptTokens, contextLength, reserve)) return
    log.warn('compact', 'prompt too large, compacting first', { promptTokens, contextLength })
    emit({ type: 'phase', requestId, phase: 'assembling' })
    const summariser = db.getSetting('extraction_model') || model
    const keep = Math.min(Math.floor(contextLength * 0.2), 12_000)
    const before = pathToLeaf(db.listMessages(conversationId), parentId)
    const done = await compaction.compact(conversationId, parentId, keep, compaction.withModel(summariser, or.signalFor(requestId)))
    if (done) {
      parentId = done.leafId
      // A skill the summarised part had loaded rides on the summary whole; the model still has to follow it.
      const carried = await compaction.carrySkills(conversationId, before, done.summaryId, done.leafId, async (name) => (await skills.get(projectId, name, root))?.body ?? null)
      if (carried.length) log.info('compact', 'skills carried onto the summary', { skills: carried })
      emit({ type: 'compacted', requestId, summarised: done.summarised, summaryId: done.summaryId })
    }
  }

  try {
    for (;;) {
      await roomCheck()
      /*
        A run's ceiling is money, not time. A director over its budget gets
        no further step; the turn ends with a plain line, and the handoff it
        should have written by now is what the person has.
      */
      const ceiling = runCeiling(conversation)
      if (ceiling) {
        const spent = db.runCost(ceiling.directorId)
        if (spent >= ceiling.limit) {
          log.warn('director', role === 'worker' ? "workers' share of the budget spent" : 'budget spent', { spent, limit: ceiling.limit, budget: ceiling.budget })
          const why =
            role === 'worker'
              ? `The run's workers have spent their share of the budget ($${spent.toFixed(2)} of $${ceiling.budget.toFixed(2)}, with the last ${Math.round(BUDGET_RESERVE * 100)}% kept for the director). Stopping here.`
              : `The run's budget is spent ($${spent.toFixed(2)} of $${ceiling.budget.toFixed(2)}). Click the amount in the header to raise it, then send "continue".`
          // A worker's reason for stopping must reach the director, so it is the worker's last word.
          if (role === 'worker') db.addMessage(conversationId, parentId, 'assistant', `STOPPED: ${why}`, model)
          emit({ type: 'error', requestId, message: why })
          break
        }
      }
      /*
        Approval is a button in the header, and the person may press it while
        the director is mid-turn — or after typing "approved" into the chat,
        which opens nothing. Each step reads the flag again, so the gate opens
        on the next step rather than the next turn, and the prompt says so.
      */
      if (role === 'director') {
        const fresh = db.getConversation(conversationId)
        if (fresh && fresh.approved !== approved) {
          approved = fresh.approved
          tools = pickTools()
          Object.assign(ctx, scopeOf(approved))
          assembled = await assembleSystem({ projectId, model, web: opts.web, plan, role, conversationId })
          system = asUser ? null : toWireSystem(assembled)
          log.info('director', approved ? 'approved mid-turn; the gate is open from this step' : 'approval withdrawn mid-turn')
        }
      }
      const placeholder = db.addMessage(conversationId, parentId, 'assistant', '', model, { label: opts.label ?? null })
      lastAssistantId = placeholder.id
      partial = { id: placeholder.id, text: '' }
      emit({ type: 'begin', requestId, messageId: placeholder.id })
      // Every step after the first rebuilds the prompt, which reads
      // attachments off disk and is not always quick.
      emit({ type: 'phase', requestId, phase: 'assembling' })

      let streamed = ''
      const stepAt = Date.now()
      openStep = otel.startSpan('chat', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': model, 'harbor.step': steps, 'harbor.tools': (tools ?? []).length }, otel.turnSpan(requestId), 'client')
      const result = await or.streamCompletion(
        requestId,
        {
          model,
          messages: await buildPrompt(
            conversationId,
            parentId,
            opts.accepts,
            system,
            asUser ? assembled.text : '',
            model
          ),
          /*
            Web search is a server tool: OpenRouter runs it when the model
            asks, as often as the model asks up to the cap, and the pages
            come back as url_citation annotations rather than as a tool
            call for Harbor to run. The `web` plugin it replaces is
            deprecated upstream.
          */
          tools: [...(tools ?? []), ...(opts.web ? [WEB_SEARCH_TOOL] : [])],
          /*
            cloudflare-ai parses a PDF to markdown for free, and OpenRouter
            applies it server side, so PDFs work even on text-only models.
          */
          plugins: hasPdf(conversationId, parentId) ? [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }] : [],
          reasoning: opts.reasoning,
          params: opts.params,
          routing: routing.current(),
          // The provider that holds this conversation's cache is the one asked again.
          sessionId: conversationId
        },
        (text) => {
          streamed += text
          if (partial) partial.text = streamed
          emit({ type: 'delta', requestId, text })
        },
        (text) => emit({ type: 'reasoning', requestId, text }),
        (phase) => emit({ type: 'phase', requestId, phase, detail: model })
      )

      log.info('turn', 'step complete', {
        ms: log.since(stepAt),
        finish: result.finishReason,
        chars: result.content.length,
        toolCalls: result.toolCalls.length
      })
      openStep.end({
        'gen_ai.response.model': result.servedBy,
        'gen_ai.response.finish_reasons': result.finishReason,
        'gen_ai.usage.input_tokens': result.usage.promptTokens,
        'gen_ai.usage.output_tokens': result.usage.completionTokens,
        'gen_ai.usage.cached_input_tokens': result.usage.cachedTokens,
        'harbor.reasoning_tokens': result.usage.reasoningTokens,
        'harbor.cost_usd': result.usage.cost,
        'harbor.tool_calls': result.toolCalls.length
      })
      openStep = null
      // A fallback answering is worth knowing about, and the message should
      // name the model that wrote it rather than the one that was asked.
      const fellBack = result.servedBy !== null && result.servedBy !== model
      if (fellBack) log.warn('turn', 'served by a fallback', { asked: model, got: result.servedBy })
      if (result.citations.length) sawWeb = true

      /*
        A model can answer with nothing at all — no text, no tool call, and
        finish_reason "stop". Left alone that becomes a blank message, which is
        indistinguishable from the app having done nothing, so it is reported
        as the failure it is.
      */
      const said = (result.content || streamed).trim()
      const saidNothing = said === '' && result.toolCalls.length === 0
      /*
        A reply the token limit cut off mid tool call carries arguments that
        stop partway, which parse as nothing at all. Running that would run
        the tool with no arguments; the honest outcome is to say what
        happened and let the person raise the limit.
      */
      const cutOff = result.finishReason === 'length' && result.toolCalls.length > 0
      if (cutOff) log.warn('turn', 'tool call cut off by the token limit', { calls: result.toolCalls.length })
      const toolCalls = cutOff ? [] : result.toolCalls
      if (saidNothing) {
        log.warn('turn', 'empty reply', {
          finish: result.finishReason,
          promptTokens: result.usage.promptTokens
        })
      }

      db.finalizeMessage(placeholder.id, {
        content: result.content || streamed,
        error: saidNothing
          ? `${model} replied with nothing (${result.finishReason ?? 'no reason given'}). It may be overloaded — try again, or pick another model.`
          : cutOff
            ? 'The reply hit the token limit in the middle of a tool call, so nothing was run. Raise the reply length in Parameters, or ask for less at a time.'
            : null,
        reasoning: result.reasoning || null,
        reasoningDetails: result.reasoningDetails.length ? JSON.stringify(result.reasoningDetails) : null,
        toolCalls: toolCalls.length ? JSON.stringify(toWireCalls(toolCalls)) : null,
        citations: result.citations.length ? JSON.stringify(result.citations) : null,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cachedTokens: result.usage.cachedTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        // The cacheable prefix, fingerprinted: two replies that differ here could not have shared a cache.
        prefixHash: createHash('sha1').update(`${model}|${assembled.text}|${(tools ?? []).map((t) => (t as { function?: { name?: string } }).function?.name ?? '').join(',')}`).digest('hex').slice(0, 16),
        reasoningTokens: result.usage.reasoningTokens,
        cost: result.usage.cost,
        ...(fellBack ? { model: result.servedBy as string } : {})
      })
      partial = null

      if (toolCalls.length === 0) break

      // Run every call the model asked for, in order, and record each result as
      // its own message so the thread can be replayed later unchanged.
      let last = placeholder.id
      for (const call of toolCalls) {
        /*
          Arguments that do not parse used to become {} and the tool ran with
          nothing, so the model read "edit_file: that text is not in
          undefined" and never learned its JSON was the problem. Now the
          call is refused with the reason, and a call that parses is held
          to the tool's own schema before it runs.
        */
        let args: Record<string, unknown> = {}
        let refused: string | null = null
        try {
          const parsed: unknown = call.arguments ? JSON.parse(call.arguments) : {}
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
          else refused = `The arguments for ${call.name} must be a JSON object.`
        } catch (e) {
          refused = `The arguments for ${call.name} were not valid JSON (${(e as Error).message}). Send the call again with well-formed JSON.`
        }
        if (!refused) refused = validateArgs((tools as unknown[]).find((t) => (t as { function?: { name?: string } }).function?.name === call.name), args)

        const run: ToolRun = {
          callId: call.id,
          name: call.name,
          subject: subjectOf(call.name, args),
          args: call.arguments
        }
        emit({ type: 'tool_start', requestId, call: run })
        log.info('tool', `${call.name} start`, { subject: run.subject.slice(0, 80) })
        const toolSpan = otel.startSpan('execute_tool', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': call.name, 'gen_ai.tool.call.id': call.id, 'harbor.tool.subject': run.subject.slice(0, 80) }, otel.turnSpan(requestId))

        const toolAt = Date.now()
        let output: string
        let ok = true
        toolSpend = 0
        /*
          A tool that waits — on workers, on the oracle, on a slow
          command — sends nothing on its own for minutes, and the interface
          gives up on a turn that has been silent for four. So a long tool
          keeps a pulse: the same phase, with how long it has been, every
          twenty seconds, which the waiting line shows and the watchdog counts.
        */
        const pulse = setInterval(() => {
          emit({ type: 'phase', requestId, phase: 'tool', detail: stillRunning(toolLabel([run]), Date.now() - toolAt) })
          // A worker's stall detector reads this; a long tool is not a stall.
          db.touchConversation(conversationId)
        }, 20_000)
        try {
          if (refused) throw new Error(refused)
          output = await execute(ctx, call.name, args)
        } catch (e) {
          ok = false
          output = `Error: ${(e as Error).message}`
        } finally {
          clearInterval(pulse)
        }
        log[ok ? 'info' : 'warn']('tool', `${call.name} ${ok ? 'done' : 'failed'}`, {
          ms: log.since(toolAt),
          bytes: output.length
        })
        toolSpan.end({ 'harbor.tool.bytes': output.length, 'harbor.cost_usd': toolSpend || null }, ok ? undefined : output.slice(0, 500))
        // A result too large to carry is saved whole and shown by its head.
        if (ok) output = await spillIfLarge(requestId, call.id || run.callId, call.name, output)
        /*
          Instructions kept nearer the file than the root: a nested rules
          file, or a rules file that names this path. Appended to the first
          result that touches the folder in a turn, once per file of rules.
        */
        if (ok && root && FILE_PATH_TOOLS.has(call.name) && typeof args.path === 'string') {
          const fresh = (await rulesForPath(root, args.path).catch(() => [])).filter((r) => !rulesSeen.has(r.label))
          if (fresh.length) {
            for (const r of fresh) rulesSeen.add(r.label)
            output = `${output}\n\n${scopedBlock(fresh)}`
            log.info('rules', 'scoped rules applied', { path: args.path, from: fresh.map((r) => r.label) })
          }
        }

        emit({ type: 'tool_end', requestId, call: { ...run, result: output, ok } })
        last = db.addMessage(conversationId, last, 'tool', output, null, {
          toolCallId: call.id,
          cost: toolSpend > 0 ? toolSpend : null
        }).id
        steps++
      }

      parentId = last

      const stepLimit = role === 'director' || role === 'worker' ? UNATTENDED_STEP_CEILING : stepCeiling()
      if (stepLimit > 0 && steps >= stepLimit) {
        db.addMessage(
          conversationId,
          parentId,
          'assistant',
          role === 'worker' ? `STOPPED: ${steps} tool calls without finishing; the task may be too big for one worker.` : `Stopped after ${steps} tool calls. Say continue to carry on.`,
          model
        )
        break
      }

      if (or.isCancelled(requestId)) break
    }

    if (todos.length) emit({ type: 'todos', requestId, items: [] })
    emit({ type: 'done', requestId, ...emptyUsage() })

    /*
      Extraction runs after the turn has settled, so it never delays a reply,
      and it is best effort — a failure here must not disturb the conversation.
    */
    // A throwaway is not remembered from: that is the point of it.
    if (projectId && lastAssistantId && !db.getConversation(conversationId)?.scratch) {
      const settled = db.listMessages(conversationId)
      const tail = pathToLeaf(settled, lastAssistantId)
        .slice(-4)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))

      const extractionModel = db.getSetting('extraction_model') || model
      const added = await memory.extract({
        projectId,
        conversationId,
        messageId: lastAssistantId,
        exchange: tail,
        model: extractionModel
      })
      if (added > 0) emit({ type: 'remembered', requestId, count: added })
    }
  } catch (e) {
    const err = e as Error
    openStep?.end({}, err.message)
    openStep = null
    if (err instanceof or.Cancelled || err.name === 'AbortError') {
      log.info('turn', 'stopped', { id: requestId.slice(0, 8), kept: partial?.text.length ?? 0 })
      /*
        What had streamed is kept as the reply, cut where it was cut; an
        empty placeholder is stored as an error so the model is not shown a
        blank assistant turn of its own next time.
      */
      if (partial) {
        db.finalizeMessage(partial.id, {
          content: partial.text,
          error: partial.text.trim() ? null : 'Stopped before the model replied.'
        })
        partial = null
      }
      emit({ type: 'done', requestId, ...emptyUsage() })
    } else {
      log.error('turn', 'failed', { id: requestId.slice(0, 8), error: err.message })
      /*
        Main owns the rows. The renderer used to finalise on every error
        event, and on the errors that arrive after a step had already been
        finalised (the budget stop, say) that overwrote the step's tool calls
        and cost with nothing: orphaned tool rows, a 400 on the next turn,
        and a run spend that read low. Only a placeholder still open is
        touched, and only here.
      */
      if (partial) {
        db.finalizeMessage(partial.id, { content: partial.text, error: err.message })
        partial = null
      }
      emit({ type: 'error', requestId, message: err.message })
    }
  } finally {
    or.endRequest(requestId)
    await treeSnapshot('after')
  }
}

/** Whether any user message on this branch carries a PDF. */
function hasPdf(conversationId: string, parentId: string | null): boolean {
  return pathToLeaf(db.listMessages(conversationId), parentId).some((m) => {
    if (!m.attachments || m.trimmed) return false
    try {
      return (JSON.parse(m.attachments) as Attachment[]).some((a) => a.kind === 'pdf')
    } catch {
      return false
    }
  })
}

export const emptyUsage = (): {
  promptTokens: null
  completionTokens: null
  cachedTokens: null
  reasoningTokens: null
  cost: null
} => ({
  promptTokens: null,
  completionTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
  cost: null
})

/** OpenAI wire shape, which is what OpenRouter expects sent back. */
/** Five results a search, five searches a turn: enough to answer, bounded in what it can cost. */
/** The tools whose `path` names a file the scoped rules can apply to. */
const FILE_PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir'])

const WEB_SEARCH_TOOL = { type: 'openrouter:web_search', parameters: { max_results: 5, max_uses: 5 } }

const toWireCalls = (calls: { id: string; name: string; arguments: string }[]) =>
  calls.map((c) => ({
    id: c.id,
    type: 'function',
    function: { name: c.name, arguments: c.arguments }
  }))

