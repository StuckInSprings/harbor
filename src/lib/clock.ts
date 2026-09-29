import { useSyncExternalStore } from 'react'

/**
 * One second hand for the whole window. Every waiting line used to run
 * an interval of its own; a transcript with a few tool rows ticked several
 * times a second for nothing. This ticks once a second while anyone is
 * listening, and stops when no one is.
 */
let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now()
      for (const l of listeners) l()
    }, 1000)
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

export const useClock = (): number => useSyncExternalStore(subscribe, () => now, () => now)
