/**
 * The bridge: Harbor as an MCP server, so Claude Code (or any MCP client)
 * can orchestrate and judge a director run. Harbor writes; the person says
 * what they want; Claude keeps the run moving and judges the work.
 *
 * The person fills in the interview, since what they want is theirs to
 * say, and answers the workers who stop to ask; Claude waits while they
 * do. Only if the person turns it on in Settings may Claude answer for
 * them. Claude starts the interview with the person's brief, starts the
 * director from the requirements the interview wrote, approves the plan,
 * nudges the run along ('continue', 'retry T3'), and reads everything.
 * What it thinks of the work goes to the person as a review in the run
 * view, a verdict and suggestions they can send on to the director or
 * dismiss; not to the director directly.
 *
 * Nothing here writes the work: there is no file-writing tool, what Claude
 * sends an agent is framed as its note and kept short, and a nudge to a
 * director is shorter still. Ordinary chats are not reachable.
 *
 * This file is the part with no Electron in it: what the tools are, how a
 * request is let in, the money rule, the notes and the reviews.
 * electron/main/bridge.ts serves it.
 */

export const ENABLED_SETTING = 'bridge_enabled'
export const PORT_SETTING = 'bridge_port'
export const CAP_SETTING = 'bridge_budget_cap'
export const TOKEN_SETTING = 'bridge_token_encrypted'
/** '1' when the person lets Claude answer the interview and workers' questions for them. Off by default. */
export const ANSWERS_SETTING = 'bridge_answers'
export const DEFAULT_PORT = 47632
export const DEFAULT_CAP = 5
export const SERVER_NAME = 'harbor'
/** A wait answers after this long at most; the client asks again if the run is still going. */
export const WAIT_MAX_S = 300
export const WAIT_DEFAULT_S = 120
/** A transcript read gives this many messages from the end unless asked for more. */
export const TRANSCRIPT_DEFAULT = 20
export const TRANSCRIPT_MAX = 200
/** One message's text past this is cut in a transcript; the full file is on disk. */
export const MESSAGE_CUT = 8_000

export const parsePort = (v: string | null | undefined): number => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_PORT
}
export const parseCap = (v: string | null | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP
}

/*
  A run started through the bridge always has a ceiling. Zero means no
  ceiling to the rest of Harbor, so zero is refused here rather than read
  as unlimited; and nothing over the cap the person set in Settings.
*/
export function checkBudget(budget: unknown, cap: number): number {
  const n = typeof budget === 'number' ? budget : Number(budget)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`A run needs a budget in dollars, more than 0 and at most $${cap.toFixed(2)}.`)
  if (n > cap) throw new Error(`$${n.toFixed(2)} is over the $${cap.toFixed(2)} a run started from Claude may spend. The cap is in Harbor's Settings, under Integrations.`)
  return Math.round(n * 100) / 100
}

/*
  Who may talk to it. The server listens on the loopback address only, and
  a page in a browser could still reach that; the Host header names what
  the caller thought it was talking to, so a rebinding attack's name fails,
  and a browser always sends Origin, which a CLI does not.
*/
export function allowedHost(host: string | undefined, port: number): boolean {
  return !!host && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
}
export function allowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === ''
}
export function bearerOf(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  return m ? m[1] : null
}

/** What Settings shows: whether it is on and listening, where, the cap, and the command to register it. */
export interface BridgeStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string
  error: string | null
  cap: number
  /** Claude may answer the interview and workers' questions for the person. */
  answers: boolean
  command: string
}

export const urlFor = (port: number): string => `http://127.0.0.1:${port}/mcp`
/** The line the person pastes to register Harbor with Claude Code, for every project on the machine. */
export const claudeAddCommand = (port: number, token: string): string =>
  `claude mcp add --scope user --transport http ${SERVER_NAME} ${urlFor(port)} --header "Authorization: Bearer ${token}"`

/** A thing named by id, an id's first characters, or (for a project) its name. One match or an error that says why. */
export function resolveOne<T extends { id: string; name?: string }>(items: T[], query: unknown, what: string): T {
  const q = String(query ?? '').trim()
  if (!q) throw new Error(`Say which ${what}.`)
  const exact = items.find((i) => i.id === q)
  if (exact) return exact
  const lower = q.toLowerCase()
  const named = items.filter((i) => i.name !== undefined && i.name.toLowerCase() === lower)
  if (named.length === 1) return named[0]
  const prefixed = q.length >= 6 ? items.filter((i) => i.id.startsWith(q)) : []
  if (prefixed.length === 1) return prefixed[0]
  if (named.length > 1 || prefixed.length > 1) throw new Error(`More than one ${what} matches "${q}"; use the full id.`)
  throw new Error(`No ${what} matches "${q}".`)
}

