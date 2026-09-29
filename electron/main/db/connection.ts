import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { DIMENSIONS } from '../embed'

/**
 * The one connection, opened by index.ts at startup and read by every
 * table module through the live binding below. All Harbor state lives
 * outside the source tree, in Application Support; see "Process split" in the README.
 */
export let db: Database.Database
let vectorReady = false

export const hasVectorSearch = (): boolean => vectorReady

export function dataDir(): string {
  const dir = join(app.getPath('userData'))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Opens the file with the pragmas every session wants, and the vector extension when it loads. */
export function connect(): void {
  db = new Database(join(dataDir(), 'harbor.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Vector search is optional: without the extension, knowledge falls back to
  // BM25 alone rather than failing.
  try {
    sqliteVec.load(db)
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(embedding float[${DIMENSIONS}])`
    )
    vectorReady = true
  } catch {
    vectorReady = false
  }
}

export const now = (): number => Date.now()
export const id = (): string => crypto.randomUUID()


/** Runs several writes as one; a throw inside rolls all of them back. */
export function transaction<T>(fn: () => T): T {
  return db.transaction(fn)()
}
