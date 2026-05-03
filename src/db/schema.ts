import { getDb } from './connection.js';

export function initializeSchema(): void {
  const db = getDb();

  // Main goals table - one active goal per session (Codex exact)
  db.run(`
    CREATE TABLE IF NOT EXISTS session_goals (
      session_id TEXT PRIMARY KEY NOT NULL,
      directory TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'budget_limited', 'complete')),
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);

  // Archive for historical goals (Option B)
  db.run(`
    CREATE TABLE IF NOT EXISTS goal_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      archived_at_ms INTEGER NOT NULL
    )
  `);

  // Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_goals_directory ON session_goals(directory)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_goals_status ON session_goals(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_archive_session ON goal_archive(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_archive_directory ON goal_archive(directory)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_archive_goal_id ON goal_archive(goal_id)`);
}
