/** Rough token estimate — good enough for a context gauge, replaced in Phase 2. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/*
  A single cheap message costs on the order of $0.00001, and rounding that to
  four places prints $0.0000 — a readout that says nothing. Keep enough places
  to stay truthful, and trim the zeros so the column stays narrow.
*/
/** A time of day, local, to the millisecond: the log's clock. */
export function clock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return ''
  if (usd === 0) return 'free'
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  if (usd >= 0.001) return `$${usd.toFixed(4)}`
  // Below six places the trim would leave a bare "$0." — say "too small" instead.
  if (usd < 0.000001) return '<$0.000001'
  return `$${usd.toFixed(6).replace(/0+$/, '')}`
}

/** Money as money: two places, for budgets and what a run has spent against one. */
export const formatMoney = (usd: number): string => `$${usd.toFixed(2)}`

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

export function formatPrice(perMillion: number): string {
  if (perMillion === 0) return 'free'
  if (perMillion < 1) return `$${perMillion.toFixed(2)}`
  return `$${perMillion.toFixed(perMillion < 10 ? 1 : 0)}`
}

/** "openai/gpt-5-mini" -> "gpt-5-mini" */
export const shortModel = (id: string): string => id.split('/').pop() ?? id

export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/[#*`>]/g, '').trim()
  if (line.length <= 48) return line || 'Untitled'
  return `${line.slice(0, 48).trimEnd()}…`
}
