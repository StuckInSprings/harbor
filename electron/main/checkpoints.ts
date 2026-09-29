import * as db from './db'
import type { Unlockable } from '../../shared/types'
import * as blobs from './blobs'
import { readRaw, writeRaw, deleteRaw } from './workspace'

/**
 * Edits auto-apply, so every write is snapshotted first. A checkpoint records
 * the file's content before and after a single edit; undoing one restores the
 * before, and reverting a run undoes its edits newest-first.
 *
 * Snapshots are content-addressed blobs under Application Support, never in the
 * project folder.
 */

const putBlob = blobs.put
export const getBlob = blobs.getText

/** Snapshot, then write. Returns the checkpoint id. */
export async function writeWithCheckpoint(
  root: string,
  runId: string,
  conversationId: string,
  path: string,
  next: string,
  unlocked: Unlockable[] = [],
  webUsed = false
): Promise<string> {
  const before = await readRaw(root, path, unlocked)
  const beforeHash = before === null ? null : await putBlob(before)
  const afterHash = await putBlob(next)
  await writeRaw(root, path, next, unlocked)
  return db.addCheckpoint({
    runId,
    conversationId,
    path,
    beforeHash,
    afterHash,
    created: before === null,
    webUsed
  })
}

/** Put a single edit back the way it was. */
export async function undo(
  root: string,
  checkpointId: string,
  unlocked: Unlockable[] = []
): Promise<void> {
  const cp = db.getCheckpoint(checkpointId)
  if (!cp || cp.undone) return
  if (cp.beforeHash === null) {
    await deleteRaw(root, cp.path, unlocked)
  } else {
    const before = await getBlob(cp.beforeHash)
    if (before === null) throw new Error(`The snapshot for ${cp.path} is missing.`)
    await writeRaw(root, cp.path, before, unlocked)
  }
  db.markUndone(checkpointId, true)
}

/** Undo an entire run, newest edit first so overlapping writes unwind cleanly. */
export async function revertRun(
  root: string,
  runId: string,
  unlocked: Unlockable[] = []
): Promise<number> {
  const list = db.listCheckpoints(runId).filter((c) => !c.undone)
  let n = 0
  for (const cp of [...list].reverse()) {
    await undo(root, cp.id, unlocked)
    n++
  }
  return n
}
