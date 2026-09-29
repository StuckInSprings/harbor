import { useEffect, useRef, useState } from 'react'
import { Cross } from './Icons'

export interface TermBlock {
  handle: string
  command: string
  source: 'agent' | 'you' | 'hook'
  output: string
  exitCode?: number | null
  timedOut?: boolean
  done: boolean
}

export interface PendingApproval {
  approvalId: string
  conversationId: string
  command: string
  cwd: string
  /** Would run outside the sandbox. */
  unsandboxed?: boolean
  /** The judge's reason for not allowing it on its own. */
  note?: string
}

interface Props {
  conversationId: string | null
  blocks: TermBlock[]
  onRun: (command: string) => void
  onKill: (handle: string) => void
}

export function Terminal({ conversationId, blocks, onRun, onKill }: Props): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  // Following the output is one scroll per frame, not one per chunk.
  const frame = useRef(0)
  useEffect(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      endRef.current?.scrollIntoView({ block: 'end' })
    })
  }, [blocks])

  const submit = (): void => {
    const cmd = draft.trim()
    if (!cmd || !conversationId) return
    setDraft('')
    onRun(cmd)
  }

  return (
    <div className="term">
      <div className="term__scroll">
        {blocks.length === 0 && (
          <p className="hint">
            Nothing has run yet. Anything you type below runs straight away; what the agent
            asks to run is approved in the conversation, and its output lands here.
          </p>
        )}

        {blocks.map((b) => (
          <div className="term__block" key={b.handle}>
            <div className="term__cmd">
              <span
                className="term__prompt"
                title={
                  b.source === 'hook' ? 'Ran by a hook' : undefined
                }
              >
                {b.source === 'you' ? '$' : b.source === 'hook' ? '⚓' : '›'}
              </span>
              <span className="term__cmdtext">{b.command}</span>
              {!b.done && (
                <button className="term__kill" onClick={() => onKill(b.handle)} title="Stop" aria-label="Stop">
                  <Cross size={11} />
                </button>
              )}
            </div>
            {b.output && <pre className="term__out">{b.output}</pre>}
            {b.done && (
              <div className="sounding term__exit" data-bad={!!b.timedOut || b.exitCode !== 0}>
                {b.timedOut
                  ? 'timed out'
                  : b.exitCode === 0
                    ? 'exit 0'
                    : `exit ${b.exitCode ?? '?'}`}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="term__input">
        <span className="term__prompt">$</span>
        <input
          className="term__field"
          placeholder={conversationId ? 'Run a command' : 'Open a conversation first'}
          disabled={!conversationId}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </div>
    </div>
  )
}