export interface TranscriptMessage {
  role: string
  content: string
  error: string | null
  toolCalls: string | null
  createdAt: number
}

/** The branch on screen as text a model can read: who said what, tool calls named, long text cut. */
export function transcriptText(path: TranscriptMessage[], last: number): string {
  const n = Math.max(1, Math.min(TRANSCRIPT_MAX, Math.floor(last) || TRANSCRIPT_DEFAULT))
  const shown = path.slice(-n)
  const lines: string[] = []
  if (path.length > shown.length) lines.push(`(${path.length - shown.length} earlier messages not shown)`)
  for (const m of shown) {
    const when = new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ')
    const calls = m.toolCalls ? toolNames(m.toolCalls) : []
    const text = m.content.length > MESSAGE_CUT ? `${m.content.slice(0, MESSAGE_CUT)}\n… (${m.content.length - MESSAGE_CUT} more characters)` : m.content
    const head = `## ${m.role} · ${when}${calls.length ? ` · called ${calls.join(', ')}` : ''}${m.error ? ' · FAILED' : ''}`
    lines.push(head, text.trim() || (m.error ? `Error: ${m.error}` : '(no text)'), '')
  }
  return lines.join('\n').trim()
}

function toolNames(json: string): string[] {
  try {
    const calls = JSON.parse(json) as { function?: { name?: string } }[]
    return calls.map((c) => c.function?.name ?? '?')
  } catch {
    return []
  }
}

/*
  What Claude sends an agent is marked as Claude's, so the agent (and the
  person reading the transcript) knows who said it and what it is for. A
  nudge to a director is a line or two: substance goes to the person as a
  review. An answer given for the person, when they allow it, may be
  longer, but never long enough to be the work itself.
*/
export const NUDGE_MAX = 600
export const ANSWER_MAX = 4_000
export const OVERSEER_FRAME =
  '[From Claude, orchestrating this run for the person. Claude keeps the run moving and judges it; it does not write the work. Act on what follows in your own words; never use it as text as written.]'
export function overseerNote(text: string, max: number, kind = 'note'): string {
  const t = text.trim()
  if (!t) throw new Error('The message is empty.')
  if (t.length > max) {
    throw new Error(
      max === NUDGE_MAX
        ? `That is ${t.length} characters; a nudge to a director is at most ${NUDGE_MAX}. What you think of the work goes to the person as post_review, and they decide what the director hears.`
        : `That is ${t.length} characters; ${kind === 'answer' ? 'an answer' : 'a note'} is at most ${max}. Say what the person decided, and let Harbor write the rest.`
    )
  }
  return `${OVERSEER_FRAME}\n\n${t}`
}

/* A review: Claude's judgement of a run, for the person watching it. */
export const VERDICTS = ['on track', 'needs work', 'off track'] as const
export type Verdict = (typeof VERDICTS)[number]
export type SuggestionState = 'open' | 'sent' | 'dismissed'
export interface Suggestion {
  text: string
  /** The task on the board it is about, when it is about one. */
  task: string | null
  state: SuggestionState
}
export interface Review {
  id: string
  conversationId: string
  verdict: Verdict
  summary: string
  suggestions: Suggestion[]
  createdAt: number
}
export const SUMMARY_MAX = 2_000
export const SUGGESTION_MAX = 1_000
export const SUGGESTIONS_MAX = 10

