/**
 * A goal: a condition the conversation works toward on its own. After each
 * reply a separate, cheap model judges whether the condition is met from
 * the person's words, the goal and the last reply; when it is not, Harbor
 * sends "continue" itself. What stops it is written down here: met,
 * judged impossible, the money spent, the turns used up, two turns in a
 * row that used no tools (repeating itself), a failure, or the person.
 */

export type GoalState = 'pursuing' | 'met' | 'unmet' | 'stopped' | 'budget' | 'turns' | 'stalled' | 'failed'
export const MAX_TURNS = 20
export const DEFAULT_BUDGET = 2
/** Turns in a row without a tool call before the loop is called stalled. */
export const IDLE_TURNS = 2
/** How the message Harbor sends itself begins, so it is not read as the person's. */
export const CONTINUE_PREFIX = 'Continue toward the goal.'

export const GOAL_LABEL: Record<GoalState, string> = {
  pursuing: 'pursuing',
  met: 'met',
  unmet: 'judged out of reach',
  stopped: 'stopped',
  budget: 'stopped: budget spent',
  turns: 'stopped: turn limit',
  stalled: 'stopped: no progress',
  failed: 'stopped: a turn failed'
}

/** `/goal off`, or `/goal <condition> [$<dollars>]`. */
export function parseGoalCommand(args: string): { off: true } | { goal: string; budget: number } | { error: string } {
  const text = args.trim()
  if (!text || text === 'off' || text === 'stop' || text === 'clear') return { off: true }
  const m = /(?:^|\s)\$(\d+(?:\.\d+)?)\s*$/.exec(text)
  const goal = m ? text.slice(0, m.index).trim() : text
  const budget = m ? Number(m[1]) : DEFAULT_BUDGET
  if (!goal) return { error: 'Say what the goal is.' }
  if (!Number.isFinite(budget) || budget <= 0) return { error: 'The budget must be a number of dollars above zero.' }
  return { goal, budget }
}

export const EVAL_SYSTEM = `You judge whether a goal has been met, from the evidence given and nothing else. You are not the one doing the work; you do not know what the agent did beyond what is shown. Do not assume the goal is met because the reply says so: look for the evidence the goal asks for — tests that ran and passed, a file that exists, output that shows the result. A claim without evidence is NOT YET.

Answer with one line:
MET: <the evidence, in a few words>
NOT YET: <what is still missing, concretely, so the agent knows what to do next>
IMPOSSIBLE: <why it cannot be met as stated, so the person can restate it>`

export interface EvalInput {
  goal: string
  /** What the person said, newest last. Not the messages Harbor sent itself. */
  said: string[]
  /** The last reply's text. */
  reply: string
  /** The tools the last turn called, one line each. */
  tools: string[]
}

export function evalMessages(i: EvalInput): { role: string; content: string }[] {
  const said = i.said.slice(-4).map((s) => s.trim().slice(0, 600)).filter(Boolean).map((s, n) => `${n + 1}. ${s}`).join('\n\n')
  const body = [
    `The goal:\n${i.goal.trim()}`,
    said ? `What the person said:\n${said}` : '',
    `Tools the last turn called${i.tools.length ? ':' : ': none'}\n${i.tools.slice(-40).join('\n')}`.trimEnd(),
    `The last reply:\n${i.reply.trim().slice(0, 6000) || '(nothing)'}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return [
    { role: 'system', content: EVAL_SYSTEM },
    { role: 'user', content: body }
  ]
}

export type Verdict = 'met' | 'not-yet' | 'impossible'

/** Read strictly: what is not clearly MET or IMPOSSIBLE is NOT YET, and the loop carries on. */
export function parseEval(text: string): { verdict: Verdict; note: string } {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? ''
  const m = /^\s*\**\s*(MET|NOT YET|IMPOSSIBLE)\s*\**\s*:?\s*(.*)$/i.exec(line)
  if (!m) return { verdict: 'not-yet', note: text.trim().slice(0, 300) || 'the judge gave no clear answer' }
  const v = m[1].toUpperCase()
  return { verdict: v === 'MET' ? 'met' : v === 'IMPOSSIBLE' ? 'impossible' : 'not-yet', note: m[2].trim().replace(/\.$/, '') }
}

export interface Facts {
  turns: number
  maxTurns: number
  spent: number
  budget: number
  /** Tool calls in the last turn. */
  toolCalls: number
  /** Turns in a row, before this one, that called no tool. */
  idleBefore: number
  failed: boolean
  cancelled: boolean
}

/** What happens next. The person's stop and a failure come before the judge; the judge before the limits. */
export function decide(v: { verdict: Verdict; note: string } | null, f: Facts): { state: GoalState; note: string; continue: boolean; idle: number } {
  const idle = f.toolCalls === 0 ? f.idleBefore + 1 : 0
  if (f.cancelled) return { state: 'stopped', note: 'stopped by the person', continue: false, idle }
  if (f.failed) return { state: 'failed', note: 'the last turn failed', continue: false, idle }
  if (v?.verdict === 'met') return { state: 'met', note: v.note, continue: false, idle }
  if (v?.verdict === 'impossible') return { state: 'unmet', note: v.note, continue: false, idle }
  if (f.spent >= f.budget) return { state: 'budget', note: `$${f.spent.toFixed(2)} of $${f.budget.toFixed(2)} spent`, continue: false, idle }
  if (f.turns >= f.maxTurns) return { state: 'turns', note: `${f.turns} turns`, continue: false, idle }
  if (idle >= IDLE_TURNS) return { state: 'stalled', note: `${idle} turns in a row used no tools`, continue: false, idle }
  return { state: 'pursuing', note: v?.note ?? '', continue: true, idle }
}

/** The message Harbor sends itself to carry on. */
export const continueMessage = (goal: string, missing: string): string =>
  `${CONTINUE_PREFIX} The goal: ${goal.trim()}${missing ? `\n\nNot yet met: ${missing}` : ''}\n\nDo what is still needed, and show the evidence when it is done.`
