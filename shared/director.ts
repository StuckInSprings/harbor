/**
 * A director run: a bigger objective handed to a planner that breaks it into
 * requirements, a design and tasks, and — once the person approves — hands
 * the tasks to workers in their own conversations and judges what comes back.
 *
 * The run's files live in _director/ inside the project. They are the
 * contract: requirements.md is what the person wants, written by an
 * interviewer before any planning; design.md and tasks.md are the director's
 * plan, read before approval; guidance.md is how the director writes a brief
 * for a worker, and it improves a line at a time, agreed with the person.
 *
 * This module holds the file conventions, the roles a conversation can play,
 * and the interviewer's prompt. The director's own prompt and tools come in
 * their own step.
 */

export type ConversationRole = 'chat' | 'interview' | 'director' | 'worker'
export const ROLES: ConversationRole[] = ['chat', 'interview', 'director', 'worker']
export const isRole = (v: unknown): v is ConversationRole => typeof v === 'string' && (ROLES as string[]).includes(v)

export const DIRECTOR_DIR = '_director'
/** How the director briefs a worker: the project's, shared by every run, improved a line at a time. */
export const GUIDANCE_FILE = `${DIRECTOR_DIR}/guidance.md`
/** Where each run keeps its own files, one folder per run. */
export const RUNS_DIR = `${DIRECTOR_DIR}/runs`

