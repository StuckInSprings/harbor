/**
 * What the app is doing while you wait.
 *
 * A blinking cursor says only that something is happening, which during a
 * forty-second wait is indistinguishable from a hang — and after the hangs
 * this app has actually had, that ambiguity is expensive. A turn moves through
 * distinct phases, most of which the app already knows about, so it can say
 * which one it is in and how long it has been there.
 *
 * The phrasing rule: name the thing being waited on. "Waiting on kimi-k2" is
 * worth reading; "Loading" is not.
 */

/*
  Kept here rather than in openrouter.ts because the countdown shown while
  waiting is drawn from the same numbers the watchdogs use. A reassurance that
  does not match the real deadline is worse than none.
*/
export const FIRST_BYTE_MS = 150_000
export const IDLE_MS = 120_000

export type Phase =
  /** Reading the conversation, skills, memory and attachments. */
  | 'assembling'
  /** The request is open but the provider has not answered yet. */
  | 'sending'
  /** Connected, and the model has not sent a token yet. */
  | 'waiting'
  /** Reasoning tokens are arriving. */
  | 'thinking'
  /** Reply tokens are arriving. */
  | 'writing'
  /** A tool is running. */
  | 'tool'
  /** Blocked on a person, not a machine. */
  | 'approval'

/** The three phases the renderer cannot infer from the events it already gets. */
export type ReportedPhase = 'assembling' | 'sending' | 'waiting' | 'tool'

export interface Activity {
  phase: Phase
  /** The model, the command, or whatever else the phase is about. */
  detail?: string
  /** When this phase started. */
  since: number
}

/** Present tense, because it is happening now. See VERB in ToolRow for the past. */
export const DOING: Record<string, string> = {
  read_file: 'Reading',
  list_dir: 'Listing',
  search: 'Searching for',
  write_file: 'Writing',
  edit_file: 'Editing',
  run_command: 'Running',
  load_skill: 'Loading skill',
  search_knowledge: 'Searching knowledge for',
  todo_write: 'Updating the checklist',
  dispatch: 'Waiting on workers',
  continue_task: 'Waiting on worker',
  ask_person: 'Asking you',
  delegate: 'Waiting on a worker for',
  find_tools: 'Looking for tools for',
  ask_oracle: 'Asking the oracle about',
  command_output: 'Reading output of',
  stop_command: 'Stopping'
}

/** How long a tool has been running, for the waiting line: "dispatch T1, T2 · 3m 20s". */
export function stillRunning(label: string, sinceMs: number): string {
  const s = Math.floor(sinceMs / 1000)
  const t = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
  return `${label} · ${t}`
}

/** The line shown while waiting. */
export function activityLabel(a: Activity): string {
  switch (a.phase) {
    case 'assembling':
      return 'Gathering context'
    case 'sending':
      return a.detail ? `Sending to ${a.detail}` : 'Sending the request'
    case 'waiting':
      return a.detail ? `Waiting on ${a.detail}` : 'Waiting on the model'
    case 'thinking':
      return 'Thinking'
    case 'writing':
      return 'Writing'
    case 'tool':
      return a.detail || 'Working'
    case 'approval':
      return 'Waiting for you'
  }
}

/** What a tool call looks like on that line. */
export function toolLabel(calls: { name: string; subject: string }[]): string {
  if (calls.length === 0) return 'Working'
  if (calls.length > 1) return `Running ${calls.length} tools`
  const c = calls[0]
  const verb = DOING[c.name] ?? c.name
  if (c.name === 'todo_write') return verb
  return c.subject ? `${verb} ${c.subject}` : verb
}

/**
 * A second line, once the wait is long enough to worry about.
 *
 * It says the deadline rather than "please wait", because the useful question
 * at forty seconds is not whether to be patient but whether anything is still
 * coming. Every number here is the one the watchdog will actually act on.
 */
export function activityNote(a: Activity, now: number): string | null {
  const ms = now - a.since
  if (a.phase === 'approval') return 'Nothing runs until you answer.'
  if (ms < 15_000) return null

  if (a.phase === 'waiting' || a.phase === 'sending') {
    const left = FIRST_BYTE_MS - ms
    if (left <= 0) return 'Past the deadline — giving up.'
    return `Still connected. Gives up in ${formatElapsed(left)} if nothing arrives.`
  }
  if (a.phase === 'thinking' || a.phase === 'writing') {
    const left = IDLE_MS - ms
    // Only alarming if the tokens have stopped, which the caller resets.
    return left > 0 ? `Still arriving.` : null
  }
  if (a.phase === 'tool' && ms > 30_000) return 'Still running.'
  if (a.phase === 'assembling' && ms > 15_000) {
    return 'Reading attachments and building the prompt.'
  }
  return null
}

/** "9s", "1m 04s" — a countdown you can read at a glance. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/**
 * The tail of a reasoning trace, for the one line of it that is shown live.
 *
 * The end is the part being written now, and a trace can be thousands of
 * words, so this reads backwards from the end and stops at a sentence boundary
 * rather than mid-word.
 */
export function thoughtTail(reasoning: string, max = 120): string {
  const text = reasoning.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const cut = text.slice(-max)
  const start = cut.search(/[A-Z(]/)
  const sentence = cut.indexOf('. ')
  if (sentence !== -1 && sentence < max - 20) return cut.slice(sentence + 2)
  return start > 0 && start < 40 ? cut.slice(start) : `…${cut}`
}
