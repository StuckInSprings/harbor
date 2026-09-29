import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * A tool result too large for the context is written to a file of its own
 * under Application Support, and the model is given the head of it and the
 * path. It can read the rest with read_file, which lets this one folder
 * through the jail because the files are Harbor's, not the person's.
 *
 * A single read_file may return half a megabyte, and a hundred-step run
 * used to carry every byte of every result to the end; the model read
 * less of each one than it was billed for.
 */

/** Past this many characters a result is spilled; roughly twelve thousand tokens. */
export const SPILL_CHARS = 48_000
/** What the model is shown in place: the first this many characters. */
export const HEAD_CHARS = 8_000

export const spillDir = (): string => join(app.getPath('userData'), 'tool-results')

export const isSpillPath = (path: string): boolean => {
  const root = resolve(spillDir())
  const p = resolve(path)
  return p === root || p.startsWith(root + sep)
}

/** The text the model gets: the whole thing when it fits, the head and where the rest is when it does not. */
export async function spillIfLarge(requestId: string, callId: string, name: string, output: string): Promise<string> {
  if (output.length <= SPILL_CHARS) return output
  const dir = join(spillDir(), requestId.slice(0, 8))
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, `${callId.replace(/[^\w.-]/g, '_') || 'result'}.txt`)
  await fs.writeFile(file, output)
  const lines = output.split('\n').length
  return (
    `${output.slice(0, HEAD_CHARS)}\n\n` +
    `[The ${name} result was ${output.length.toLocaleString()} characters (${lines.toLocaleString()} lines); the first ${HEAD_CHARS.toLocaleString()} are above. ` +
    `The whole of it is saved at ${file}. Read the part you need with read_file on that path and an offset and limit; do not read all of it.]`
  )
}

/** A spilled result, numbered like any other read, by line offset and limit. */
export async function readSpilled(path: string, offset = 0, limit = 0): Promise<string> {
  if (!isSpillPath(path)) throw new Error(`${path} is not a saved tool result.`)
  const text = await fs.readFile(path, 'utf8').catch(() => null)
  if (text === null) throw new Error(`${path} is no longer on file; the result was cleared. Run the tool again if you need it.`)
  const lines = text.split('\n')
  const from = Math.max(offset, 0)
  const to = limit > 0 ? Math.min(from + limit, lines.length) : Math.min(from + 400, lines.length)
  const body = lines
    .slice(from, to)
    .map((line, i) => `${String(from + i + 1).padStart(5)}\t${line}`)
    .join('\n')
  return to < lines.length ? `${body}\n[${lines.length - to} more lines; continue with offset ${to}.]` : body
}

/** Results from turns long over; nothing points at them. */
export async function sweepSpills(olderThanMs: number): Promise<number> {
  const dir = spillDir()
  const names = await fs.readdir(dir).catch(() => [] as string[])
  let removed = 0
  const cutoff = Date.now() - olderThanMs
  for (const name of names) {
    const p = join(dir, name)
    const st = await fs.stat(p).catch(() => null)
    if (!st || st.mtimeMs > cutoff) continue
    await fs.rm(p, { recursive: true, force: true })
    removed++
  }
  return removed
}
