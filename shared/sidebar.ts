/**
 * What the sidebar shows of a project's conversations. Every conversation
 * used to be a row for good, so a project a person had worked in for a
 * month was a scroll of forty titles, and the sidebar grew with every
 * project. Now a project shows what is pinned and what is recent, and the
 * rest on request, grouped by when it was last touched. Pure, so it can
 * be tested without a window.
 */

export interface Row {
  id: string
  title: string
  pinned: boolean
  archived: boolean
  updatedAt: number
}

/** How many recent conversations a project shows before "show all". */
export const RECENT = 6

export interface Shown<T extends Row> {
  /** Pinned first, then the newest, up to the limit; or everything when expanded. */
  rows: T[]
  /** How many are kept back by the limit. Zero when expanded or when there is nothing more. */
  more: number
}

/** The rows a project shows: pinned first, then by recency; cut to the limit unless expanded. */
export function shownRows<T extends Row>(all: T[], expanded: boolean, recent = RECENT): Shown<T> {
  const sorted = [...all].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  if (expanded || sorted.length <= recent) return { rows: sorted, more: 0 }
  const pinned = sorted.filter((c) => c.pinned)
  const rest = sorted.filter((c) => !c.pinned)
  const keep = Math.max(recent - pinned.length, Math.min(rest.length, 2))
  const rows = [...pinned, ...rest.slice(0, keep)]
  return { rows, more: sorted.length - rows.length }
}

export type Bucket = 'Pinned' | 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Earlier'

/** Rows in the buckets a person thinks in, in that order, empty buckets left out. */
export function groupByRecency<T extends Row>(rows: T[], now = Date.now()): { label: Bucket; rows: T[] }[] {
  const day = 86_400_000
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  const bucketOf = (c: T): Bucket => {
    if (c.pinned) return 'Pinned'
    if (c.updatedAt >= today) return 'Today'
    if (c.updatedAt >= today - day) return 'Yesterday'
    if (c.updatedAt >= today - 6 * day) return 'This week'
    if (c.updatedAt >= today - 30 * day) return 'This month'
    return 'Earlier'
  }
  const order: Bucket[] = ['Pinned', 'Today', 'Yesterday', 'This week', 'This month', 'Earlier']
  const byBucket = new Map<Bucket, T[]>()
  for (const c of rows) {
    const b = bucketOf(c)
    byBucket.set(b, [...(byBucket.get(b) ?? []), c])
  }
  return order.filter((b) => byBucket.has(b)).map((label) => ({ label, rows: byBucket.get(label)! }))
}

/** A title filter for a long project: case-insensitive, on words in any order. */
export function matchesFilter(title: string, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const t = title.toLowerCase()
  return words.every((w) => t.includes(w))
}

/* ------------------------------------------------------------ ordering */

/** The order with one item dropped before or after another; unchanged when either is missing or they are the same. */
export function moveItem(ids: string[], dragged: string, target: string, place: 'before' | 'after'): string[] {
  if (dragged === target || !ids.includes(dragged) || !ids.includes(target)) return ids
  const rest = ids.filter((id) => id !== dragged)
  const at = rest.indexOf(target) + (place === 'after' ? 1 : 0)
  return [...rest.slice(0, at), dragged, ...rest.slice(at)]
}

/** The order with one item moved a step up (-1) or down (+1); unchanged at either end. */
export function moveBy(ids: string[], id: string, delta: -1 | 1): string[] {
  const i = ids.indexOf(id)
  const j = i + delta
  if (i === -1 || j < 0 || j >= ids.length) return ids
  const next = [...ids]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}