const stamp = (at: number): string => {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/*
  A run is a folder. Its interview is given one when it is created, the
  director started from that interview is given the same one, and every
  file of the run lives in it: the requirements the interview wrote, the
  design and board the director writes, the log written when it finishes.
  Two runs in one project never read each other's requirements or mark
  each other's board. Only the guidance is shared, since it is the
  project's accumulated way of briefing, not any one run's.
*/
export const runDirFor = (at: number, id: string): string => `${RUNS_DIR}/${stamp(at)}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`

export interface RunFiles {
  dir: string
  requirements: string
  design: string
  tasks: string
  handoff: string
  log: string
}
export const runFiles = (dir: string): RunFiles => ({
  dir,
  requirements: `${dir}/requirements.md`,
  design: `${dir}/design.md`,
  tasks: `${dir}/tasks.md`,
  handoff: `${dir}/handoff.md`,
  log: `${dir}/run-log.md`
})
/** A run from before runs had folders: its files sat at the top of _director/, and its log went to a dated archive. */
export const LEGACY_RUN: RunFiles = {
  dir: DIRECTOR_DIR,
  requirements: `${DIRECTOR_DIR}/requirements.md`,
  design: `${DIRECTOR_DIR}/design.md`,
  tasks: `${DIRECTOR_DIR}/tasks.md`,
  handoff: `${DIRECTOR_DIR}/handoff.md`,
  log: ''
}
/** A conversation's run files: its own folder's, or the old shared ones for a run that began before folders. */
export const filesOf = (runDir: string | null | undefined): RunFiles => (runDir ? runFiles(runDir) : LEGACY_RUN)

/** Where a legacy run's leftovers go when a new run starts, so the new one does not read them. */
export const archiveDirFor = (at: number): string => `${RUNS_DIR}/${stamp(at)}`
/** What a new run must not inherit from a run before folders: its requirements, design, board and handoff. */
export const ARCHIVED_ON_START = [LEGACY_RUN.requirements, LEGACY_RUN.design, LEGACY_RUN.tasks, LEGACY_RUN.handoff]

/*
  Who may write what, by role. The interviewer writes its own run's folder.
  A director before approval writes its design, its board, its handoff and
  the shared guidance, and nothing else; after approval, the project. A
  worker writes what its brief owns. And the requirements are frozen to
  everyone but the interviewer who wrote them, as are other runs' folders:
  the jail refuses, so it does not rest on a prompt being obeyed.
*/
export interface WriteScope {
  globs: string[]
  /** Behind the approval gate: the refusal says the gate is a button. */
  gated: boolean
  /** Why a path may not be written, or null when it may. */
  frozen: (path: string) => string | null
}
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.?\//, '')
export function writeScope(r: { role: ConversationRole; approved: boolean; runDir: string | null; workerGlobs: string[]; projectGlobs: string[] }): WriteScope {
  const f = filesOf(r.runDir)
  const own = (p: string): boolean => norm(p) === f.dir || norm(p).startsWith(`${f.dir}/`)
  const otherRun = (p: string): boolean => {
    const n = norm(p)
    return (n.startsWith(`${RUNS_DIR}/`) || n === RUNS_DIR) && !(r.runDir && own(n))
  }
  const requirementsFrozen = (p: string): string | null =>
    norm(p) === f.requirements || norm(p) === LEGACY_RUN.requirements
      ? `${norm(p)} is the requirements, the person's words written by the interview. It is read here, never written; if it is wrong or hollow, say so and stop, and the person changes it.`
      : null
  const others = (p: string): string | null => (otherRun(p) ? `${norm(p)} belongs to another run. Each run keeps to its own folder, ${f.dir}/.` : null)
  if (r.role === 'interview') {
    return { globs: [r.runDir ? `${f.dir}/**` : `${DIRECTOR_DIR}/**`], gated: false, frozen: (p) => (r.runDir ? others(p) : null) }
  }
  if (r.role === 'director') {
    const frozen = (p: string): string | null => requirementsFrozen(p) ?? others(p)
    if (!r.approved) return { globs: [f.design, f.tasks, f.handoff, GUIDANCE_FILE], gated: true, frozen }
    return { globs: r.projectGlobs, gated: false, frozen }
  }
  if (r.role === 'worker') {
    // A worker's board is marked by Harbor, not by the worker; the run's files are not its to write.
    return { globs: r.workerGlobs.length ? r.workerGlobs : r.projectGlobs, gated: false, frozen: (p) => (norm(p).startsWith(`${DIRECTOR_DIR}/`) ? `${norm(p)} is the run's own record; a worker reports, and the director keeps the board.` : null) }
  }
  return { globs: r.projectGlobs, gated: false, frozen: () => null }
}

/** The interviewer's write allowance for a run that began before folders; see writeScope for everything newer. */
export const INTERVIEW_WRITE_GLOBS = [`${DIRECTOR_DIR}/**`]

/** What a conversation with a role is called in the header. */
export const ROLE_LABEL: Record<Exclude<ConversationRole, 'chat'>, string> = {
  interview: 'Interview',
  director: 'Director',
  worker: 'Worker'
}

export const interviewPrompt = (f: RunFiles): string => `You are interviewing the person before a bigger piece of work is planned. Your one job is to get the requirements out of them and written down at ${f.requirements}. You do not plan, design, or build; a director does that from your file, later, after the person has read it.

## How to interview
- Start from what they said and ask what the outcome is: what will exist when this is done that does not exist now, and who it is for.
- Then, in whatever order the conversation goes: what "done" looks like, concretely enough that someone else could check it; what is out of scope; what already exists that this builds on or must not disturb; what they would be angry to see changed; what quality bar applies, and where it is written down if it is.
- One or two questions at a time, never a questionnaire. Push back on vagueness: "good", "better", "polished" are not requirements until they say how they would know.
- When you think you have it, say back the whole thing in a short paragraph and ask what is wrong with it. Expect something to be.
- Keep it short. Ten exchanges is a long interview.

## What you write
When the person agrees the summary, write ${f.requirements}:

# Requirements
## Outcome
One paragraph: what will exist, for whom.
## Done means
A numbered list. Each item is checkable by someone who was not in this conversation.
## Out of scope
What is not being done, so nobody does it.
## Existing material
What is already there and how it is to be treated: built on, left alone, replaced.
## Quality bar
Where the standard is written, or the standard itself when it is not written anywhere.
## Open questions
Anything the person could not answer yet. The director will ask the person again; it does not decide these.

Then stop, and tell the person the file is ready for the director. Do not start planning. If they change their mind after the file is written, change the file; it is theirs.

## Rules
- Write only under ${f.dir}/. Everything else in the project is there to read for context.
- Never invent a requirement to fill a gap; put the gap under open questions.
- Never assume the answer to a question you have not asked.`

/** The interviewer's first line, so the person knows what this conversation is. */
export const INTERVIEW_OPENING = 'What are we building, and what will exist when it is done that does not exist now?'

/* ------------------------------------------------------------ the director */

export const DIRECTOR_FILE_CAP = 40_000
export const DIRECTOR_OPENING = 'Read the requirements and plan the run.'
export const APPROVAL_MESSAGE = 'The plan is approved. Begin.'
/** Workers are stopped at this share of the budget; the rest is the director's, for the handoff. */
export const BUDGET_RESERVE = 0.1

export interface RunStatus {
  approved: boolean
  budget: number
  spent: number
  /** A rehearsal: one task, end to end, then stop; the full run comes after. */
  rehearsal?: boolean
  /** The run's own branch, when one was made; the commit it started from, when the folder is a repository. */
  branch?: string | null
  base?: string | null
  /** The run's files; a run from before folders when absent. */
  files?: RunFiles
}

/** Where the run stands, as the director reads it every turn. */
export function runStatusText(s: RunStatus): string {
  const f = s.files ?? LEGACY_RUN
  const left = Math.max(0, s.budget - s.spent)
  const lines = [
    ...(s.rehearsal
      ? [
          'This run is a REHEARSAL. Plan exactly one task: the smallest that sends a worker through a real file end to end. Dispatch it, judge it against its done-when, mark it, and write the handoff. Do not plan or run anything else; the person starts the full run afterwards from the same requirements.'
        ]
      : []),
    s.approved
      ? 'The plan is approved. Work is under way.'
      : `The plan is not approved yet. Until it is, write only ${f.design} and ${f.tasks}, then stop and ask the person to read them and approve. Approval is the "Approve plan" button in the header, not a word in the chat: if the person says the plan is approved and this line still says it is not, ask them to press the button — the gate opens on your next step, without a new message.`,
    s.budget > 0
      ? `Budget: $${s.budget.toFixed(2)}. Spent so far: $${s.spent.toFixed(4)}. Left: $${left.toFixed(2)}. The last ${Math.round(BUDGET_RESERVE * 100)}% is yours alone, for the handoff; workers stop before it.`
      : 'No budget was set, so there is no ceiling; say what a plan will cost before running it.',
    s.branch
      ? `This run has its own branch, ${s.branch}, made from commit ${s.base ?? '?'}. After you accept a task, commit its files with a message naming the task, so the branch reads as the run's history; the person merges or discards the branch when it ends.`
      : s.base
        ? `The run started from commit ${s.base}, on a branch shared with other work. Do not commit; the person reviews the run with git diff ${s.base}.`
        : 'The folder is not under version control. Nothing here can be undone by git; be careful what you overwrite.'
  ]
  return lines.join('\n')
}

export type TaskStatus = 'pending' | 'active' | 'done' | 'blocked'
export interface Task {
  id: string
  title: string
  status: TaskStatus
  /**
   * The lines indented under the task, as Markdown with the indent taken
   * off: a worker task's tier, owner and done-when, or the questions a
   * blocked item is waiting on the person to answer. Empty when there are none.
   */
  detail: string
}

/**
 * The task list as the board reads it: checklist lines in tasks.md.
 *   - [ ] T1 — title      pending
 *   - [~] T2 — title      in progress
 *   - [x] T3 — title      done
 *   - [!] T4 — title      blocked, waiting on the person
 * The id is whatever comes before the first dash or colon; the rest is the title.
 * A checklist line with no id (T1, task-2…) is a note, not a task, and is skipped.
 */
export function parseTasks(markdown: string): Task[] {
  const out: Task[] = []
  // The task the indented lines below belong to, its own indent, and what has gathered under it.
  let open: { task: Task; indent: number; lines: string[] } | null = null
  const close = (): void => {
    if (!open) return
    open.task.detail = undent(open.lines)
    open = null
  }
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[([ xX~!])\]\s+(.+?)\s*$/.exec(line)
    // An id, then a dash or colon, then the title. A checklist line without an id ("T1 and T2 ran in parallel") is a note, not a task.
    const split = m ? /^([A-Za-z]+[-_]?\d+)(?:\s*[—–:-]\s*(.*)|\s*)$/.exec(m[2]) : null
    const indent = line.length - line.trimStart().length
    if (m && split) {
      close()
      const mark = m[1].toLowerCase()
      const status: TaskStatus = mark === 'x' ? 'done' : mark === '~' ? 'active' : mark === '!' ? 'blocked' : 'pending'
      const task: Task = { id: split[1], title: split[2]?.trim() || split[1], status, detail: '' }
      out.push(task)
      open = { task, indent, lines: [] }
      continue
    }
    // Indented under a task (blank lines included) is the task's detail; anything else ends it.
    if (open && (!line.trim() || indent > open.indent)) open.lines.push(line)
    else close()
  }
  close()
  return out
}

