import type { HarborApi } from '../../electron/preload/index'
import { notify, REPORTED } from './notices'

/**
 * The bridge, with every failure reported. `window.harbor` answers each
 * call with {ok, data, error}; dozens of call sites read `data` on the
 * happy path and let a failed one pass in silence, which reads as the app
 * ignoring you. Every call through here that comes back `ok: false` is
 * put in front of the person, once, unless the caller reported it first
 * (unwrap and ok() mark what they report). Listeners and anything else
 * that does not answer with an envelope pass straight through.
 */
type AnyFn = (...args: unknown[]) => unknown

const isEnvelope = (v: unknown): v is { ok: boolean; error?: string; [REPORTED]?: boolean } =>
  !!v && typeof v === 'object' && 'ok' in v && typeof (v as { ok: unknown }).ok === 'boolean'

function wrapFn(fn: AnyFn, name: string): AnyFn {
  return (...args) => {
    const out = fn(...args)
    if (!(out instanceof Promise)) return out
    return out.then((r: unknown) => {
      if (isEnvelope(r) && !r.ok) {
        // After the caller's own handling has had its turn, so a failure it reports is not reported twice.
        setTimeout(() => {
          if (!r[REPORTED]) {
            r[REPORTED] = true
            notify(r.error ?? `${name} did not work.`)
          }
        }, 0)
      }
      return r
    })
  }
}

function wrapTree(get: () => Record<string, unknown>, path: string): unknown {
  const cache = new Map<string, unknown>()
  return new Proxy(
    {},
    {
      get(_t, key) {
        if (typeof key !== 'string') return undefined
        if (cache.has(key)) return cache.get(key)
        const target = get()
        const v = target?.[key]
        let out: unknown = v
        if (typeof v === 'function') out = wrapFn(v.bind(target) as AnyFn, `${path}${key}`)
        else if (v && typeof v === 'object') out = wrapTree(() => get()[key] as Record<string, unknown>, `${path}${key}.`)
        if (out !== undefined) cache.set(key, out)
        return out
      }
    }
  )
}

export const api = wrapTree(() => window.harbor as unknown as Record<string, unknown>, '') as HarborApi
