import { useEffect, useState } from 'react'

/**
 * Somewhere for failures to go.
 *
 * Harbor surfaced errors that flowed through a turn, and quietly dropped
 * everything else — a rejected IPC call left the interface unchanged, which
 * reads as the app ignoring you. This is the one place that never happens.
 *
 * A module singleton rather than context, so any component can report a failure
 * without threading a callback through its parents.
 */

export type NoticeKind = 'error' | 'warn' | 'info'

/** Set on a failed envelope by whoever reported it, so the bridge wrapper does not report it again. */
export const REPORTED: unique symbol = Symbol('reported')

export interface Notice {
  id: string
  text: string
  kind: NoticeKind
  at: number
  /** One thing to do about it, such as opening what it is about. */
  action?: { label: string; run: () => void }
}

const MAX = 4
const AUTO_DISMISS_MS = 9000

let notices: Notice[] = []
const listeners = new Set<(n: Notice[]) => void>()

const emit = (): void => {
  for (const l of listeners) l(notices)
}

export function notify(text: string, kind: NoticeKind = 'error', action?: Notice['action']): void {
  const clean = text.trim()
  if (!clean) return

  // The same failure repeating is one problem, not many.
  const existing = notices.find((n) => n.text === clean)
  if (existing) {
    notices = [...notices.filter((n) => n.id !== existing.id), { ...existing, at: Date.now() }]
    emit()
    return
  }

  const notice: Notice = {
    id: crypto.randomUUID(),
    text: clean,
    kind,
    at: Date.now(),
    ...(action ? { action } : {})
  }
  notices = [...notices, notice].slice(-MAX)
  emit()

  // Errors stay until dismissed; softer notices get out of the way.
  if (kind !== 'error') setTimeout(() => dismiss(notice.id), AUTO_DISMISS_MS)
}

/**
 * For the many call sites that only cared about the happy path. Returns whether
 * it succeeded, so a caller can still branch.
 */
export function ok<T>(r: { ok: boolean; error?: string; data?: T; [REPORTED]?: boolean }, fallback?: string): boolean {
  if (r.ok) return true
  r[REPORTED] = true
  notify(r.error ?? fallback ?? 'That did not work.')
  return false
}

/** For a caller that shows the failure its own way: marks it reported, so nothing else does. */
export function handled<T extends { ok: boolean; [REPORTED]?: boolean }>(r: T): T {
  if (!r.ok) r[REPORTED] = true
  return r
}

export function dismiss(id: string): void {
  notices = notices.filter((n) => n.id !== id)
  emit()
}

export function useNotices(): Notice[] {
  const [current, setCurrent] = useState<Notice[]>(notices)
  useEffect(() => {
    listeners.add(setCurrent)
    return () => {
      listeners.delete(setCurrent)
    }
  }, [])
  return current
}

/**
 * The backstop. Twenty-one call sites unwrap an IPC result and throw on
 * failure; inside a floating promise that becomes an unhandled rejection and
 * vanishes. Catching it here means a failure nobody anticipated still shows up.
 */
export function installGlobalHandlers(): void {
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    notify(reason instanceof Error ? reason.message : String(reason))
  })
  window.addEventListener('error', (e) => {
    if (e.message) notify(e.message)
  })
  window.harbor.onAppError((message) => notify(message))
}
