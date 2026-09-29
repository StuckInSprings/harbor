import type { AssembledSystem } from '../../shared/types'
import { formatTokens } from '../lib/format'
import { Sheet } from './Sheet'

/**
 * What actually goes to the model, before the conversation starts.
 *
 * Harbor's rule everywhere else is that a context addition is visible — tool
 * calls collapse into rows, web results are cited, memories are listed. The
 * system prompt was the exception: three of its four parts are generated, and
 * none of them were ever shown. This is that exception closed.
 */
export function PromptSheet({
  system,
  onClose
}: {
  system: AssembledSystem | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet title="System prompt" panel="sheet__panel--tall" aside={system && <span className="sounding">{formatTokens(system.tokens)} tokens</span>} onClose={onClose}>

        <div className="sheet__body">
          {!system || system.sections.length === 0 ? (
            <p className="hint">
              Nothing is being sent ahead of the conversation. Add project instructions, a
              skill or a memory and they will appear here.
            </p>
          ) : (
            <>
              <p className="tabs__blurb">
                Sent before every message in this conversation, assembled in this order.
                Everything here is identical turn to turn, which is what makes caching
                worth anything.
              </p>

              <div className="note" style={{ borderColor: system.cached ? 'var(--starboard)' : undefined }}>
                {system.cacheNote}
              </div>

              {system.sections.map((sec) => (
                <section className="psec" key={sec.label}>
                  <div className="psec__head">
                    <span className="psec__label">{sec.label}</span>
                    <span className="sounding">{formatTokens(sec.tokens)}</span>
                  </div>
                  <pre className="psec__text">{sec.text}</pre>
                </section>
              ))}

              <button
                className="btn"
                style={{ marginTop: 4 }}
                onClick={() => void navigator.clipboard.writeText(system.text)}
              >
                Copy the whole prompt
              </button>
            </>
          )}
        </div>
    </Sheet>
  )
}
