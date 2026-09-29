/**
 * Model tiers: which model a task of a given weight goes to.
 *
 * A director choosing a model per task should not be choosing from the whole
 * catalogue. The person names a handful of tiers — quick, standard, deep,
 * director — and says what each is for; the director picks a tier, and the
 * tier names the model. Kept as text in the project settings, one tier per
 * line, so it can be read and edited without a form.
 */

export interface Tier {
  name: string
  /** A model id; empty means the conversation's own model. */
  model: string
  /** What this tier is for, in the person's words. */
  note: string
}

export const DEFAULT_TIERS: Tier[] = [
  { name: 'quick', model: '', note: 'renames, single-file edits, lookups, short summaries' },
  { name: 'standard', model: '', note: 'a feature across a few files, tests, a document, a first draft' },
  { name: 'deep', model: '', note: 'cross-cutting changes, debugging, design work, anything that has to be right the first time' },
  { name: 'director', model: '', note: 'planning and orchestration only; needs at least a million tokens of context' }
]

/** The director's tier is the one that must exist; it is the one that plans. */
export const DIRECTOR_TIER = 'director'
/**
 * Two tiers a project may name for phases rather than tasks: `plan`, the
 * model a plan-mode turn runs on (a reasoning model to think, a cheaper
 * one to edit), and `oracle`, a strong model the agent may put a question
 * to for a second opinion. Either left unnamed falls back to the
 * conversation's own model.
 */
export const PLAN_TIER = 'plan'
export const ORACLE_TIER = 'oracle'
export const DIRECTOR_CONTEXT_MIN = 1_000_000

/** `name = model | note`, one per line. The model may be left out; the note may be too. */
export function parseTiers(text: string): Tier[] {
  const out: Tier[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const name = line.slice(0, eq).trim().toLowerCase()
    if (!name) continue
    const rest = line.slice(eq + 1)
    const bar = rest.indexOf('|')
    const model = (bar === -1 ? rest : rest.slice(0, bar)).trim()
    const note = bar === -1 ? '' : rest.slice(bar + 1).trim()
    if (out.some((t) => t.name === name)) continue
    out.push({ name, model, note })
  }
  return out
}

export function formatTiers(tiers: Tier[]): string {
  return tiers.map((t) => `${t.name} = ${t.model}${t.note ? ` | ${t.note}` : ''}`).join('\n')
}

/** The tier by name, or null when the project has none by that name. */
export function findTier(tiers: Tier[], name: string): Tier | null {
  const key = name.trim().toLowerCase()
  return tiers.find((t) => t.name === key) ?? null
}

/** The model a tier resolves to, falling back to the conversation's own. */
export function tierModel(tiers: Tier[], name: string, fallback: string): string {
  const t = findTier(tiers, name)
  return t?.model.trim() || fallback
}

/** The tiers as a director reads them: a table, with the model each names. */
export function tierTable(tiers: Tier[], fallback: string): string {
  if (tiers.length === 0) return ''
  const rows = tiers.map((t) => `| ${t.name} | ${t.model.trim() || `${fallback} (this conversation's)`} | ${t.note || ''} |`)
  return ['| tier | model | for |', '| --- | --- | --- |', ...rows].join('\n')
}
