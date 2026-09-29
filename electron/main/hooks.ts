import { randomUUID } from 'node:crypto'
import type { Hook, TerminalEvent } from '../../shared/types'
import { HOOK_TIMEOUT_SEC, hookMatches, hookReport, substitute } from '../../shared/hooks'
import * as commands from './commands'
import * as log from './log'

/**
 * Running the hooks that apply to a written file. See shared/hooks.ts.
 *
 * Hooks are the person's own commands, so they need no approval — but the
 * hard deny list still holds, since it is about what Harbor will never run,
 * whoever asks. Output streams to the terminal pane like any other command
 * and comes back as text for the tool result.
 */
export async function runHooks(opts: {
  root: string
  hooks: Hook[]
  /** Relative to the root. */
  path: string
  conversationId: string
  emitTerminal: (e: TerminalEvent) => void
}): Promise<string> {
  const applicable = opts.hooks.filter((h) => hookMatches(h, opts.path))
  if (applicable.length === 0) return ''

  const reports: string[] = []
  for (const hook of applicable) {
    const command = substitute(hook.command, opts.path)
    const denied = commands.hardDenyReason(command)
    if (denied) {
      reports.push(`[hook: ${hook.command}] refused: it ${denied}, and Harbor never runs that.`)
      continue
    }

    const handle = randomUUID()
    const started = Date.now()
    opts.emitTerminal({
      type: 'start',
      conversationId: opts.conversationId,
      handle,
      command,
      source: 'hook'
    })
    const result = await commands.run(
      handle,
      command,
      opts.root,
      (text, stream) =>
        opts.emitTerminal({ type: 'chunk', conversationId: opts.conversationId, handle, text, stream }),
      (hook.timeoutSec ?? HOOK_TIMEOUT_SEC) * 1000
    )
    opts.emitTerminal({
      type: 'end',
      conversationId: opts.conversationId,
      handle,
      exitCode: result.exitCode,
      timedOut: result.timedOut
    })
    log.info('hook', result.exitCode === 0 ? 'ok' : 'failed', {
      command: hook.command.slice(0, 80),
      path: opts.path,
      exit: result.exitCode,
      ms: log.since(started)
    })
    reports.push(hookReport(hook, result))
  }
  return reports.join('\n\n')
}
