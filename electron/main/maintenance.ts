import * as db from './db'
import * as blobs from './blobs'
import { sweepSpills } from './spill'
import * as log from './log'

/** How long a way back to an old version is kept, unless Settings says otherwise; 0 keeps everything. */
export const RETENTION_SETTING = 'checkpoint_retention_days'
export const DEFAULT_RETENTION_DAYS = 90

export function retentionDays(): number {
  const raw = db.getSetting(RETENTION_SETTING)
  if (raw === null || raw.trim() === '') return DEFAULT_RETENTION_DAYS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS
}

/**
 * The store used to grow without limit: every edit a full copy, nothing
 * ever removed, not even for a conversation that was deleted. Old
 * checkpoints are pruned by the retention window, then every blob nothing
 * points at is swept. Run a little after startup so the window is up first.
 */
export async function housekeep(): Promise<{ pruned: number; removed: number; bytes: number }> {
  const pruned = db.pruneCheckpoints(retentionDays() * 24 * 3_600_000)
  const swept = await blobs.sweep(db.referencedBlobs())
  // Saved tool results belong to turns; a week after the turn nobody reads them.
  const spills = await sweepSpills(7 * 24 * 3_600_000)
  if (pruned || swept.removed || spills) log.info('housekeeping', 'done', { prunedCheckpoints: pruned, removedBlobs: swept.removed, mb: Math.round(swept.bytes / 1024 / 1024), spilledResults: spills })
  return { pruned, ...swept }
}