/** A review as the tool was given it, checked: a known verdict, a summary, a few short suggestions. */
export function parseReview(a: { verdict?: unknown; summary?: unknown; suggestions?: unknown }): { verdict: Verdict; summary: string; suggestions: Suggestion[] } {
  const verdict = String(a.verdict ?? '').trim().toLowerCase() as Verdict
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict is one of ${VERDICTS.join(', ')}.`)
  const summary = typeof a.summary === 'string' ? a.summary.trim() : ''
  if (!summary) throw new Error('A review needs a summary: how the run is going against its requirements.')
  if (summary.length > SUMMARY_MAX) throw new Error(`The summary is at most ${SUMMARY_MAX} characters.`)
  const raw = Array.isArray(a.suggestions) ? a.suggestions : []
  if (raw.length > SUGGESTIONS_MAX) throw new Error(`At most ${SUGGESTIONS_MAX} suggestions; keep the ones that matter most.`)
  const suggestions = raw.map((x, i): Suggestion => {
    const o = (typeof x === 'string' ? { text: x } : x ?? {}) as { text?: unknown; task?: unknown }
    const text = typeof o.text === 'string' ? o.text.trim() : ''
    if (!text) throw new Error(`Suggestion ${i + 1} is empty.`)
    if (text.length > SUGGESTION_MAX) throw new Error(`Suggestion ${i + 1} is ${text.length} characters; at most ${SUGGESTION_MAX}. Say what to change and why, not the changed text.`)
    const task = typeof o.task === 'string' && o.task.trim() ? o.task.trim() : null
    return { text, task, state: 'open' }
  })
  return { verdict, summary, suggestions }
}

/** The files of a run a client may read by name. */
export const RUN_FILE_NAMES = ['requirements', 'design', 'tasks', 'handoff', 'log', 'guidance'] as const
export type RunFileName = (typeof RUN_FILE_NAMES)[number]

interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  readOnly: boolean
}

const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
const CONV = str('The conversation id (or its first 8 or more characters), as list_runs gives it.')

export const TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    description: 'Harbor projects that can hold a director run: each has a folder. Archived projects are left out.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true
  },
  {
    name: 'list_runs',
    description: 'The interviews and director runs in a project, newest first: id, role, title, run folder, whether the plan is approved, budget and spend, and whether a turn is running.',
    inputSchema: { type: 'object', properties: { project: str('Project id or name.') }, required: ['project'] },
    readOnly: true
  },
  {
    name: 'start_interview',
    description: "Start an interview in a project with the person's brief. Harbor's interviewer asks questions and writes requirements.md in a new run folder. The person answers it in Harbor (Harbor tells them it is waiting), unless they have let you answer for them; run_status says which. Then wait: on an interview the person answers, wait returns when the requirements are written.",
    inputSchema: { type: 'object', properties: { project: str('Project id or name.'), message: str("The person's brief: what they asked for, relayed, not elaborated."), model: str("Model id; the project's default, or the last model used in Harbor, if left out.") }, required: ['project', 'message'] },
    readOnly: false
  },
  {
    name: 'start_director',
    description: "Start a director run on its own branch, from an interview that has written its requirements. The director reads them, writes design.md and tasks.md in the interview's run folder, then stops for approval. The budget is a hard ceiling on the whole run, workers included.",
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project id or name.'),
        from_interview: str('The interview whose requirements this run plans from.'),
        budget: { type: 'number', description: 'Dollars the whole run may spend. Required, and at most the cap set in Harbor.' },
        model: str("Model id for the director; the project's director tier if left out."),
        rehearsal: { type: 'boolean', description: 'Plan and run one task only, then stop. For trying a setup cheaply.' }
      },
      required: ['project', 'from_interview', 'budget']
    },
    readOnly: false
  },
  {
    name: 'send_message',
    description: `To a director: a nudge that keeps the run moving ('continue', 'retry T3, it stopped on a failed command'), at most ${NUDGE_MAX} characters. What you think of the work is not a nudge; it goes to the person with post_review. To an interview: the person's answers, only when they have let you answer for them, at most ${ANSWER_MAX} characters. Either way it is marked as yours. Refused while a turn is already running there; use wait first.`,
    inputSchema: { type: 'object', properties: { conversation: CONV, text: str('The nudge, or the answer.') }, required: ['conversation', 'text'] },
    readOnly: false
  },
  {
    name: 'approve_plan',
    description: "Approve a director's design and task board on the person's behalf, and tell it to begin dispatching workers. Read requirements, design and tasks with read_run_file first, and approve only a plan that meets the requirements; otherwise post_review saying what is missing, for the person to take up.",
    inputSchema: { type: 'object', properties: { director: CONV }, required: ['director'] },
    readOnly: false
  },
  {
    name: 'answer_question',
    description: `Answer a worker that stopped to ask a question, only when the person has let you answer for them; otherwise the person answers it in Harbor. Give the person's decision where the requirements or the brief make it; where they do not, say it is the worker's call. At most ${ANSWER_MAX} characters.`,
    inputSchema: { type: 'object', properties: { worker: str('The worker conversation id.'), answer: str('A decision or a pointer to the requirement, not content.') }, required: ['worker', 'answer'] },
    readOnly: false
  },
  {
    name: 'post_review',
    description: `Judge a director run for the person watching it: a verdict (${VERDICTS.join(', ')}), a summary of how the plan or the work stands against the requirements, and up to ${SUGGESTIONS_MAX} suggestions, each about one thing, naming the task where it applies. It appears in Harbor's run view, where the person sends a suggestion on to the director or dismisses it. Say what to change and why; never write the changed text.`,
    inputSchema: {
      type: 'object',
      properties: {
        director: CONV,
        verdict: { type: 'string', enum: [...VERDICTS] },
        summary: str(`How the run stands against its requirements, at most ${SUMMARY_MAX} characters.`),
        suggestions: {
          type: 'array',
          items: { type: 'object', properties: { text: str(`What to change and why, at most ${SUGGESTION_MAX} characters.`), task: str('The task id on the board, such as T2, when it is about one.') }, required: ['text'] }
        }
      },
      required: ['director', 'verdict', 'summary']
    },
    readOnly: false
  },
  {
    name: 'run_status',
    description: 'Where a run stands: approval, budget and spend, branch, run folder, the task board, each worker with its last line, questions waiting and who answers them, your reviews and what the person did with them, and the latest reply.',
    inputSchema: { type: 'object', properties: { conversation: CONV }, required: ['conversation'] },
    readOnly: true
  },
  {
    name: 'wait',
    description: 'Block until the run needs you, or the time runs out. On an interview the person answers: until the requirements are written. Otherwise: until the conversation and its workers have no turn running, or (when you answer for the person) a worker asks a question. Returns the status. Call again when it says the run is still going.',
    inputSchema: { type: 'object', properties: { conversation: CONV, seconds: { type: 'number', description: `At most ${WAIT_MAX_S}; ${WAIT_DEFAULT_S} if left out.` } }, required: ['conversation'] },
    readOnly: true
  },
  {
    name: 'run_changes',
    description: 'What a director run has changed in the project folder: every file added, modified or deleted since the commit the run started from, committed or not. Read the ones worth judging with read_file.',
    inputSchema: { type: 'object', properties: { director: CONV }, required: ['director'] },
    readOnly: true
  },
  {
    name: 'read_file',
    description: "Read a file in a run's project folder, to judge the work: a design note, a chapter, the code. Read-only, and only inside the folder.",
    inputSchema: {
      type: 'object',
      properties: {
        conversation: CONV,
        path: str('Path relative to the project folder.'),
        offset: { type: 'number', description: 'First line, from 0.' },
        limit: { type: 'number', description: 'How many lines; all if left out.' }
      },
      required: ['conversation', 'path']
    },
    readOnly: true
  },
  {
    name: 'read_conversation',
    description: 'The messages of an interview, director or worker, oldest first, from the end.',
    inputSchema: { type: 'object', properties: { conversation: CONV, last: { type: 'number', description: `How many messages from the end; ${TRANSCRIPT_DEFAULT} if left out, at most ${TRANSCRIPT_MAX}.` } }, required: ['conversation'] },
    readOnly: true
  },
  {
    name: 'read_run_file',
    description: "One of a run's files: requirements, design, tasks, handoff, log (written by finish_run), or guidance (shared by every run in the project).",
    inputSchema: { type: 'object', properties: { conversation: CONV, file: { type: 'string', enum: [...RUN_FILE_NAMES] } }, required: ['conversation', 'file'] },
    readOnly: true
  },
  {
    name: 'stop',
    description: "Stop the turn running in a conversation, and in a director's workers. The run can go on later with send_message.",
    inputSchema: { type: 'object', properties: { conversation: CONV }, required: ['conversation'] },
    readOnly: false
  },
  {
    name: 'finish_run',
    description: 'Finish a director run: write run-log.md in its folder with every report and failure, and archive the worker conversations. Do this after the handoff.',
    inputSchema: { type: 'object', properties: { director: CONV }, required: ['director'] },
    readOnly: false
  }
]

export const INSTRUCTIONS = [
  "You orchestrate and judge Harbor runs for the person; you are not their author. Harbor writes the requirements, the plan and the work, and the person says what they want.",
  'Never write the content yourself: not requirements, documents or code. There is no tool for it; do not work around that by editing the project folder with your own tools.',
  "A run begins with start_interview carrying the person's brief. The person answers the interview in Harbor; wait until the requirements are written. Only if run_status says you answer for the person do you relay their answers, and where they have not decided something, say it is open.",
  'Then start_director from that interview with a budget, and wait. Read requirements, design and tasks with read_run_file: approve_plan if the plan meets the requirements, or post_review with what is missing, and tell the person.',
  'While it works, keep it moving with short send_message nudges (continue, retry a stopped task). Workers who ask questions are answered by the person unless you answer for them.',
  'Judge the work with run_changes and read_file against the requirements, and give your judgement to the person with post_review: a verdict, a summary, and specific suggestions naming the task. The person decides what the director hears. Tell the person in your own reply what you posted.',
  'When the handoff is in, post a final review and finish_run. Every run has a hard budget you cannot raise; tell the person when it runs out.'
].join(' ')