/** Lines with their shared indent taken off and blank edges trimmed. */
function undent(lines: string[]): string {
  const body = [...lines]
  while (body.length && !body[0].trim()) body.shift()
  while (body.length && !body[body.length - 1].trim()) body.pop()
  const least = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
  return body.map((l) => (l.trim() ? l.slice(least) : '')).join('\n')
}

/**
 * The board with one task's mark changed: `- [ ] T3 — …` to `- [~] T3 — …`.
 * Only the mark moves; the line is otherwise left as the director wrote it.
 * Returns the text unchanged when the task is not on the board.
 */
export function markTask(markdown: string, taskId: string, mark: ' ' | '~' | 'x' | '!'): string {
  const id = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^(\\s*[-*]\\s*\\[)[ xX~!](\\]\\s+${id}(?:\\s*[—–:-]|\\s*$))`, 'm')
  return markdown.replace(re, `$1${mark}$2`)
}

export const DEFAULT_GUIDANCE = `# How to brief a worker

A worker is a fresh conversation with none of your context. It knows only what the brief says and what it can read in the project. Every failed task so far has been a bad brief, not a bad worker. Corrections to this file are agreed with the person, one line at a time, dated.

## Every brief has
- The outcome, in one sentence, and how the worker can check it itself before reporting.
- The requirement it serves, quoted from requirements.md, not paraphrased.
- The files it owns — the only ones it may change — and the files it must read first.
- What to return: a short report (what was done, what was not, what it is unsure of), the list of files changed, and any question only the person can answer.
- What to do when blocked: stop and report. Never guess at a requirement.

## Owning and checking
- Owns is a set of paths. Write a folder as src/parser/ or src/parser/** — either owns everything under it. A file is a file.
- State acceptance as a check the worker can run itself — the file exists, has these sections, this test passes, this command exits clean — not as an impression.
- Tell the worker to write with the tools, not the shell, and to keep out of paths the brief does not send it to.
- Before dispatching, list the owned path. If the deliverable is already there, verify it and mark the task done instead of dispatching.
- For a task that produces several files, name the exact files and ask for a listing of the folder in the report.

## Sizing
- One outcome per task. A task whose report would need the word "and" twice is two tasks.
- Give a worker the smallest set of files that lets it succeed. Reading is cheap; owning is not.
- Pick the tier by what failure costs, not by how long the task looks.
`

export const directorPrompt = (f: RunFiles): string => `You are the director of a run: a bigger piece of work handed to you as requirements, which you plan and then carry out through workers in their own conversations, judging what they return. You do not do the tasks yourself when a worker could; you keep the whole in view. The person reads your plan before anything is built and can leave you to work after that.

## The files
This run's folder is ${f.dir}/, and every file of the run is in it but the guidance. The folders beside it under ${RUNS_DIR}/ are other runs: not your requirements and not your board. Read one only when your requirements point you at it.
- ${f.requirements} — what the person wants. Written by an interviewer; you do not change it. If it is missing or hollow, say so and stop; the person runs the interview again.
- ${f.design} — your design: how the outcome will be made, what exists already and how it is used, what is risky, what the tiers will cost roughly. Write it for the person to read in five minutes.
- ${f.tasks} — the board. One task per line as a checklist item: \`- [ ] T1 — title\`, then indented under it: tier, owns (the paths the worker may change), needs (task ids it waits for), and done-when (what the report must show). Mark \`[~]\` when a task is under way, \`[x]\` when accepted, \`[!]\` when it waits on the person; a question for the person is its own \`[!]\` line with an id. Keep it current; the person watches this file.
- ${GUIDANCE_FILE} — how you brief a worker. Read it before every brief. When a worker fails on a bad brief, propose one line for it and add it only when the person agrees.

## Before approval
Read the requirements, then the project as far as you need to. Write the design and the board. Then stop and ask the person to read them and press Approve plan in the header. Do not start work, run commands, or spend on anything but reading. Change the plan when they ask. Your status says whether the plan is approved; the person's words do not, and the dispatch tool appears only once it is.

## After approval
Work the board in order of needs. For each task, write a brief by the guidance and call \`dispatch\` with it: the task's id and title, its tier, the paths it owns, and the brief in full. The call returns when the worker is done, with its report; read the report against the task's done-when, not against your hopes. A report has three shapes. It starts with STOPPED — budget, or too many steps: read the budget line in your status, and stop dispatching; the worker was cut off, and the brief was not the problem. It says nothing changed, or ends mid-sentence: list the owned path before deciding anything; the work may be there. It is complete and misses the done-when: call \`continue_task\` once with what is missing, and if that fails too the brief or the task is wrong, and you fix that. Accept by marking the task \`[x]\`. Pass several tasks to one \`dispatch\` to run them at once, only when their owned files do not overlap — the tool refuses when they do. One dispatch in flight at a time: if the person writes to you while workers are out, answer them and wait; never dispatch a task that is already out. Before dispatching any task, list its owned path; if the deliverable is already there, verify it and mark it done instead.

Questions only the person can answer go on the board as \`[!]\` with the question under them; carry on with everything else and say what is waiting. Nothing else stops for them.

## The budget
The run has a ceiling in dollars; the budget line in your status is the only spend figure — never add up dispatch costs yourself, they are not the whole. Say what a plan will cost before running it. When the money is nearly gone, stop dispatching and write the handoff: what is done, what is not, what you would do next and what it would cost. A run that ends with no handoff wasted what it spent.

## Rules
- Never change ${f.requirements}. Never write outside this project.
- A worker's report is evidence, not truth: when it matters, read the file it says it changed.
- Quote the requirement in every brief. A worker that has not seen the words will satisfy different ones.
- Keep the board current, and edit it in whole blocks — one edit per task accepted, not one per fact — so the file does not drift from what you remember of it.
- Write the handoff once, at the end, after the board matches the disk; until then the board is the record.
- If a worker cannot run, do not do the task yourself at a lesser standard; leave the brief ready and say so in the handoff.
- Judgement calls are the person's. What the work is for, what trade-off they would accept, which reading of the requirements is meant: never decide these to keep the run moving. Before approval, put each one to the person in chat and wait; after approval, stop and ask before dispatching a task that turns on one. A worker asks the person directly, through its own conversation, and the person's answer reaches it without you; a report that says "For the person" is a question you pass on by stopping and asking, not one you answer.`

/* -------------------------------------------------------------- workers */

/**
 * Owned paths as the director writes them, made into globs that match what
 * it meant: a folder — trailing slash, or no extension and no wildcard —
 * owns everything under it. A director that writes "src/parser/" means
 * everything inside it, and a glob on its own only matches itself.
 */
export function normaliseOwns(owns: string[]): string[] {
  const out: string[] = []
  for (const raw of owns) {
    let g = raw.replace(/\\/g, '/').replace(/^\.?\//, '').trim()
    if (!g) continue
    if (g.endsWith('/')) g = `${g}**`
    else if (!/[*?[]/.test(g) && !/\.[A-Za-z0-9]+$/.test(g.split('/').pop() ?? '')) {
      // A bare folder: the folder itself and everything under it.
      if (!out.includes(g)) out.push(g)
      g = `${g}/**`
    }
    if (!out.includes(g)) out.push(g)
  }
  return out
}

/** A worker that owns nothing gets an allowance no path can match: it reads, and reports. */
export const READ_ONLY_GLOB = '__read-only__/**'

/** How many workers a director may have running at once. */
export const WORKERS_AT_ONCE = 3

export interface Dispatch {
  taskId: string
  title: string
  tier: string
  brief: string
  /** The paths the worker may change, as globs relative to the project root; none means read-only. */
  owns: string[]
}

/**
 * Two tasks overlap when they own the same glob, or one owns a folder the
 * other's glob sits inside. That is the case the director must not run in
 * parallel; anything subtler is its own judgement.
 */
export function overlapping(tasks: { taskId: string; owns: string[] }[]): [string, string][] {
  const norm = (g: string): string => g.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/\*\*$/, '')
  const out: [string, string][] = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i].owns.map(norm)
      const b = tasks[j].owns.map(norm)
      const clash = a.some((x) => b.some((y) => x === y || x.startsWith(y + '/') || y.startsWith(x + '/')))
      if (clash) out.push([tasks[i].taskId, tasks[j].taskId])
    }
  }
  return out
}

