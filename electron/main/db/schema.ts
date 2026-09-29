import { db } from './connection'

/** The tables, as CREATE IF NOT EXISTS, run at every start before the migrations. */
export function createTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      root_path     TEXT,
      system_prompt TEXT NOT NULL DEFAULT '',
      default_model TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title      TEXT NOT NULL DEFAULT 'Untitled',
      model      TEXT,
      pinned     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id, updated_at DESC);

    -- parent_id is unused in Phase 1 but present from the start, so branching
    -- in Phase 2 does not need a migration.
    CREATE TABLE IF NOT EXISTS messages (
      id                TEXT PRIMARY KEY,
      conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      parent_id         TEXT,
      role              TEXT NOT NULL,
      content           TEXT NOT NULL,
      model             TEXT,
      reasoning         TEXT,
      error             TEXT,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      cost              REAL,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS favorite_models (
      model_id TEXT PRIMARY KEY
    );

    -- One row per file write the agent made, with content-addressed snapshots
    -- either side of it. This is the undo story for auto-applied edits.
    CREATE TABLE IF NOT EXISTS checkpoints (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      path            TEXT NOT NULL,
      before_hash     TEXT,
      after_hash      TEXT,
      created         INTEGER NOT NULL DEFAULT 0,
      undone          INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cp_run ON checkpoints(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_cp_conv ON checkpoints(conversation_id, created_at DESC);

    -- The whole tree either side of an agent turn, as commits in Harbor's
    -- shadow repository for the project; the way back from what the shell did.
    CREATE TABLE IF NOT EXISTS snapshots (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      project_id      TEXT NOT NULL,
      kind            TEXT NOT NULL,
      sha             TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snap_conv ON snapshots(conversation_id, created_at DESC);

    -- Prefix patterns the agent may run in this project without asking again.
    CREATE TABLE IF NOT EXISTS command_allowlist (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pattern    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_allow_project ON command_allowlist(project_id);

    -- Knowledge: a curated read-only corpus, separate from the workspace.
    CREATE TABLE IF NOT EXISTS knowledge_sources (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      indexed_at INTEGER
    );

    -- INTEGER PRIMARY KEY so the rowid lines up with the vector table.
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id         INTEGER PRIMARY KEY,
      source_id  TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      rel_path   TEXT NOT NULL,
      heading    TEXT NOT NULL DEFAULT '',
      content    TEXT NOT NULL,
      file_hash  TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_source ON knowledge_chunks(source_id, rel_path);
    CREATE INDEX IF NOT EXISTS idx_chunk_project ON knowledge_chunks(project_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts
      USING fts5(content, heading, content='knowledge_chunks', content_rowid='id');

    -- Memory: what was learned by doing, with provenance.
    CREATE TABLE IF NOT EXISTS memories (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      text            TEXT NOT NULL,
      source_conv_id  TEXT,
      source_msg_id   TEXT,
      extracted_by    TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      pinned          INTEGER NOT NULL DEFAULT 0,
      last_used_at    INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project_id, created_at DESC);

    -- Saved prompts. Not one of the context channels: a prompt is text you
    -- insert for yourself, not context the agent consumes.
    CREATE TABLE IF NOT EXISTS prompts (
      id         TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Claude's judgement of a run, for the person watching it: a verdict,
    -- a summary, and suggestions the person sends on or dismisses.
    CREATE TABLE IF NOT EXISTS reviews (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      verdict         TEXT NOT NULL,
      summary         TEXT NOT NULL,
      suggestions     TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_conv ON reviews(conversation_id, created_at DESC);

    -- Full-text index over message bodies, kept in step by triggers so every
    -- write path stays covered rather than only the ones we remembered.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(content, content='messages', content_rowid='rowid');

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `)
}



/**
 * Bumped when the shape below changes. The column guards are what make a
 * migration safe to re-run; the number is what says which shape a file has
 * without reading every table.
 */
export const SCHEMA_VERSION = 12

/**
 * Additive migrations only — each one checks for its own column first, so
 * running against an existing database is safe.
 */
export function migrate(): void {
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'leaf_id')) {
    // The active leaf identifies which branch of the message tree is on screen.
    db.exec('ALTER TABLE conversations ADD COLUMN leaf_id TEXT')
  }

  const projCols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
  if (!projCols.some((c) => c.name === 'archived')) {
    // Put away: out of the sidebar's list and the plan picker, kept whole and brought back from the Archived section.
    db.exec('ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  }
  if (!projCols.some((c) => c.name === 'position')) {
    // Where the person put the project in the sidebar; unset sorts after the rest, oldest first.
    db.exec('ALTER TABLE projects ADD COLUMN position INTEGER')
  }
  if (!projCols.some((c) => c.name === 'unlocked')) {
    // JSON array of deny-list categories this project has opened up.
    db.exec("ALTER TABLE projects ADD COLUMN unlocked TEXT NOT NULL DEFAULT '[]'")
  }
  if (!projCols.some((c) => c.name === 'system_as_user')) {
    // A few models want everything in the user turn rather than a system role.
    db.exec('ALTER TABLE projects ADD COLUMN system_as_user INTEGER NOT NULL DEFAULT 0')
  }
  if (!projCols.some((c) => c.name === 'params')) {
    db.exec("ALTER TABLE projects ADD COLUMN params TEXT NOT NULL DEFAULT '{}'")
  }
  if (!projCols.some((c) => c.name === 'hooks')) {
    // JSON array of Hook; commands run after the agent writes a file.
    db.exec("ALTER TABLE projects ADD COLUMN hooks TEXT NOT NULL DEFAULT '[]'")
  }
  if (!projCols.some((c) => c.name === 'write_globs')) {
    // JSON array of globs the agent may write under; empty means anywhere.
    db.exec("ALTER TABLE projects ADD COLUMN write_globs TEXT NOT NULL DEFAULT '[]'")
  }
  if (!projCols.some((c) => c.name === 'context_files')) {
    // JSON array of paths, relative to the root, read into every prompt.
    db.exec("ALTER TABLE projects ADD COLUMN context_files TEXT NOT NULL DEFAULT '[]'")
  }
  if (!projCols.some((c) => c.name === 'tiers')) {
    db.exec("ALTER TABLE projects ADD COLUMN tiers TEXT NOT NULL DEFAULT ''")
  }
  if (!projCols.some((c) => c.name === 'auto_approve')) {
    db.exec('ALTER TABLE projects ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0')
  }

  const convCols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]
  if (!convCols.some((c) => c.name === 'archived')) {
    // Archived conversations stay on disk and stay searchable; they just leave
    // the sidebar.
    db.exec('ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  }
  if (!convCols.some((c) => c.name === 'budget')) {
    db.exec('ALTER TABLE conversations ADD COLUMN budget REAL NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE conversations ADD COLUMN approved INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE conversations ADD COLUMN run_id TEXT')
  }
  if (!convCols.some((c) => c.name === 'run_branch')) {
    db.exec('ALTER TABLE conversations ADD COLUMN run_branch TEXT')
    db.exec('ALTER TABLE conversations ADD COLUMN run_base TEXT')
  }
  if (!convCols.some((c) => c.name === 'rehearsal')) {
    db.exec('ALTER TABLE conversations ADD COLUMN rehearsal INTEGER NOT NULL DEFAULT 0')
  }
  if (!convCols.some((c) => c.name === 'write_globs')) {
    db.exec("ALTER TABLE conversations ADD COLUMN write_globs TEXT NOT NULL DEFAULT '[]'")
  }
  if (!convCols.some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE conversations ADD COLUMN role TEXT NOT NULL DEFAULT 'chat'")
  }
  if (!convCols.some((c) => c.name === 'run_dir')) {
    // The folder a run's files live in, shared by its interview and its director.
    db.exec('ALTER TABLE conversations ADD COLUMN run_dir TEXT')
  }
  if (!convCols.some((c) => c.name === 'goal')) {
    // A goal the conversation works toward on its own, and where that stands.
    db.exec('ALTER TABLE conversations ADD COLUMN goal TEXT')
    db.exec('ALTER TABLE conversations ADD COLUMN goal_state TEXT')
    db.exec('ALTER TABLE conversations ADD COLUMN goal_turns INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE conversations ADD COLUMN goal_budget REAL NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE conversations ADD COLUMN goal_since INTEGER')
    db.exec('ALTER TABLE conversations ADD COLUMN goal_idle INTEGER NOT NULL DEFAULT 0')
  }
  if (!convCols.some((c) => c.name === 'scratch')) {
    // A throwaway conversation: not listed, not searched, deleted when left.
    db.exec('ALTER TABLE conversations ADD COLUMN scratch INTEGER NOT NULL DEFAULT 0')
  }
  if (!convCols.some((c) => c.name === 'params')) {
    // Empty means inherit whatever the project sets.
    db.exec("ALTER TABLE conversations ADD COLUMN params TEXT NOT NULL DEFAULT '{}'")
  }

  const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
  const has = (n: string): boolean => msgCols.some((c) => c.name === n)
  // Prompt caching and reasoning both change what a message actually cost.
  if (!has('cached_tokens')) db.exec('ALTER TABLE messages ADD COLUMN cached_tokens INTEGER')
  if (!has('reasoning_tokens')) db.exec('ALTER TABLE messages ADD COLUMN reasoning_tokens INTEGER')
  // Agent turns store the calls they made and the results they got back, so a
  // reloaded conversation can be replayed to the model unchanged.
  if (!has('tool_calls')) db.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT')
  if (!has('tool_call_id')) db.exec('ALTER TABLE messages ADD COLUMN tool_call_id TEXT')
  // Pages the model read, when the turn had web search on.
  if (!has('citations')) db.exec('ALTER TABLE messages ADD COLUMN citations TEXT')
  // How a fanned-out reply was asked, when one model was asked more than once.
  if (!has('label')) db.exec('ALTER TABLE messages ADD COLUMN label TEXT')
  // Files attached to a user message; the bytes live in the blob store.
  if (!has('attachments')) db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT')
  // The root of a compacted branch points at the leaf it summarised.
  if (!has('summary_of')) db.exec('ALTER TABLE messages ADD COLUMN summary_of TEXT')
  // The provider's reasoning blocks, verbatim, for the next step of a tool loop.
  if (!has('reasoning_details')) db.exec('ALTER TABLE messages ADD COLUMN reasoning_details TEXT')
  // Cleared from the context to make room; the row keeps its content.
  if (!has('trimmed')) db.exec('ALTER TABLE messages ADD COLUMN trimmed INTEGER NOT NULL DEFAULT 0')
  // What the cache was written with, and what the prompt's cacheable prefix looked like.
  if (!has('cache_write_tokens')) db.exec('ALTER TABLE messages ADD COLUMN cache_write_tokens INTEGER')
  if (!has('prefix_hash')) db.exec('ALTER TABLE messages ADD COLUMN prefix_hash TEXT')

  const memCols = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  if (!memCols.some((c) => c.name === 'origin')) {
    // Who a memory came from, whether it has been reviewed, and whether a later fact put it out of date.
    db.exec("ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'model'")
    db.exec('ALTER TABLE memories ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 1')
    db.exec('ALTER TABLE memories ADD COLUMN invalidated_at INTEGER')
    db.exec('ALTER TABLE memories ADD COLUMN invalidated_by TEXT')
  }

  const cpCols = db.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[]
  if (!cpCols.some((c) => c.name === 'web_used')) {
    // Marks edits made during a run that read untrusted web content.
    db.exec('ALTER TABLE checkpoints ADD COLUMN web_used INTEGER NOT NULL DEFAULT 0')
  }

  // After the columns they cover exist. Each one backs a query that scanned.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_conv_run ON conversations(run_id);
    CREATE INDEX IF NOT EXISTS idx_cp_path ON checkpoints(path, created_at DESC);
  `)

  /*
    Phase 1 wrote every message with a null parent, which reads as a set of
    orphan roots once conversations become trees. Chain each of those in
    creation order and point the conversation at the last one.
  */
  const flat = db
    .prepare(
      `SELECT id FROM conversations
       WHERE leaf_id IS NULL
         AND (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) > 0`
    )
    .all() as { id: string }[]

  const link = db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?')
  const point = db.prepare('UPDATE conversations SET leaf_id = ? WHERE id = ?')

  for (const conv of flat) {
    const rows = db
      .prepare('SELECT id, parent_id FROM messages WHERE conversation_id = ? ORDER BY created_at')
      .all(conv.id) as { id: string; parent_id: string | null }[]
    if (rows.some((r) => r.parent_id !== null)) continue
    rows.forEach((row, i) => {
      if (i > 0) link.run(rows[i - 1].id, row.id)
    })
    point.run(rows[rows.length - 1].id, conv.id)
  }
}
