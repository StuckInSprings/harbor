import * as db from './db'
import * as or from './openrouter'
import * as log from './log'
import { pathToLeaf } from './thread'
import { MODE_SETTING, judgeMessages, parseVerdict, type ApprovalMode, type Verdict } from '../../shared/judge'

export function mode(): ApprovalMode {
  return db.getSetting(MODE_SETTING) === 'judge' ? 'judge' : 'ask'
}

/**
 * Puts one command to the judge. What it is shown comes from the rows the
 * person wrote and the project's instructions; on any failure (no model,
 * a timeout, an unreadable answer) the verdict is a denial, which means
 * the person is asked, never that the command runs.
 */
export async function judge(opts: {
  conversationId: string
  command: string
  cwd: string
  instructions: string
  fallbackModel: string
  signal?: AbortSignal
}): Promise<Verdict> {
  const conv = db.getConversation(opts.conversationId)
  const said = pathToLeaf(db.listMessages(opts.conversationId), conv?.leafId ?? null)
    .filter((m) => m.role === 'user' && !m.summaryOf)
    .map((m) => m.content)
  const model = db.getSetting('extraction_model') || opts.fallbackModel
  const at = Date.now()
  try {
    const text = await or.complete(model, judgeMessages({ command: opts.command, cwd: opts.cwd, said, instructions: opts.instructions }), { maxTokens: 120, signal: opts.signal, timeoutMs: 30_000 })
    const verdict = parseVerdict(text)
    log.info('judge', verdict.allow ? 'allowed' : 'denied', { model, ms: log.since(at), reason: verdict.reason, command: opts.command.slice(0, 120) })
    return verdict
  } catch (e) {
    log.warn('judge', 'could not judge; asking the person', { error: (e as Error).message })
    return { allow: false, reason: `the judge could not be reached (${(e as Error).message})` }
  }
}
