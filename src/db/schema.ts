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
      input_tokens_used INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens_used INTEGER NOT NULL DEFAULT 0,
      output_tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);

  addMissingThreadGoalColumns();
  migrateLegacySessionGoals();

  db.run(`CREATE INDEX IF NOT EXISTS idx_thread_goals_status ON thread_goals(status)`);
}

function addMissingThreadGoalColumns(): void {
  const db = getDb();
  const columns = new Set(
    (
      db.query(`PRAGMA table_info(thread_goals)`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name)
  );

  const additions: Array<[string, string]> = [
    ['input_tokens_used', 'INTEGER NOT NULL DEFAULT 0'],
    ['cached_input_tokens_used', 'INTEGER NOT NULL DEFAULT 0'],
    ['output_tokens_used', 'INTEGER NOT NULL DEFAULT 0'],
  ];

  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.run(`ALTER TABLE thread_goals ADD COLUMN ${name} ${definition}`);
    }
  }

  db.run(`
    UPDATE thread_goals
    SET input_tokens_used = tokens_used
    WHERE tokens_used > 0
      AND input_tokens_used = 0
      AND cached_input_tokens_used = 0
      AND output_tokens_used = 0
  `);
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
      tokens_used, input_tokens_used, cached_input_tokens_used, output_tokens_used,
      time_used_seconds, created_at_ms, updated_at_ms
    )
    SELECT
      session_id, goal_id, objective, status, token_budget,
      tokens_used, tokens_used, 0, 0,
      time_used_seconds, created_at_ms, updated_at_ms
    FROM session_goals
  `);
}
