import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, relative } from 'node:path'

/**
 * Skills are repeatable procedures — see docs/CONTEXT-MODEL.md.
 *
 * They live as plain markdown on disk so they can be edited outside Harbor and
 * kept in git. Only the index (name plus one-line description) sits in the
 * system prompt; a body is pulled in when the model calls load_skill, which
 * keeps a hundred skills to a few hundred tokens and makes every load visible
 * in the transcript.
 */

export interface Skill {
  name: string
  description: string
  body: string
  /** null for a global skill, otherwise the project it belongs to. */
  projectId: string | null
  path: string
  /**
   * Where it came from: Harbor's own store, a skills folder in the project
   * (the SKILL.md format, agentskills.io), or one in the home folder.
   */
  source: 'harbor' | 'project' | 'home'
  /** Files beside a SKILL.md — scripts, references, assets — relative to the project root when inside it. */
  resources: string[]
}

/*
  The cross-tool format: a folder per skill with SKILL.md at its top, YAML
  front matter for the name and description, and scripts/, references/ and
  assets/ beside it. Three levels: the index line, the body on load, the
  files on demand. Read from the places the other tools read.
*/
const SKILL_DIRS_IN_PROJECT = ['skills', '.claude/skills', '.agents/skills', '.codex/skills']
const SKILL_DIRS_IN_HOME = ['.claude/skills', '.agents/skills']
const RESOURCE_DIRS = ['scripts', 'references', 'assets']

async function readSkillDir(dir: string, root: string | null, source: 'project' | 'home', projectId: string | null): Promise<Skill[]> {
  const names = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: Skill[] = []
  for (const e of names) {
    if (!e.isDirectory()) continue
    const folder = join(dir, e.name)
    const file = join(folder, 'SKILL.md')
    const raw = await fs.readFile(file, 'utf8').catch(() => null)
    if (raw === null) continue
    const parsed = parse(raw, file, projectId, source)
    const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')?.[1]?.trim()
    const resources: string[] = []
    for (const sub of RESOURCE_DIRS) {
      const files = await fs.readdir(join(folder, sub)).catch(() => [] as string[])
      for (const f of files.sort()) {
        const abs = join(folder, sub, f)
        resources.push(root && !relative(root, abs).startsWith('..') ? relative(root, abs) : abs)
      }
    }
    out.push({ ...parsed, name: slug(name || e.name), resources: resources.sort() })
  }
  return out
}

/** Skills kept beside the code, in the project's own folders. */
export async function discoverInProject(root: string, projectId: string | null): Promise<Skill[]> {
  const out: Skill[] = []
  for (const d of SKILL_DIRS_IN_PROJECT) out.push(...(await readSkillDir(join(root, d), root, 'project', projectId)))
  return out
}

/** Skills the person keeps for every tool, in the home folder. */
export async function discoverInHome(): Promise<Skill[]> {
  const out: Skill[] = []
  for (const d of SKILL_DIRS_IN_HOME) out.push(...(await readSkillDir(join(homedir(), d), null, 'home', null)))
  return out
}

const skillsRoot = (): string => join(app.getPath('userData'), 'skills')
const dirFor = (projectId: string | null): string =>
  projectId ? join(skillsRoot(), 'projects', projectId) : join(skillsRoot(), 'global')

/** Front matter is deliberately minimal: a name line and a description line. */
function parse(raw: string, path: string, projectId: string | null, source: Skill['source'] = 'harbor'): Skill {
  const name = basename(path, '.md')
  let description = ''
  let body = raw

  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (match) {
    const front = match[1]
    // Quoted in the cross-tool format when it holds a colon; the quotes are not the description.
    description = (/^description:[ \t]*(.+)$/m.exec(front)?.[1]?.trim() ?? '').replace(/^(["'])(.*)\1$/, '$2')
    body = raw.slice(match[0].length)
  } else {
    // No front matter: take the first non-heading line as the description.
    const firstProse = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'))
    description = firstProse ?? ''
  }

  return { name, description, body: body.trim(), projectId, path, source, resources: [] }
}

function serialise(description: string, body: string): string {
  return `---\ndescription: ${description.replace(/\n/g, ' ').trim()}\n---\n\n${body.trim()}\n`
}

async function readDir(projectId: string | null): Promise<Skill[]> {
  const dir = dirFor(projectId)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const out: Skill[] = []
  for (const file of names) {
    if (!file.endsWith('.md')) continue
    const path = join(dir, file)
    const raw = await fs.readFile(path, 'utf8').catch(() => null)
    if (raw !== null) out.push(parse(raw, path, projectId))
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every skill the turn may load, one per name: the home folder's, then
 * Harbor's global store, then Harbor's store for the project, then the
 * project's own folders — each later one wins a clash, so what is kept
 * beside the code is what applies to it.
 */
export async function list(projectId: string | null, root: string | null = null): Promise<Skill[]> {
  const byName = new Map<string, Skill>()
  for (const s of await discoverInHome()) byName.set(s.name, s)
  for (const s of await readDir(null)) byName.set(s.name, s)
  if (projectId) for (const s of await readDir(projectId)) byName.set(s.name, s)
  if (root) for (const s of await discoverInProject(root, projectId)) byName.set(s.name, s)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function get(projectId: string | null, name: string, root: string | null = null): Promise<Skill | null> {
  return (await list(projectId, root)).find((s) => s.name === name) ?? null
}

/** A loaded skill as the model reads it: the body, then the files beside it, which read_file reaches when they are inside the project. */
export function describe(s: Skill): string {
  const head = `Skill: ${s.name}\n${s.description}\n\n${s.body}`
  if (!s.resources.length) return head
  const inside = s.resources.filter((r) => !r.startsWith('/'))
  const outside = s.resources.filter((r) => r.startsWith('/'))
  return [
    head,
    inside.length ? `Files with this skill, for read_file when the skill points at them:\n${inside.map((r) => `- ${r}`).join('\n')}` : '',
    outside.length ? `Files with this skill that are outside the project, which read_file cannot reach; ask the person if one is needed:\n${outside.map((r) => `- ${r}`).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Slugged so the filename is always a usable skill name. */
export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'skill'

export async function save(
  projectId: string | null,
  name: string,
  description: string,
  body: string
): Promise<Skill> {
  const dir = dirFor(projectId)
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, `${slug(name)}.md`)
  await fs.writeFile(path, serialise(description, body), 'utf8')
  return { name: slug(name), description, body: body.trim(), projectId, path, source: 'harbor', resources: [] }
}

export async function remove(projectId: string | null, name: string): Promise<void> {
  await fs.rm(join(dirFor(projectId), `${slug(name)}.md`), { force: true })
}

/** The line the model sees for each skill, before any body is loaded. */
export function indexBlock(skills: Skill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description || 'no description'}`)
  return [
    'Skills available. These are procedures written down for you to follow.',
    'Call load_skill with a name when one applies; do not guess at the steps.',
    ...lines
  ].join('\n')
}
