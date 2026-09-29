import { useEffect, useMemo, useRef } from 'react'
import { highlight, runs } from '../lib/highlight'

/**
 * A highlighted editor without an editor library.
 *
 * The textarea does the editing — caret, selection, undo, input methods —
 * with its text made transparent. A highlighted copy of the same text sits
 * underneath in the same font, padding and wrapping, scrolled in step. What
 * is typed lands in the invisible layer and shows in the coloured one. It
 * gives up bracket matching and folding to stay a few dozen lines and cost
 * nothing to ship.
 */
export function CodeEditor({
  value,
  language,
  spellCheck,
  onChange,
  onKeyDown,
  inputRef,
  wrap = true
}: {
  value: string
  language: string | null
  spellCheck: boolean
  onChange: (next: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  /** Long lines fold at the edge instead of running off it. */
  wrap?: boolean
}): React.JSX.Element {
  const view = useRef<HTMLPreElement>(null)

  // A trailing newline collapses in a <pre>; a space after it keeps the height honest.
  const shown = useMemo(() => runs(highlight(value.endsWith('\n') ? `${value} ` : value, language)), [value, language])

  const sync = (): void => {
    const ta = inputRef.current
    const pre = view.current
    if (!ta || !pre) return
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
  }
  useEffect(sync)

  return (
    <div className="code" data-wrap={wrap}>
      <pre className="code__view hljs" ref={view} aria-hidden>
        {shown.map((r, i) =>
          r.classes.length ? (
            <span className={r.classes.join(' ')} key={i}>
              {r.text}
            </span>
          ) : (
            r.text
          )
        )}
      </pre>
      <textarea
        ref={inputRef}
        className="code__input"
        value={value}
        spellCheck={spellCheck}
        wrap="off"
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={sync}
      />
    </div>
  )
}
