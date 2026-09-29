import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * Content-addressed blob store under Application Support, shared by checkpoint
 * snapshots and message attachments. Nothing here ever lands in a project
 * folder or the source tree.
 */

const dir = (): string => join(app.getPath('userData'), 'blobs')

export const hashOf = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex')

export async function put(data: Buffer | string): Promise<string> {
  const hash = hashOf(data)
  await fs.mkdir(dir(), { recursive: true })
  const file = join(dir(), hash)
  // Content-addressed, so an identical blob is already correct.
  await fs.access(file).catch(() => fs.writeFile(file, data))
  return hash
}

/**
 * A hash is a name in the store, not a path. Anything else ("../harbor.db")
 * is not a blob and is answered as if it did not exist.
 */
export const isHash = (hash: unknown): hash is string => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)

export async function getBuffer(hash: string): Promise<Buffer | null> {
  if (!isHash(hash)) return null
  return fs.readFile(join(dir(), hash)).catch(() => null)
}

export async function getText(hash: string | null): Promise<string | null> {
  if (!hash || !isHash(hash)) return null
  return fs.readFile(join(dir(), hash), 'utf8').catch(() => null)
}

/**
 * Removes every blob not in `keep`. The store is content-addressed and
 * nothing else names its files, so a blob nobody references is gone for
 * good and can go. Files that are not hashes are not the store's and are
 * left alone.
 */
export async function sweep(keep: Set<string>): Promise<{ removed: number; bytes: number }> {
  const names = await fs.readdir(dir()).catch(() => [] as string[])
  let removed = 0
  let bytes = 0
  for (const name of names) {
    if (!isHash(name) || keep.has(name)) continue
    const file = join(dir(), name)
    const size = await fs.stat(file).then((s) => s.size).catch(() => 0)
    await fs.unlink(file).catch(() => undefined)
    removed++
    bytes += size
  }
  return { removed, bytes }
}
