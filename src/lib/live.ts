import { useSyncExternalStore } from 'react'

/**
 * The text of a reply while it streams, kept outside React state. Every
 * token used to be a state update in App, coalesced to one per frame, and
 * one per frame re-rendered the shell: sidebar, header, composer,
 * inspector and every row of the transcript. Here the text lands in a
 * store keyed by the turn, and only the row that shows it subscribes, so
 * a frame of streaming re-renders one component.
 */

export interface LiveText {
  text: string
  reasoning: string
}

const EMPTY: LiveText = { text: '', reasoning: '' }
const values = new Map<string, LiveText>()
const listeners = new Map<string, Set<() => void>>()
const anyListeners = new Set<() => void>()
const pending = new Set<string>()
let frame = 0
let anyAt = 0
let anyTimer: ReturnType<typeof setTimeout> | null = null

/** How often the coarse listeners (a gauge, a count) are told at most. */
const ANY_EVERY_MS = 500

function flush(): void {
  frame = 0
  const ids = [...pending]
  pending.clear()
  for (const id of ids) for (const l of listeners.get(id) ?? []) l()
  if (anyListeners.size) {
    const wait = ANY_EVERY_MS - (Date.now() - anyAt)
    if (wait <= 0) tellAny()
    else if (!anyTimer) anyTimer = setTimeout(tellAny, wait)
  }
}
function tellAny(): void {
  anyTimer = null
  anyAt = Date.now()
  for (const l of anyListeners) l()
}

export function setLive(id: string, value: LiveText): void {
  values.set(id, value)
  pending.add(id)
  if (!frame) frame = requestAnimationFrame(flush)
}

export function clearLive(id: string): void {
  if (!values.has(id)) return
  values.delete(id)
  pending.add(id)
  if (!frame) frame = requestAnimationFrame(flush)
}

export const getLive = (id: string | null | undefined): LiveText => (id ? (values.get(id) ?? EMPTY) : EMPTY)

export function subscribeLive(id: string, fn: () => void): () => void {
  const set = listeners.get(id) ?? new Set()
  set.add(fn)
  listeners.set(id, set)
  return () => {
    set.delete(fn)
    if (set.size === 0) listeners.delete(id)
  }
}

/** The live text of one turn; re-renders the caller once per frame while it streams, and only the caller. */
export function useLive(id: string | null | undefined): LiveText {
  return useSyncExternalStore(
    (fn) => (id ? subscribeLive(id, fn) : () => {}),
    () => getLive(id),
    () => getLive(id)
  )
}

/** The length of everything streaming, told at most twice a second: enough for a gauge. */
export function useLiveLength(ids: string[]): number {
  const key = ids.join('|')
  return useSyncExternalStore(
    (fn) => {
      anyListeners.add(fn)
      return () => {
        anyListeners.delete(fn)
      }
    },
    () => key.split('|').reduce((n, id) => n + (id ? getLive(id).text.length : 0), 0),
    () => 0
  )
}
