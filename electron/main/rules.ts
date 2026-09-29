import { readFile, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { hookMatches } from '../../shared/hooks'

/**
 * Instructions kept in the project folder.
 *
 * Every coding tool now reads a rules file from the repository — AGENTS.md by
 * convention, CLAUDE.md before that — and people already maintain them. Harbor
 * kept its project instructions in the database, which meant they did not
 * travel with the code. This reads the file at turn time, so editing it in the
 * repo changes the next turn, and it shows up in the prompt inspector like
 * every other section.
 */

/** In order of preference. AGENTS.md is the cross-tool convention; CLAUDE.md predates it. */
export const RULE_FILES = ['AGENTS.md', 'CLAUDE.md']

/** A rules file that has grown into a manual would crowd out the conversation. */
export const RULES_CAP = 24_000

export interface Rules {
  name: string
  text: string
  truncated: boolean
}

export async function readRules(root: string | null): Promise<Rules | null> {
  if (!root) return null
  for (const name of RULE_FILES) {
    let raw: string
    try {
      raw = await readFile(join(root, name), 'utf8')
    } catch {
      continue
    }
    const text = raw.trim()
    if (!text) continue
    return text.length > RULES_CAP
      ? { name, text: text.slice(0, RULES_CAP).trimEnd(), truncated: true }
      : { name, text, truncated: false }
  }
  return null
}

/** The prompt section, with provenance so the model knows where it came from. */
export function rulesBlock(r: Rules): string {
  const head = `# ${r.name}\nInstructions kept in the project folder. Follow them as you would the person's own.`
  const tail = r.truncated
    ? `\n\n[${r.name} is longer than ${RULES_CAP.toLocaleString()} characters and was cut here.]`
    : ''
  return `${head}\n\n${r.text}${tail}`
}

/*
  Instructions that apply to part of the project. Two conventions, read
  when a tool touches a file: a nested AGENTS.md (or CLAUDE.md) in the
  file's folder or the nearest folder above it, the closest one winning,
  as the other tools read them; and rules files under .claude/rules or
  .agents/rules whose front matter names the paths they apply to. The
  root's own rules file is in the prompt already and is not repeated.
*/
export const RULE_DIRS = ['.claude/rules', '.agents/rules']
/** One nested file, cut here; a folder's rules are notes, not a manual. */
export const NESTED_CAP = 8_000

export interface ScopedRule {
  /** Where it came from, for the model and the log. */
  label: string
  text: string
}

const cap = (text: string, label: string): string =>
  text.length > NESTED_CAP ? `${text.slice(0, NESTED_CAP).trimEnd()}\n\n[${label} was cut here.]` : text

/** The `paths:` of a rules file's front matter: a YAML list, or one line, comma separated. */
export function pathsOf(raw: string): string[] {
  const front = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1]
  if (!front) return []
  const m = /^paths:[ 	]*(.*)$/m.exec(front)
  if (!m) return []
  const inline = m[1].trim()
  if (inline) {
    const list = inline.replace(/^\[|\]$/g, '')
    return list.split(',').map((p) => p.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }
  const out: string[] = []
  const lines = front.split('\n')
  const at = lines.findIndex((l) => /^paths:\s*$/.test(l))
  for (const l of lines.slice(at + 1)) {
    const item = /^\s+-\s+(.+)$/.exec(l)
    if (!item) break
    out.push(item[1].trim().replace(/^["']|["']$/g, ''))
  }
  return out
}

/** The rules that apply to one path in the project, nearest folder first, then the matching rules files. */
export async function rulesForPath(root: string, relPath: string): Promise<ScopedRule[]> {
  const out: ScopedRule[] = []
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  // The nearest nested rules file, walking up from the file's folder and stopping short of the root.
  let dir = posix.dirname(rel)
  while (dir && dir !== '.' && dir !== '/') {
    let found = false
    for (const name of RULE_FILES) {
      const text = await readFile(join(root, dir, name), 'utf8').catch(() => null)
      if (text?.trim()) {
        out.push({ label: `${dir}/${name}`, text: cap(text.trim(), `${dir}/${name}`) })
        found = true
        break
      }
    }
    if (found) break
    const up = posix.dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const d of RULE_DIRS) {
    const files = await readdir(join(root, d)).catch(() => [] as string[])
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const raw = await readFile(join(root, d, f), 'utf8').catch(() => null)
      if (!raw) continue
      const globs = pathsOf(raw)
      if (!globs.length || !globs.some((g) => hookMatches({ glob: g, command: '' }, rel))) continue
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
      if (body) out.push({ label: `${d}/${f}`, text: cap(body, `${d}/${f}`) })
    }
  }
  return out
}

/** What is appended to a tool result the first time a folder's rules apply in a turn. */
export const scopedBlock = (rules: ScopedRule[]): string =>
  rules.map((r) => `[Instructions that apply here, from ${r.label}:\n${r.text}]`).join('\n\n')

