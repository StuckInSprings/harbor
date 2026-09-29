import { db } from './connection'

/**
 * What the blob store is still needed for: every snapshot a checkpoint
 * points at, and every attachment a message carries. Anything else in the
 * store is a leftover of a deleted conversation or a pruned checkpoint.
 */
export function referencedBlobs(): Set<string> {
  const keep = new Set<string>()
  for (const r of db.prepare('SELECT before_hash AS b, after_hash AS a FROM checkpoints').all() as { b: string | null; a: string | null }[]) {
    if (r.b) keep.add(r.b)
    if (r.a) keep.add(r.a)
  }
  for (const r of db.prepare('SELECT attachments FROM messages WHERE attachments IS NOT NULL').all() as { attachments: string }[]) {
    try {
      for (const a of JSON.parse(r.attachments) as { hash?: string }[]) if (a?.hash) keep.add(a.hash)
    } catch {
      /* an unreadable list references nothing */
    }
  }
  return keep
}

/**
 * Checkpoints older than the retention window go, and with them the way
 * back to those versions. Every edit stores a full copy of the file, so a
 * store that only ever grew would in time hold every version of everything.
 */
export function pruneCheckpoints(olderThanMs: number): number {
  if (olderThanMs <= 0) return 0
  const cutoff = Date.now() - olderThanMs
  return db.prepare('DELETE FROM checkpoints WHERE created_at < ?').run(cutoff).changes
}
