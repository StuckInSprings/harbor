import * as db from './db'
import { parseRouting, serialiseRouting, withIgnored, type Routing } from '../../shared/routing'

/** The stored routing preference; see shared/routing.ts. */
export const SETTING = 'routing'

export const current = (): Routing => parseRouting(db.getSetting(SETTING))

/** A provider that failed a stream is kept off the next request; returns true when newly blocked. */
export function block(provider: string): boolean {
  const before = current()
  const after = withIgnored(before, provider)
  if (after === before) return false
  db.setSetting(SETTING, serialiseRouting(after))
  return true
}