/** The worker's title in the sidebar: the task id, then the title. */
export const workerTitle = (taskId: string, title: string): string => `${taskId} — ${title}`
export const taskIdOf = (workerTitle: string): string => workerTitle.split(' — ')[0].trim()

export const WORKER_PROMPT = `You are a worker on a run: one task, briefed by a director, in a conversation of your own. The brief below is the whole of what you were asked; the project is there to read. Nobody is watching this conversation as you work, and nobody will answer a question here — a question goes in your report, and the director takes it to the person.

## How to work
- Read the files the brief names before changing anything. Change only the files the brief says you own; a write anywhere else is refused. Write with write_file and edit_file, not through the shell: only tool writes are seen by the record the director reads.
- Do the task, check it yourself the way the brief says done is checked, and stop. Do not improve things you were not asked to improve.
- If the brief cannot be done as written — a file is missing, a requirement contradicts what exists, the check cannot pass — stop and say so. Never guess at what was meant.
- Some decisions are the person's, not yours, and not the director's: what the work is for, what trade-off they would accept, which of two readings of a brief is meant. Do not decide them. Call ask_person with what you have seen — the line in question, the two readings — and one clear question; the answer comes back as the result and you carry on with it. Ask several things in one call rather than one at a time. Do not ask what the brief or the files already answer.

## What you return
Your last message is your report, and it is all the director reads. Keep it short and in this shape:

Done: what now exists or changed, in a sentence or two.
Not done: anything the brief asked for that is not there, and why.
Files: the paths you changed, one per line.
Unsure: what you would want checked, if anything.
For the person: a question only they can answer, if there is one; otherwise "none".`

