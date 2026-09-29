import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Cross } from './Icons'

/**
 * The one modal. A sheet covers the window, holds the keyboard inside
 * itself, closes on Escape or a click on the backdrop, and puts focus back
 * where it was when it goes. Twelve sheets used to do this each their own
 * way, which meant none of them held focus and none gave it back.
 *
 * `title` names the dialog for assistive tech; `aside` sits after it in the
 * head (a count, a project name); `actions` are buttons before the close.
 * `head` replaces the whole default head, for a sheet that opens on an
 * input. `dirty` asks before an unsaved edit is thrown away.
 */
export function Sheet({
  title,
  aside,
  actions,
  head,
  panel,
  dirty = false,
  discardPrompt = 'Discard the unsaved changes?',
  onClose,
  children
}: {
  title: string
  aside?: ReactNode
  actions?: ReactNode
  head?: ReactNode
  /** A modifier on the panel: 'sheet__panel--tall', 'sheet__panel--picker'. */
  panel?: string
  dirty?: boolean
  discardPrompt?: string
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  const requestClose = (): void => {
    if (dirtyRef.current && !window.confirm(discardPrompt)) return
    onClose()
  }

  /*
    Focus goes in when the sheet opens, to the first control that asks for
    it or to the panel itself, and comes back out to whatever had it when
    the sheet closes, as long as that is still on the page.
  */
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const el = panelRef.current
    if (el) {
      const first = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
      ;(first ?? el).focus({ preventScroll: true })
    }
    return () => {
      if (before && document.contains(before) && typeof before.focus === 'function') before.focus({ preventScroll: true })
    }
  }, [])

  const focusables = (): HTMLElement[] => {
    const el = panelRef.current
    if (!el) return []
    return [...el.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]')].filter(
      (e) => !e.hasAttribute('disabled') && e.tabIndex >= 0 && e.offsetParent !== null
    )
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      requestClose()
      return
    }
    // Tab stays inside: past the last control it comes round to the first, and back from the first to the last.
    if (e.key === 'Tab') {
      const list = focusables()
      if (list.length === 0) {
        e.preventDefault()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <div className="sheet" onMouseDown={requestClose} onKeyDown={onKeyDown}>
      <div
        ref={panelRef}
        className={`sheet__panel${panel ? ` ${panel}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {head ?? (
          <div className="sheet__head">
            <span className="sheet__title" id={titleId}>
              {title}
            </span>
            {aside}
            {actions}
            <button className="icon-btn" onClick={requestClose} title="Close" aria-label="Close">
              <Cross />
            </button>
          </div>
        )}
        {head && (
          <span id={titleId} className="sr-only">
            {title}
          </span>
        )}
        {children}
      </div>
    </div>
  )
}
