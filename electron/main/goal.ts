import { randomUUID } from 'node:crypto'
import type { RunOptions } from '../../shared/types'
import * as db from './db'
import * as or from './openrouter'
import * as log from './log'
import { pathToLeaf } from './thread'
import { runTurn } from './run'
import type { Emit, EmitTerminal } from './turn'
import { subjectOf } from './tools'
import { CONTINUE_PREFIX, MAX_TURNS, continueMessage, decide, evalMessages, parseEval } from '../../shared/goal'

/** The options the last turn in each conversation was started with; the loop continues with the same. */
const lastRun = new Map<string, RunOptions>()
export const remember = (opts: RunOptions): void => {
  lastRun.set(opts.conversationId, opts)
}

export const active = (conversationId: string): boolean => {
  const c = db.getConversation(conversationId)
  return !!c?.goal && c.goalState === 'pursuing'
}

/**
 * After a turn ends in a conversation with a goal: judge, then continue or
 * stop. Returns true when another turn was started, so the caller can hold
 * its "reply ready" notification for the turn that really ends it.
 */
export async function afterTurn(conversationId: string, requestId: string, failed: boolean, emit: Emit, emitTerminal: EmitTerminal): Promise<boolean> {
  const conv = db.getConversation(conversationId)
  if (!conv?.goal || conv.goalState !== 'pursuing') return false
  const cancelled = or.isCancelled(requestId)
  const path = pathToLeaf(db.listMessages(conv.id), conv.leafId)
  const lastUser = path.map((m) => m.role).lastIndexOf('user')
  const turnRows = path.slice(lastUser + 1)
  const tools: string[] = []
  for (const m of turnRows) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    try {
      for (const c of JSON.parse(m.toolCalls) as { function?: { name?: string; arguments?: string } }[]) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(c.function?.arguments || '{}')
        } catch {
          /* unparsed arguments have no subject */
        }
        tools.push(`${c.function?.name ?? '?'} ${subjectOf(c.function?.name ?? '', args)}`.trim())
      }
    } catch {
      /* a row whose calls do not parse called nothing readable */
    }
  }
  const reply = [...turnRows].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? ''
  const said = path.filter((m) => m.role === 'user' && !m.summaryOf && !m.content.startsWith(CONTINUE_PREFIX)).map((m) => m.content)
  const turns = conv.goalTurns + 1
  const spent = db.goalSpend(conv.id, conv.goalSince ?? 0)
  const opts = lastRun.get(conv.id)

  let verdict: { verdict: 'met' | 'not-yet' | 'impossible'; note: string } | null = null
  if (!cancelled && !failed) {
    const model = db.getSetting('extraction_model') || opts?.model || conv.model || ''
    try {
      const text = await or.complete(model, evalMessages({ goal: conv.goal, said, reply, tools }), { maxTokens: 200, timeoutMs: 60_000 })
      verdict = parseEval(text)
      log.info('goal', verdict.verdict, { turn: turns, note: verdict.note.slice(0, 120) })
    } catch (e) {
      log.warn('goal', 'could not judge; stopping', { error: (e as Error).message })
      verdict = { verdict: 'impossible', note: `the judge could not be reached (${(e as Error).message})` }
    }
  }
  const d = decide(verdict, { turns, maxTurns: MAX_TURNS, spent, budget: conv.goalBudget, toolCalls: turnRows.filter((m) => m.role === 'tool').length, idleBefore: conv.goalIdle, failed, cancelled })
  const canContinue = d.continue && !!opts
  const state = canContinue ? 'pursuing' : d.continue ? 'stopped' : d.state
  const note = canContinue ? d.note : d.continue ? 'there was no turn to continue from' : d.note
  db.setGoalState(conv.id, state, turns, d.idle)
  emit({ type: 'goal', requestId, conversationId: conv.id, state, note, turns })
  if (!canContinue) {
    log.info('goal', 'ended', { state, note: note.slice(0, 120), turns, spent })
    return false
  }
  const next = db.addMessage(conv.id, conv.leafId, 'user', continueMessage(conv.goal, d.note), null)
  const nextRequest = randomUUID()
  log.info('goal', 'continuing', { turn: turns + 1, missing: d.note.slice(0, 120), spent })
  void runTurn({ ...(opts as RunOptions), parentId: next.id, requestId: nextRequest }, emit, emitTerminal)
  return true
}
