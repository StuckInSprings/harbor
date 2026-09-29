import { dismiss, useNotices } from '../lib/notices'
import { Cross } from './Icons'

/**
 * Sits above the composer rather than in a corner, because that is where the
 * eye already is when something you just did fails.
 */
export function Notices(): React.JSX.Element {
  const notices = useNotices()
  if (notices.length === 0) return <></>

  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <div className="notice" data-kind={n.kind} key={n.id} role={n.kind === 'error' ? 'alert' : undefined}>
          <span className="notice__text">{n.text}</span>
          {n.action && (
            <button
              className="btn btn--small"
              onClick={() => {
                n.action?.run()
                dismiss(n.id)
              }}
            >
              {n.action.label}
            </button>
          )}
          <button className="notice__x" onClick={() => dismiss(n.id)} title="Dismiss" aria-label="Dismiss">
            <Cross size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}
