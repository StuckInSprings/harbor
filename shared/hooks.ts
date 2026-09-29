/**
 * Hooks: commands that run after the agent writes a file.
 *
 * The typecheck after every edit, the formatter after every write, the tests
 * after a change to src — and whatever they print goes back to the model as
 * part of the tool result, so it fixes its own type errors before anyone
 * reads them. This is the single biggest quality jump a coding agent gets,
 * and it costs one project setting.
 *
 * A hook is a glob and a command. The command runs in the project root with
 * {path} replaced by the file that was written, relative to the root.
 */

export interface Hook {
  /** Which files trigger it. No slash means "match the file name anywhere". */
  glob: string
  command: string
  timeoutSec?: number
}

export const HOOK_TIMEOUT_SEC = 60

/** What of a hook's output the model sees. Enough for a compiler's complaint, not a log. */
export const HOOK_OUTPUT_CAP = 4000

export function parseHooks(raw: string | null | undefined): Hook[] {
  if (!raw) return []
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const out: Hook[] = []
  for (const h of list) {
    if (!h || typeof h !== 'object') continue
    const { glob, command, timeoutSec } = h as Record<string, unknown>
    if (typeof glob !== 'string' || typeof command !== 'string') continue
    if (!glob.trim() || !command.trim()) continue
    const hook: Hook = { glob: glob.trim(), command: command.trim() }
    if (typeof timeoutSec === 'number' && timeoutSec > 0) hook.timeoutSec = timeoutSec
    out.push(hook)
  }
  return out
}

/**
 * Glob to regular expression. Supports `**` across directories, `*` and `?`
 * within a name, and `{a,b}` alternatives. Anchored to the whole string.
 */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` swallows any number of directories, including none.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const close = glob.indexOf('}', i)
      if (close === -1) re += '\\{'
      else {
        const parts = glob
          .slice(i + 1, close)
          .split(',')
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
        re += `(?:${parts.join('|')})`
        i = close
      }
    } else if ('.+^$()|[]\\'.includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`)
}

/** Whether a hook applies to a path, relative to the project root. */
export function hookMatches(hook: Hook, relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const glob = hook.glob.replace(/^\.\//, '')
  const re = globToRegExp(glob)
  if (glob === '*' || glob === '**') return true
  if (!glob.includes('/')) {
    const base = path.slice(path.lastIndexOf('/') + 1)
    return re.test(base)
  }
  return re.test(path)
}

/** The command line with the file substituted in. Quoted, since paths have spaces. */
export function substitute(command: string, relativePath: string): string {
  const quoted = `'${relativePath.replace(/'/g, `'\\''`)}'`
  return command.includes('{path}') ? command.split('{path}').join(quoted) : command
}

/**
 * The line that goes back to the model. Named for the command, honest about
 * the exit code, and cut from the front so the end — where a compiler puts
 * its summary — survives.
 */
export function hookReport(
  hook: Hook,
  result: { output: string; exitCode: number | null; timedOut: boolean }
): string {
  const status = result.timedOut
    ? `timed out after ${hook.timeoutSec ?? HOOK_TIMEOUT_SEC}s`
    : result.exitCode === 0
      ? 'ok'
      : `failed with exit code ${result.exitCode ?? 'unknown'}`
  const out = result.output.trim()
  const body =
    out.length > HOOK_OUTPUT_CAP ? `[…${out.length - HOOK_OUTPUT_CAP} earlier characters cut]\n${out.slice(-HOOK_OUTPUT_CAP)}` : out
  return `[hook: ${hook.command}] ${status}${body ? `\n${body}` : ''}`
}
