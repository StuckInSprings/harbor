import { useClock } from '../lib/clock'
import {
  activityLabel,
  activityNote,
  formatElapsed,
  thoughtTail,
  type Activity as Turn
} from '../../shared/activity'
import { shortModel } from '../lib/format'

/**
 * The waiting line.
 *
 * It replaces a blinking cursor with the three things worth knowing while a
 * turn runs: which phase it is in, how long it has been there, and — when the
 * model is reasoning — what it is currently thinking about. The clock is the
 * important part. A number that moves is the difference between a slow turn
 * and a dead one, and that was previously impossible to tell apart.
 */
export function Activity({
  turn,
  reasoning,
  compact = false
}: {
  turn: Turn
  reasoning?: string
  /** The label is already on screen — show only the clock beside it. */
  compact?: boolean
}): React.JSX.Element {
  // One second hand for every waiting line in the window; see src/lib/clock.ts.
  const now = useClock()

  const label = activityLabel({
    ...turn,
    detail: turn.phase === 'sending' || turn.phase === 'waiting'
      ? turn.detail && shortModel(turn.detail)
      : turn.detail
  })
  const note = activityNote(turn, now)
  const thought = turn.phase === 'thinking' && reasoning ? thoughtTail(reasoning) : ''
  const elapsed = now - turn.since

  return (
    <div className="activity" role="status" aria-live="polite">
      <div className="activity__line">
        <span className="activity__mark" data-phase={turn.phase} aria-hidden />
        {!compact && <span className="activity__label">{label}</span>}
        {/* Under two seconds the clock is noise; after that it is the point. */}
        {elapsed >= 2000 && <span className="activity__time">{formatElapsed(elapsed)}</span>}
      </div>
      {thought && <div className="activity__thought">{thought}</div>}
      {note && <div className="activity__note sounding">{note}</div>}
    </div>
  )
}
