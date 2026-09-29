import { db } from './connection'

/* --------------------------------------------------------------- settings */
export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export function listFavorites(): string[] {
  const rows = db.prepare('SELECT model_id FROM favorite_models').all() as { model_id: string }[]
  return rows.map((r) => r.model_id)
}

export function toggleFavorite(modelId: string): string[] {
  const existing = db.prepare('SELECT 1 FROM favorite_models WHERE model_id = ?').get(modelId)
  if (existing) db.prepare('DELETE FROM favorite_models WHERE model_id = ?').run(modelId)
  else db.prepare('INSERT INTO favorite_models (model_id) VALUES (?)').run(modelId)
  return listFavorites()
}
