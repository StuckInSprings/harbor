import type { ApprovalDecision } from '../../shared/types'
import type { PendingApproval } from './Terminal'

/**
 * A pending command, asked in the conversation.
 *
 * This used to live only in the terminal pane, which meant the request could be
 * hidden behind whatever else was in the inspector — and a run waiting on a
 * decision nobody can see reads as the app having hung. The run is blocked, so
 * the question belongs where the work is.
 */
export function Approval({
  approvals,
  onDecide
}: {
  approvals: PendingApproval[]
  onDecide: (approvalId: string, decision: ApprovalDecision) => void
}): React.JSX.Element {
  if (approvals.length === 0) return <></>

  return (
    <>
      {approvals.map((a) => (
        <div className="approval" key={a.approvalId}>
          <div className="approval__head">{a.unsandboxed ? 'Run this command outside the sandbox?' : 'Run this command?'}</div>
          <pre className="approval__cmd">{a.command}</pre>
          <div className="approval__cwd sounding">in {a.cwd}</div>
          {a.note && <p className="approval__note">{a.note}</p>}
          {a.unsandboxed && (
            <p className="approval__note">
              The agent asked for this one unfenced: it could write anywhere you can and reach any host. Commands
              normally run in a sandbox that keeps writes to the project and network to allowed domains.
            </p>
          )}
          <div className="approval__actions">
            <button className="btn btn--primary" onClick={() => onDecide(a.approvalId, 'once')}>
              Run once
            </button>
            <button className="btn" onClick={() => onDecide(a.approvalId, 'always')}>
              Always allow
            </button>
            <button className="btn" onClick={() => onDecide(a.approvalId, 'deny')}>
              Deny
            </button>
          </div>
          <p className="approval__note">
            Always allow permits this command and anything starting with it, in this project
            only. You can take it back in project settings.
          </p>
        </div>
      ))}
    </>
  )
}
