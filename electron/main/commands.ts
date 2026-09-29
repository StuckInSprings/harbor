import { spawn, type ChildProcess } from 'node:child_process'
import * as db from './db'
import * as sandbox from './sandbox'

/**
 * Shell commands.
 *
 * An important difference from the file tools: the path jail does not apply
 * here. A shell command can name any absolute path, so there is no sandbox to
 * hide behind — approval is the boundary. That is why every command surfaces
 * for a decision unless you have explicitly allowlisted it, and why the deny
 * list below cannot be allowlisted at all.
 */

/**
 * Commands that are refused outright and can never be allowlisted.
 *
 * This is a tripwire, not a sandbox: it matches the shape of a command, and a
 * shell has more shapes than any list. Approval is the boundary (see above);
 * the list exists so the obvious catastrophes never even reach a card. It is
 * matched against a normalised form of the command (see `flatten`).
 */
const RM_FLAGS = 'rm\\s+(-[a-zA-Z-]+\\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\\s+(--\\s+)?'
const HARD_DENY: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|[\s;&|(])sudo(\s|$)/, reason: 'runs as another user' },
  { pattern: /(^|[\s;&|(])(su|doas)\s/, reason: 'runs as another user' },
  { pattern: new RegExp(`${RM_FLAGS}\\/\\*?(\\s|$)`), reason: 'deletes the filesystem root' },
  { pattern: new RegExp(`${RM_FLAGS}(~|\\$HOME|\\$\\{HOME\\})(\\/\\*?)?(\\s|$)`), reason: 'deletes your home directory' },
  { pattern: /(^|[\s;&|(])find\s+(\/|~|\$HOME)\s[^|;&]*-(delete|exec\s+rm)\b/, reason: 'deletes across the filesystem' },
  { pattern: /(^|[\s;&|(])(mkfs|fdisk|newfs)(\s|$)/, reason: 'reformats disks' },
  { pattern: /(^|[\s;&|(])diskutil\s+(erase|partition|reformat|zeroDisk|randomDisk|secureErase|apfs\s+(delete|erase)|resetFusion)/i, reason: 'reformats disks' },
  { pattern: /(^|[\s;&|(])dd\s[^|;&]*of=\/dev\//, reason: 'writes directly to a device' },
  { pattern: /(^|[\s;&|(])(shutdown|reboot|halt)(\s|$)/, reason: 'shuts the machine down' },
  { pattern: /(^|[\s;&|(])(csrutil|nvram|launchctl|systemsetup)(\s|$)/, reason: 'changes system configuration' },
  { pattern: /(curl|wget)[^|;&]*\|\s*(sudo\s+)?(exec\s+)?(ba|z|k|da)?sh(\s|$)/, reason: 'pipes a download straight into a shell' },
  { pattern: /(ba|z|k|da)?sh\s+(-\S+\s+)*<\(\s*(curl|wget)\b/, reason: 'pipes a download straight into a shell' },
  { pattern: /\|\s*(sudo\s+)?(exec\s+)?(ba|z|k|da)?sh(\s|$)/, reason: 'pipes into a shell' },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, reason: 'is a fork bomb' },
  { pattern: /chmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, reason: 'opens the filesystem root to everyone' },
  { pattern: />\s*\/etc\//, reason: 'writes into /etc' },
  { pattern: /(^|[\s;&|(])tee\s+(-\S+\s+)*\/etc\//, reason: 'writes into /etc' },
  { pattern: /(^|[\s;&|(])security\s+(-\S+\s+)*(dump|find)-(keychain|generic-password|internet-password)/, reason: 'reads the Keychain' }
]

/**
 * The command as the deny list sees it: one space between words, no
 * backslash escapes (`sud\o` is `sudo`), a word quoted whole unquoted
 * (`"sudo"` is `sudo`, but `"reboot the server"` keeps its quotes and stays
 * an argument), and no directory on a command word (`/usr/bin/sudo` at the
 * start or after `;`, `&&`, `|` or `(` is `sudo`).
 */
function flatten(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\(?=\S)/g, '')
    .replace(/(^|\s)(["'])([^\s"']+)\2(?=\s|$)/g, '$1$3')
    .replace(/(^|[;&|(]\s*)(?:\/[\w.+-]+)+\/([\w.+-]+)/g, '$1$2')
}

export function hardDenyReason(command: string): string | null {
  const flat = flatten(command)
  for (const { pattern, reason } of HARD_DENY) {
    if (pattern.test(flat)) return reason
  }
  return null
}

/**
 * Anything that would let a second command ride in behind the first: a
 * separator, a pipe, a redirection, a subshell or a substitution.
 */
const SHELL_CONTROL = /[;&|<>`\n]|\$\(/

/**
 * Allowlist entries are prefixes, word by word: "npm test" permits "npm test"
 * and "npm test -- --watch", but not "npm publish" and not "npm tests".
 *
 * A prefix only counts for a plain command. Once a command contains a
 * separator or a pipe, "git status" would otherwise admit
 * "git status; rm -rf ~", so such a command has to match an entry exactly,
 * which is what "always" stores when the person approves one.
 */
export function matchesAllowlist(entries: string[], command: string): boolean {
  const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean)
  const cmd = words(command)
  if (cmd.length === 0) return false
  const exact = cmd.join(' ')
  return entries.some((entry) => {
    const e = words(entry)
    if (e.length === 0) return false
    if (e.join(' ') === exact) return true
    if (SHELL_CONTROL.test(command) || SHELL_CONTROL.test(entry)) return false
    return e.length <= cmd.length && e.every((w, i) => w === cmd[i])
  })
}

export function isAllowlisted(projectId: string, command: string): boolean {
  return matchesAllowlist(db.listAllowedCommands(projectId), command)
}

/* -------------------------------------------------------------- approval */

/**
 * 'timeout' is not a decision anyone made, and is reported as such; nor is
 * 'cancelled', which means the turn was stopped while the card was up.
 */
export type Decision = 'once' | 'always' | 'deny' | 'timeout' | 'cancelled'

interface Pending {
  resolve: (d: Decision) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

/**
 * Resolves when the person decides. If nobody answers within ten minutes it
 * gives up — reported as unanswered rather than as a refusal, since telling the
 * model it was declined would be inventing an intent nobody had.
 */
export function askApproval(approvalId: string, signal?: AbortSignal): Promise<Decision> {
  if (signal?.aborted) return Promise.resolve('cancelled')
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        pending.delete(approvalId)
        resolve('timeout')
      },
      10 * 60 * 1000
    )
    pending.set(approvalId, { resolve, timer })
    // A Stop while the card is up ends the wait, or the loop would sit
    // behind a card nobody is going to answer.
    signal?.addEventListener(
      'abort',
      () => {
        if (!pending.has(approvalId)) return
        clearTimeout(timer)
        pending.delete(approvalId)
        resolve('cancelled')
      },
      { once: true }
    )
  })
}

export function decide(approvalId: string, decision: Decision): boolean {
  const entry = pending.get(approvalId)
  if (!entry) return false
  clearTimeout(entry.timer)
  pending.delete(approvalId)
  entry.resolve(decision)
  return true
}

export function pendingCount(): number {
  return pending.size
}

/* ------------------------------------------------------------- execution */

const MAX_OUTPUT = 100 * 1024
const DEFAULT_TIMEOUT_MS = 120_000

const running = new Map<string, ChildProcess>()

export interface CommandResult {
  output: string
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
  /** Ran inside the operating system's sandbox. */
  sandboxed: boolean
}

/** Run inside the sandbox, fenced to this folder; absent, the command runs as the person would. */
export interface SandboxOpts {
  root: string
  id: string
  signal?: AbortSignal
}

export function killRunning(handle: string): void {
  running.get(handle)?.kill('SIGTERM')
  stop(handle)
}

export async function run(
  handle: string,
  command: string,
  cwd: string,
  onChunk: (chunk: string, stream: 'stdout' | 'stderr') => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  box?: SandboxOpts
): Promise<CommandResult> {
  const wrapped = box ? await sandbox.wrap(command, box.root, { id: box.id, signal: box.signal }) : null
  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1' }
  return new Promise((resolve) => {
    // A login shell so the command sees the same PATH the person would; in the sandbox, the runtime's own wrapper runs that shell.
    const child = wrapped
      ? spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd, env: { ...env, ...wrapped.env } })
      : spawn('/bin/zsh', ['-lc', command], { cwd, env })
    running.set(handle, child)

    let output = ''
    let truncated = false
    let timedOut = false

    const take = (buf: Buffer, stream: 'stdout' | 'stderr'): void => {
      const text = buf.toString('utf8')
      onChunk(text, stream)
      if (output.length < MAX_OUTPUT) {
        output += text
        if (output.length >= MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT)
          truncated = true
        }
      } else truncated = true
    }

    child.stdout?.on('data', (b: Buffer) => take(b, 'stdout'))
    child.stderr?.on('data', (b: Buffer) => take(b, 'stderr'))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer)
      running.delete(handle)
      if (wrapped) {
        // What the sandbox refused, in words, after the output; the model reads both.
        output = sandbox.explain(command, output)
        sandbox.after()
      }
      resolve({ output, exitCode, timedOut, truncated, sandboxed: !!wrapped })
    }

    child.on('close', (code) => finish(code))
    child.on('error', (err) => {
      onChunk(`${err.message}\n`, 'stderr')
      output += err.message
      finish(null)
    })
  })
}

/* ---------------------------------------------------------- background jobs */

/*
  A command that keeps running — a dev server, a watcher, a long build —
  used to hold the turn until its timeout killed it, or to be polled by
  the model running it again and again. Started in the background it runs
  on, its output kept, and the model reads what it printed since it last
  looked, or waits for a line to appear. It outlives the turn; the person
  can stop it from the terminal pane, the model with stop_command, and
  quitting stops them all.
*/

export interface Job {
  handle: string
  conversationId: string
  command: string
  child: ChildProcess
  output: string
  done: boolean
  exitCode: number | null
  startedAt: number
  sandboxed: boolean
}

const jobs = new Map<string, Job>()
/** The output kept per job; older output is dropped from the front. */
const JOB_OUTPUT_CAP = 1_000_000

export async function start(
  handle: string,
  conversationId: string,
  command: string,
  cwd: string,
  onChunk: (chunk: string, stream: 'stdout' | 'stderr') => void,
  onEnd: (exitCode: number | null) => void,
  box?: SandboxOpts
): Promise<Job> {
  const wrapped = box ? await sandbox.wrap(command, box.root, { id: box.id, signal: box.signal }) : null
  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1' }
  const child = wrapped
    ? spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd, env: { ...env, ...wrapped.env } })
    : spawn('/bin/zsh', ['-lc', command], { cwd, env })
  const job: Job = { handle, conversationId, command, child, output: '', done: false, exitCode: null, startedAt: Date.now(), sandboxed: !!wrapped }
  jobs.set(handle, job)
  const take = (buf: Buffer, stream: 'stdout' | 'stderr'): void => {
    const text = buf.toString('utf8')
    onChunk(text, stream)
    job.output += text
    if (job.output.length > JOB_OUTPUT_CAP) job.output = job.output.slice(-JOB_OUTPUT_CAP)
  }
  child.stdout?.on('data', (b: Buffer) => take(b, 'stdout'))
  child.stderr?.on('data', (b: Buffer) => take(b, 'stderr'))
  const finish = (code: number | null): void => {
    if (job.done) return
    job.done = true
    job.exitCode = code
    if (wrapped) sandbox.after()
    onEnd(code)
  }
  child.on('close', (code) => finish(code))
  child.on('error', (err) => {
    job.output += `${err.message}\n`
    onChunk(`${err.message}\n`, 'stderr')
    finish(null)
  })
  return job
}

export const job = (handle: string): Job | undefined => jobs.get(handle)
export const listJobs = (conversationId?: string): Job[] => [...jobs.values()].filter((j) => !conversationId || j.conversationId === conversationId)

/** What a job has printed since an offset; the offset to read from next time. */
export function read(handle: string, since = 0): { text: string; offset: number; done: boolean; exitCode: number | null } | null {
  const j = jobs.get(handle)
  if (!j) return null
  const from = Math.min(Math.max(since, 0), j.output.length)
  return { text: j.output.slice(from), offset: j.output.length, done: j.done, exitCode: j.exitCode }
}

/**
 * Waits until the job prints something matching the pattern (from the
 * offset on), or ends, or the time is up; then returns what it printed
 * since the offset. Polled, not streamed: a quarter second is fine for
 * a line a person would wait for anyway.
 */
export async function waitFor(handle: string, opts: { since: number; pattern: RegExp | null; timeoutMs: number }): Promise<{ text: string; offset: number; done: boolean; exitCode: number | null; matched: boolean } | null> {
  const until = Date.now() + opts.timeoutMs
  for (;;) {
    const r = read(handle, opts.since)
    if (!r) return null
    const matched = !!opts.pattern && opts.pattern.test(r.text)
    if (matched || r.done || Date.now() >= until) return { ...r, matched }
    await new Promise((res) => setTimeout(res, 250))
  }
}

/** Asked to stop, then made to, a few seconds later, if it did not. */
export function stop(handle: string): boolean {
  const j = jobs.get(handle)
  if (!j || j.done) return false
  j.child.kill('SIGTERM')
  setTimeout(() => {
    if (!j.done) j.child.kill('SIGKILL')
  }, 3_000)
  return true
}

export function stopAll(): void {
  for (const j of jobs.values()) if (!j.done) j.child.kill('SIGKILL')
}

/** Jobs long over are forgotten, so the map does not hold every command ever started. */
export function forgetFinished(olderThanMs: number): void {
  const cutoff = Date.now() - olderThanMs
  for (const [h, j] of jobs) if (j.done && j.startedAt < cutoff) jobs.delete(h)
}
