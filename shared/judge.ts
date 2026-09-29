/**
 * The judge: a middle way between asking for every command and asking for
 * none. Commands that only read run unasked. The rest are put to a cheap
 * model with what the person said, what the project's instructions say,
 * and the command — and nothing the agent itself produced, since a page
 * or a file the agent read is the one thing that must not be able to
 * argue for its own commands. A denial is not a refusal: it becomes the
 * usual card, with the judge's reason on it. After a run of denials the
 * judge stands aside and the person is asked directly.
 */

export type ApprovalMode = 'ask' | 'judge'
export const MODE_SETTING = 'approval_mode'

/** Denials in a row before the judge stops being asked for the rest of the turn. */
export const CONSECUTIVE_DENIALS = 3
/** Denials in a turn, in all, before the same. */
export const TOTAL_DENIALS = 20

/**
 * Commands that read and report and change nothing, by their first word.
 * A command is safe only when it is one plain command: any separator,
 * pipe, redirection or substitution makes it something else.
 */
const SAFE_FIRST_WORDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'file', 'stat', 'du', 'df', 'pwd', 'echo', 'printf', 'true', 'which', 'type', 'env', 'date', 'uname', 'whoami', 'id', 'tree', 'less', 'more', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'jq', 'yq', 'xargs', 'basename', 'dirname', 'realpath', 'readlink', 'md5', 'shasum', 'sha256sum', 'openssl', 'node', 'python3', 'python', 'ruby', 'go', 'cargo', 'rustc', 'tsc', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'git', 'gh', 'make', 'pytest', 'jest', 'vitest', 'eslint', 'prettier', 'ping'
])
/** For the tools above that can also change things, the sub-commands that do not. */
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['status', 'log', 'diff', 'show', 'branch', 'blame', 'grep', 'ls-files', 'rev-parse', 'describe', 'tag', 'remote', 'stash', 'shortlog', 'fetch']),
  gh: new Set(['pr', 'issue', 'repo', 'run', 'api', 'auth']),
  npm: new Set(['test', 'run', 'ls', 'view', 'outdated', 'audit', 'why', 'exec', 'pack', 'version', 'ping']),
  pnpm: new Set(['test', 'run', 'ls', 'why', 'outdated', 'exec']),
  yarn: new Set(['test', 'run', 'why', 'outdated', 'info']),
  bun: new Set(['test', 'run']),
  cargo: new Set(['test', 'check', 'build', 'clippy', 'fmt', 'doc', 'tree', 'metadata']),
  go: new Set(['test', 'build', 'vet', 'fmt', 'list', 'version', 'env', 'doc']),
  make: new Set(['test', 'check', 'lint', 'build']),
  node: new Set(['--version', '-v', '-e', '--eval', '-p', '--print']),
  python3: new Set(['--version', '-V', '-c', '-m']),
  python: new Set(['--version', '-V', '-c', '-m']),
  npx: new Set(['tsc', 'eslint', 'prettier', 'vitest', 'jest', 'playwright', 'tsx']),
  openssl: new Set(['version', 'dgst', 'x509']),
  sed: new Set(['-n']),
  ping: new Set(['-c'])
}
const CONTROL = /[;&|<>`\n]|\$\(/

/** Whether a command reads and reports and changes nothing, so the judge is not needed. */
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || CONTROL.test(trimmed)) return false
  const words = trimmed.split(/\s+/)
  const first = words[0].replace(/^.*\//, '')
  if (!SAFE_FIRST_WORDS.has(first)) return false
  const subs = SAFE_SUBCOMMANDS[first]
  if (!subs) return true
  // sed and ping are safe only in the form named; everything else needs one of its listed sub-commands.
  const second = words[1] ?? ''
  if (first === 'sed') return second === '-n' && !words.some((w) => w === '-i' || w.startsWith('-i'))
  if (first === 'ping') return second === '-c'
  if (first === 'git' && second === 'stash') return words[2] === 'list' || words[2] === 'show'
  if (first === 'git' && second === 'branch') return !words.some((w) => w === '-d' || w === '-D' || w === '-m' || w === '-M')
  if (first === 'git' && second === 'tag') return words.length === 2 || words[2] === '-l' || words[2] === '--list'
  if (first === 'git' && second === 'remote') return words.length === 2 || words[2] === '-v' || words[2] === 'show'
  if (first === 'gh' && ['pr', 'issue', 'repo', 'run'].includes(second)) return ['list', 'view', 'status', 'checks', 'diff'].includes(words[2] ?? '')
  if (first === 'gh' && second === 'api') return !words.some((w) => w === '-X' || w === '--method' || w === '-f' || w === '-F' || w === '--input')
  if (first === 'gh' && second === 'auth') return words[2] === 'status'
  if (first === 'npm' && second === 'run') return !!words[2] && !/publish|deploy|release/.test(words[2])
  if (first === 'npm' && second === 'version') return words.length === 2
  if (first === 'npm' && second === 'exec') return false
  return subs.has(second)
}

export interface JudgeInput {
  command: string
  cwd: string
  /** What the person said in this conversation, newest last. Nothing the agent wrote. */
  said: string[]
  /** The project's own standing instructions. */
  instructions: string
}

export const JUDGE_SYSTEM = `You decide whether a coding agent may run one shell command without asking the person. You see only what the person themselves wrote in the conversation, the project's standing instructions, and the command. You do not see the agent's reasoning or anything it read, and you must not assume it.

Allow a command when it plainly serves what the person asked for and changes nothing they would mind: building, testing, linting, formatting, installing declared dependencies, reading, searching, committing work on a branch the person asked for. The command runs inside a sandbox that keeps writes to the project folder and network to a few allowed hosts, so accidental damage is contained; your concern is intent.

Deny when the command goes beyond what was asked or against something the person said: pushing or publishing, force operations, deleting or rewriting history, touching credentials or configuration outside the project, sending data anywhere, anything the person told the agent not to do, or anything you cannot connect to a request they made. A denial is not a refusal: the person is then asked.

Answer with one line: ALLOW: <why, in a few words> or DENY: <why, in a few words>.`

/** The messages the judge is sent. Kept short: the point is the person's words, not the whole transcript. */
export function judgeMessages(input: JudgeInput): { role: string; content: string }[] {
  const said = input.said
    .slice(-6)
    .map((s) => s.trim().slice(0, 800))
    .filter(Boolean)
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n\n')
  const body = [
    input.instructions.trim() ? `Project instructions:\n${input.instructions.trim().slice(0, 2000)}` : '',
    `What the person has said in this conversation, oldest first:\n${said || '(nothing yet)'}`,
    `The command, to run in ${input.cwd}:\n${input.command}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: body }
  ]
}

export interface Verdict {
  allow: boolean
  reason: string
}

/** The judge's line, read strictly: anything that is not a clear ALLOW is a denial, and so becomes a card. */
export function parseVerdict(text: string): Verdict {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? ''
  const m = /^\s*\**\s*(ALLOW|DENY)\s*\**\s*:?\s*(.*)$/i.exec(line)
  if (!m) return { allow: false, reason: 'the judge gave no clear answer' }
  return { allow: m[1].toUpperCase() === 'ALLOW', reason: m[2].trim().replace(/\.$/, '') || (m[1].toUpperCase() === 'ALLOW' ? 'allowed' : 'denied') }
}
