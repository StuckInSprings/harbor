import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep, basename, extname, dirname } from 'node:path'
import { imageMime } from '../../shared/files'
import type { WorkspaceEntry } from '../../shared/types'

/**
 * The path jail.
 *
 * Every filesystem operation the agent performs goes through resolveInside().
 * Because edits auto-apply (see "Agent safety" in the README), this is the boundary
 * between a bad model turn and the rest of the disk. It is enforced here in the
 * main process, never in the renderer, and there is no way around it.
 */

/** Directory names the agent never sees, at any depth. */
const DENIED_DIRS = new Set(['.git', 'node_modules', '.harbor', '.svn', '.hg'])

/** File extensions that usually hold private keys or certificates. */
const DENIED_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der', '.keystore'])

/** Exact basenames that carry credentials. */
const DENIED_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.netrc'])

/**
 * A project can unlock individual categories when it genuinely needs them —
 * reading .git to answer questions about history, say. Unlocking is per
 * category and per project, and it never widens the path jail itself: an
 * unlocked category is still confined to the project folder.
 *
 * Every entry point takes this as an explicit parameter defaulting to empty, so
 * a caller that forgets gets the locked behaviour rather than an open door.
 */
export type Unlockable = 'git' | 'deps' | 'env' | 'keys'

const CATEGORY_OF_DIR: Record<string, Unlockable> = {
  '.git': 'git',
  '.svn': 'git',
  '.hg': 'git',
  node_modules: 'deps'
}

/** A null byte means the file is binary and not worth handing to a model. */
const NUL = String.fromCharCode(0)

export class WorkspaceError extends Error {}

/**
 * Whether a directory entry is hidden from the agent. Names are compared in
 * lower case because APFS is case-insensitive: `.GIT/config` opens the same
 * file as `.git/config`, so a case-sensitive list is no list at all.
 */
function hiddenName(name: string, open: Set<Unlockable>): boolean {
  const lower = name.toLowerCase()
  if (DENIED_DIRS.has(lower) && !open.has(CATEGORY_OF_DIR[lower])) return true
  if (lower.startsWith('.env') && !open.has('env')) return true
  return false
}

function checkDenied(rel: string, unlocked: Unlockable[]): void {
  const open = new Set(unlocked)

  for (const part of rel.split(sep).filter(Boolean)) {
    const lower = part.toLowerCase()
    if (DENIED_DIRS.has(lower) && !open.has(CATEGORY_OF_DIR[lower])) {
      throw new WorkspaceError(
        `${part} is off limits in this project. Unlock it in project settings if the work genuinely needs it.`
      )
    }
  }

  const name = basename(rel).toLowerCase()
  if (name.startsWith('.env') && !open.has('env')) {
    throw new WorkspaceError('.env files are off limits, they usually hold secrets.')
  }
  if (
    (DENIED_NAMES.has(name) || DENIED_EXTS.has(extname(name).toLowerCase())) &&
    !open.has('keys')
  ) {
    throw new WorkspaceError(`${name} looks like a key or certificate, so it is off limits.`)
  }
}

/**
 * Resolve a caller-supplied path against the project root and prove it stays
 * inside, after symlinks are followed, so a link pointing out is caught too.
 */
export async function resolveInside(
  root: string,
  input: string,
  unlocked: Unlockable[] = []
): Promise<string> {
  if (!root) {
    throw new WorkspaceError('This project has no folder set. Add one in project settings.')
  }

  const realRoot = await fs.realpath(root)
  const candidate = resolve(realRoot, input)

  // Lexical check first: catches ../ without touching the filesystem.
  const lexicalRel = relative(realRoot, candidate)
  if (lexicalRel.startsWith('..') || resolve(realRoot, lexicalRel) !== candidate) {
    throw new WorkspaceError(`${input} is outside the project folder.`)
  }
  checkDenied(lexicalRel, unlocked)

  // Then resolve symlinks on the deepest part that exists, and check again.
  let existing = candidate
  for (;;) {
    try {
      await fs.lstat(existing)
      break
    } catch {
      const parent = resolve(existing, '..')
      if (parent === existing) break
      existing = parent
    }
  }
  const realExisting = await fs.realpath(existing).catch(() => existing)
  const realRel = relative(realRoot, realExisting)
  if (realRel.startsWith('..')) {
    throw new WorkspaceError(`${input} resolves through a link to somewhere outside the project.`)
  }
  // The deny list again, on where the path really leads: a link inside the
  // project named `gitlink` that points at `.git` is still `.git`.
  checkDenied(realRel, unlocked)

  return candidate
}

