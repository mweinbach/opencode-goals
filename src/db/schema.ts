import { getDb } from './connection.js';

export function initializeSchema(): void {
  const db = getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,
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

  migrateLegacySessionGoals();

  db.run(`CREATE INDEX IF NOT EXISTS idx_thread_goals_status ON thread_goals(status)`);
}

function migrateLegacySessionGoals(): void {
  const db = getDb();
  const legacy = db
    .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_goals'`)
    .get();

  if (!legacy) return;

  db.run(`
    INSERT OR IGNORE INTO thread_goals (
      thread_id, goal_id, objective, status, token_budget,
      tokens_used, time_used_seconds, created_at_ms, updated_at_ms
    )
    SELECT
      session_id, goal_id, objective, status, token_budget,
      tokens_used, time_used_seconds, created_at_ms, updated_at_ms
    FROM session_goals
  `);
}
