import type { Result } from '../../shared/types'
import { notify, REPORTED } from './notices'

/**
 * Unwraps the {ok, data, error} envelope. It still throws so a caller cannot
 * carry on with nothing, but it reports first — otherwise the throw lands in a
 * floating promise and the failure is invisible.
 */
export const unwrap = <T,>(r: Result<T> & { [REPORTED]?: boolean }): T => {
  if (!r.ok) {
    r[REPORTED] = true
    const message = r.error ?? 'Something went wrong.'
    notify(message)
    throw new Error(message)
  }
  return r.data as T
}