export const toRelative = (root: string, absolute: string): string =>
  relative(root, absolute) || basename(absolute)

/* ------------------------------------------------------------------ read */

const MAX_READ_BYTES = 512 * 1024

export async function readFile(
  root: string,
  path: string,
  offset = 0,
  limit = 0,
  unlocked: Unlockable[] = []
): Promise<string> {
  const abs = await resolveInside(root, path, unlocked)
  const stat = await fs.stat(abs)
  if (stat.isDirectory()) throw new WorkspaceError(`${path} is a directory. Use list_dir.`)
  if (stat.size > MAX_READ_BYTES) {
    throw new WorkspaceError(
      `${path} is ${Math.round(stat.size / 1024)}KB, larger than Harbor reads in one call. Use offset and limit.`
    )
  }

  const text = await fs.readFile(abs, 'utf8')
  if (text.includes(NUL)) throw new WorkspaceError(`${path} is a binary file.`)

  const lines = text.split('\n')
  const from = Math.max(offset, 0)
  const to = limit > 0 ? Math.min(from + limit, lines.length) : lines.length
  return lines
    .slice(from, to)
    .map((line, i) => `${String(from + i + 1).padStart(5)}\t${line}`)
    .join('\n')
}

export async function listDir(
  root: string,
  path = '.',
  unlocked: Unlockable[] = []
): Promise<string> {
  const abs = await resolveInside(root, path, unlocked)
  const entries = await fs.readdir(abs, { withFileTypes: true })
  const open = new Set(unlocked)

  const visible = entries
    .filter((e) => !hiddenName(e.name, open))
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
    )

  if (visible.length === 0) return `${path} is empty.`

  const rows = await Promise.all(
    visible.map(async (e) => {
      if (e.isDirectory()) return `${e.name}/`
      const s = await fs.stat(join(abs, e.name)).catch(() => null)
      return s ? `${e.name}\t${s.size}` : e.name
    })
  )
  return rows.join('\n')
}

/**
 * A directory as structured rows, for the explorer. The same things are
 * hidden as in listDir, so the tree cannot show what the agent cannot open.
 */
/** Whether a folder is inside a git repository: a .git at it or any parent. */
export async function isRepo(root: string): Promise<boolean> {
  let dir = resolve(root)
  for (;;) {
    if (await fs.stat(join(dir, '.git')).then(() => true, () => false)) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** The names of the plain files directly inside a folder; none when it does not exist. */
export async function listFiles(root: string, path: string, unlocked: Unlockable[] = []): Promise<string[]> {
  const abs = await resolveInside(root, path, unlocked)
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isFile()).map((e) => e.name)
}

export async function tree(
  root: string,
  path = '.',
  unlocked: Unlockable[] = []
): Promise<WorkspaceEntry[]> {
  const abs = await resolveInside(root, path, unlocked)
  const entries = await fs.readdir(abs, { withFileTypes: true })
  const open = new Set(unlocked)
  const visible = entries
    .filter((e) => !hiddenName(e.name, open))
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
    )
  return Promise.all(
    visible.map(async (e) => {
      if (e.isDirectory()) return { name: e.name, kind: 'dir' as const, size: 0, modifiedAt: 0 }
      const s = await fs.stat(join(abs, e.name)).catch(() => null)
      return { name: e.name, kind: 'file' as const, size: s?.size ?? 0, modifiedAt: s?.mtimeMs ?? 0 }
    })
  )
}

/** Big enough for a large screenshot, small enough not to take the window with it. */
const IMAGE_CAP = 25 * 1024 * 1024

/** An image's bytes as base64, for the viewer. Refuses anything that is not one. */
export async function readImage(
  root: string,
  path: string,
  unlocked: Unlockable[] = []
): Promise<{ mime: string; base64: string }> {
  const mime = imageMime(path)
  if (!mime) throw new WorkspaceError(`${path} is not an image Harbor can show.`)
  const abs = await resolveInside(root, path, unlocked)
  const stat = await fs.stat(abs)
  if (stat.size > IMAGE_CAP) {
    throw new WorkspaceError(`${path} is ${Math.round(stat.size / 1024 / 1024)}MB, too large to show here.`)
  }
  const data = await fs.readFile(abs)
  return { mime, base64: data.toString('base64') }
}

