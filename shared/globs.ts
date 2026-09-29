/**
 * Small pure helpers over project files that both processes use: whether a
 * path is inside a project's write allowance, and a Markdown file's front
 * matter. Nothing here touches disk.
 */

import { hookMatches } from './hooks'

/** The `key: value` lines between the opening `---` pair, or null without them. */
export function frontMatter(text: string): Record<string, string> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) return null
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** Whether a relative path is inside the project's write allowance; no globs means anywhere. */
export function withinWriteGlobs(path: string, globs: string[]): boolean {
  if (globs.length === 0) return true
  return globs.some((g) => hookMatches({ glob: g, command: '' }, path))
}
