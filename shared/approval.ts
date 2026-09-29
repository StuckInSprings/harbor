/**
 * Two things about a command the agent wants to run and nobody has said
 * yes to yet: whether to ask at all, and how to tell the person when asking.
 *
 * Asking is the boundary for shell access, and a run waits on it for up to
 * ten minutes. A person who has walked away never sees the card; so a
 * desktop notification goes out when the window is not in front. And a
 * person who wants the agent to work on its own can turn asking off for a
 * project — but only inside a folder under version control, where a bad
 * command is a revert rather than a loss. The hard deny list still holds
 * either way; it is not an approval, it is a refusal.
 */

export const AUTO_APPROVE_NEEDS_REPO = true

/** Whether a project may run the command without asking. */
export function autoApproves(opts: { autoApprove: boolean; isRepo: boolean }): boolean {
  if (!opts.autoApprove) return false
  return !AUTO_APPROVE_NEEDS_REPO || opts.isRepo
}

/** Why a project with auto-approve on still asked, for the log and the person. */
export function autoApproveHeld(opts: { autoApprove: boolean; isRepo: boolean }): string | null {
  if (!opts.autoApprove) return null
  if (!opts.isRepo) return 'auto-approve is on, but the folder is not under version control, so the command is asked about as usual'
  return null
}

/** Whether to put a notification on the desktop for a request: off by setting, or the window is in front already. */
export function shouldNotify(opts: { focused: boolean; setting: string | null }): boolean {
  if (opts.setting === '0') return false
  return !opts.focused
}

const COMMAND_MAX = 90

/** The words on the notification: which conversation, what it wants to run. */
export function approvalNotice(opts: { conversationTitle: string; command: string }): { title: string; body: string } {
  const cmd = opts.command.replace(/\s+/g, ' ').trim()
  const shown = cmd.length > COMMAND_MAX ? `${cmd.slice(0, COMMAND_MAX - 1).trimEnd()}…` : cmd
  return {
    title: 'Harbor is waiting on you',
    body: `${opts.conversationTitle.trim() || 'A conversation'} wants to run: ${shown}`
  }
}