export interface WorkerReport {
  taskId: string
  title: string
  model: string
  cost: number
  report: string
  /** Files under the owned paths that changed while the worker ran, by any means — tool or shell. */
  files: string[]
  /** The worker's conversation, so the director can continue it. */
  conversationId: string
  /** Which dispatch of this task this was, counting from one. */
  attempt: number
  /** Why the worker stopped short, when it did not stop on its own. */
  stopped?: string | null
  /** What became of its worktree: merged into the run's branch, or left where it is and why. */
  merge?: string | null
}

/** The report as the director reads it back from a dispatch. */
export function formatReport(r: WorkerReport): string {
  return [
    `## ${workerTitle(r.taskId, r.title)} — dispatch ${r.attempt}, ${r.model}, $${r.cost.toFixed(4)}`,
    '',
    r.stopped ? `STOPPED: ${r.stopped}` : '',
    r.report.trim() || (r.stopped ? '(no report; the worker was cut off)' : '(the worker returned nothing)'),
    '',
    r.files.length ? `Files changed under the owned paths while it ran: ${r.files.join(', ')}` : 'Files changed under the owned paths while it ran: none.',
    r.merge ?? ''
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
}

/* -------------------------------------------------------------- the run log */

export interface RunLogWorker {
  taskId: string
  title: string
  attempt: number
  model: string
  home: string
  startedAt: number
  endedAt: number
  cost: number
  steps: number
  /** The worker's last words, or why it stopped. */
  report: string
  stopped: string | null
  errors: string[]
}

export interface RunLogData {
  project: string
  model: string
  budget: number
  startedAt: number
  finishedAt: number
  directorCost: number
  directorSteps: number
  workers: RunLogWorker[]
  /** The board as it stood at the end. */
  board: string
  /** The director's last message: the handoff, when it wrote one. */
  handoff: string
}

const stampMinute = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ')
const minutes = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`)

/**
 * What happened, for debugging afterwards: every worker in order with its
 * attempt, model, time, spend, how it ended and what it said; the errors;
 * the board; the handoff; the totals. Written once, when the run is
 * finished, so the worker conversations can be put away.
 */
export function renderRunLog(d: RunLogData): string {
  const workersCost = d.workers.reduce((n, w) => n + w.cost, 0)
  const failed = d.workers.filter((w) => w.stopped || w.errors.length)
  const lines: string[] = [
    `# Run log — ${d.project}`,
    '',
    `Started ${stampMinute(d.startedAt)}, finished ${stampMinute(d.finishedAt)} (${minutes(d.finishedAt - d.startedAt)}). Director on ${d.model}, budget $${d.budget.toFixed(2)}.`,
    '',
    '| | |',
    '| --- | --- |',
    `| Director | $${d.directorCost.toFixed(4)} over ${d.directorSteps} steps |`,
    `| Workers | $${workersCost.toFixed(4)} over ${d.workers.length} dispatches |`,
    `| Total | $${(d.directorCost + workersCost).toFixed(4)} |`,
    `| Cut off or errored | ${failed.length} |`,
    '',
    '## Dispatches, in order',
    '',
    '| task | attempt | model | home | took | cost | steps | ended |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...d.workers.map(
      (w) =>
        `| ${w.taskId} | ${w.attempt} | ${w.model} | ${w.home} | ${minutes(w.endedAt - w.startedAt)} | $${w.cost.toFixed(4)} | ${w.steps} | ${w.stopped ? `stopped: ${w.stopped}` : w.errors.length ? `error: ${w.errors[w.errors.length - 1]}` : 'reported'} |`
    ),
    ''
  ]
  if (failed.length) {
    lines.push('## What went wrong', '')
    for (const w of failed) {
      lines.push(`- ${w.taskId} attempt ${w.attempt}: ${w.stopped ?? w.errors.join('; ')}`)
    }
    lines.push('')
  }
  lines.push('## Board at the end', '', d.board.trim() || '(no board)', '')
  lines.push('## Handoff', '', d.handoff.trim() || '(the director wrote no handoff)', '')
  lines.push('## Reports, verbatim', '')
  for (const w of d.workers) {
    lines.push(`### ${w.taskId} — ${w.title} (attempt ${w.attempt}, ${stampMinute(w.startedAt)})`, '', w.report.trim() || '(nothing)', '')
  }
  return lines.join('\n')
}

/** Where a run's log goes: in its own folder, or, for a run before folders, in a dated archive. */
export const runLogFile = (startedAt: number, runDir?: string | null): string => (runDir ? runFiles(runDir).log : `${archiveDirFor(startedAt)}/run-log.md`)

/** A worker as the run view shows it. */
export interface RunWorker {
  id: string
  taskId: string
  title: string
  attempt: number
  model: string
  home: string
  cost: number
  steps: number
  createdAt: number
  updatedAt: number
  lastLine: string
  stopped: boolean
  archived: boolean
}
