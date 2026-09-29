import { join } from 'node:path'
import { db, connect, dataDir } from './connection'
import { createTables, migrate, SCHEMA_VERSION } from './schema'
import { ensureGeneral } from './projects'
import { repairBrokenChains } from './repair'
import { backfillSearchIndex } from './search'

export { dataDir, hasVectorSearch, transaction } from './connection'
export { SCHEMA_VERSION } from './schema'
export { repairBrokenChains } from './repair'
export * from './projects'
export * from './conversations'
export * from './messages'
export * from './usage'
export * from './settings'
export * from './checkpoints'
export * from './snapshots'
export * from './reviews'
export * from './allowlist'
export * from './knowledge'
export * from './memory'
export * from './search'
export * from './prompts'
export * from './maintenance'

/**
 * All Harbor state lives outside the source tree, in Application Support.
 * See "Process split" in the README. One module per table below; this one opens the
 * file, checks it, and brings its shape up to date.
 */
export function initDb(): void {
  connect()
  createTables()

  /*
    A database that has gone wrong surfaces as an exception from the first
    query that touches the broken page, which names nothing useful. Asked
    first, SQLite says so in a sentence, and the file is named.
  */
  const health = (db.pragma('quick_check', { simple: true }) as string) ?? 'ok'
  if (health !== 'ok') {
    throw new Error(`harbor.db failed its integrity check (${health}). The file is at ${join(dataDir(), 'harbor.db')}; restore it from a backup or move it aside to start afresh.`)
  }

  /*
    All of it or none of it. Two of the migration blocks add several columns
    behind one guard; a process that died between the first and the second
    left the guard column present and the rest missing, and every later
    start failed on the first query that named one, with no way back.
  */
  db.transaction(() => {
    migrate()
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  })()
  // Every conversation needs a home, and the general scope is one.
  ensureGeneral()
  repairBrokenChains()
  backfillSearchIndex()
}