/* ---------------------------------------------------------------- search */

const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.mp4', '.mov', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.node', '.wasm'
])

async function* walk(
  dir: string,
  open: Set<Unlockable>,
  realRoot: string,
  depth = 0
): AsyncGenerator<string> {
  if (depth > 12) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (hiddenName(e.name, open)) continue
    const abs = join(dir, e.name)
    let isDir = e.isDirectory()
    if (e.isSymbolicLink()) {
      // A link is followed only where the jail would let the agent go by
      // name: inside the project, and not into a denied folder or file.
      // Otherwise `search` would read what `read_file` refuses.
      const real = await fs.realpath(abs).catch(() => null)
      if (!real) continue
      const rel = relative(realRoot, real)
      if (rel.startsWith('..')) continue
      try {
        checkDenied(rel, [...open])
      } catch {
        continue
      }
      const stat = await fs.stat(real).catch(() => null)
      if (!stat) continue
      isDir = stat.isDirectory()
    }
    if (isDir) yield* walk(abs, open, realRoot, depth + 1)
    else if (!SKIP_EXTS.has(extname(e.name).toLowerCase())) yield abs
  }
}

function globToRegex(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, 'GLOBSTAR')
    .replace(/\*/g, '[^/]*')
    .replace(/GLOBSTAR/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${body}$`)
}

/** Substring, or /regex/flags, over file contents or over file names. */
export async function search(
  root: string,
  query: string,
  opts: {
    kind?: 'content' | 'files'
    glob?: string
    max?: number
    unlocked?: Unlockable[]
  } = {}
): Promise<string> {
  const realRoot = await fs.realpath(root)
  const open = new Set(opts.unlocked ?? [])
  const max = opts.max ?? 80
  const kind = opts.kind ?? 'content'

  const asRegex = query.startsWith('/') && query.lastIndexOf('/') > 0
  const matcher = asRegex
    ? new RegExp(query.slice(1, query.lastIndexOf('/')), query.slice(query.lastIndexOf('/') + 1))
    : null

  const globRe = opts.glob ? globToRegex(opts.glob) : null
  const hits: string[] = []

  for await (const abs of walk(realRoot, open, realRoot)) {
    const rel = relative(realRoot, abs)
    if (globRe && !globRe.test(rel)) continue

    if (kind === 'files') {
      const hit = matcher ? matcher.test(rel) : rel.toLowerCase().includes(query.toLowerCase())
      if (hit) hits.push(rel)
    } else {
      const stat = await fs.stat(abs).catch(() => null)
      if (!stat || stat.size > MAX_READ_BYTES) continue
      const text = await fs.readFile(abs, 'utf8').catch(() => null)
      if (text === null || text.includes(NUL)) continue

      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const hit = matcher
          ? matcher.test(lines[i])
          : lines[i].toLowerCase().includes(query.toLowerCase())
        if (hit) {
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (hits.length >= max) break
        }
      }
    }
    if (hits.length >= max) break
  }

  if (hits.length === 0) return `No matches for ${query}.`
  return hits.join('\n') + (hits.length >= max ? `\nStopped at ${max} matches.` : '')
}

/* ----------------------------------------------------------------- write */

export const hashOf = (content: string): string =>
  createHash('sha256').update(content).digest('hex')

/** Current content, or null when the file does not exist yet. */
export async function readRaw(
  root: string,
  path: string,
  unlocked: Unlockable[] = []
): Promise<string | null> {
  const abs = await resolveInside(root, path, unlocked)
  return fs.readFile(abs, 'utf8').catch(() => null)
}

export async function writeRaw(
  root: string,
  path: string,
  content: string,
  unlocked: Unlockable[] = []
): Promise<void> {
  const abs = await resolveInside(root, path, unlocked)
  await fs.mkdir(resolve(abs, '..'), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
}

export async function deleteRaw(
  root: string,
  path: string,
  unlocked: Unlockable[] = []
): Promise<void> {
  const abs = await resolveInside(root, path, unlocked)
  await fs.rm(abs, { force: true })
}
