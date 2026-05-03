#!/usr/bin/env bun
/**
 * opencode-goals CLI
 * Direct CLI interface for goal management without model involvement
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const DB_PATH = `${homedir()}/.config/opencode/goals.db`;

function getDb(): Database {
  const dir = dirname(DB_PATH);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory may already exist
  }
  const db = new Database(DB_PATH);
  db.run('PRAGMA journal_mode = WAL;');
  return db;
}

function nowMs(): number {
  return Date.now();
}

function generateGoalId(): string {
  return `goal_${crypto.randomUUID()}`;
}

function getCurrentDirectory(): string {
  return resolve(process.cwd());
}

function formatGoalRow(row: Record<string, unknown>): string {
  const status = row.status as string;
  const objective = row.objective as string;
  const tokensUsed = row.tokens_used as number;
  const tokenBudget = row.token_budget as number | null;
  const timeUsed = row.time_used_seconds as number;

  const statusIcon =
    status === 'active' ? '●' : status === 'paused' ? '⏸' : status === 'complete' ? '✓' : '⊘';
  const budgetStr = tokenBudget !== null ? `${tokensUsed} / ${tokenBudget} tokens` : `${tokensUsed} tokens`;

  return `${statusIcon} ${objective}\n   ${budgetStr} · ${timeUsed}s · ${status}`;
}

// ─── Commands ────────────────────────────────────────────────────────────────

function cmdStatus(db: Database, directory: string): void {
  const row = db
    .query('SELECT * FROM session_goals WHERE directory = ?')
    .get(directory) as Record<string, unknown> | null;

  if (!row) {
    console.log('No active goal for this project.');
    console.log('\nUsage:');
    console.log('  goal create "objective" [--budget N]');
    console.log('  goal list');
    return;
  }

  console.log(formatGoalRow(row));
}

function cmdCreate(
  db: Database,
  directory: string,
  objective: string,
  budget?: number
): void {
  if (!objective || objective.trim().length === 0) {
    console.error('Error: objective is required');
    process.exit(1);
  }

  if (objective.length > 4000) {
    console.error('Error: objective must be at most 4000 characters');
    process.exit(1);
  }

  if (budget !== undefined && budget <= 0) {
    console.error('Error: budget must be a positive integer');
    process.exit(1);
  }

  const now = nowMs();
  const goalId = generateGoalId();

  // Archive existing goal for this directory
  const existing = db
    .query('SELECT * FROM session_goals WHERE directory = ?')
    .get(directory) as Record<string, unknown> | null;

  if (existing) {
    db.run(
      `INSERT INTO goal_archive (session_id, directory, goal_id, objective, status, token_budget,
                                 tokens_used, time_used_seconds, created_at_ms, completed_at_ms, archived_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        existing.session_id,
        existing.directory,
        existing.goal_id,
        existing.objective,
        existing.status,
        existing.token_budget,
        existing.tokens_used,
        existing.time_used_seconds,
        existing.created_at_ms,
        existing.status === 'complete' ? existing.updated_at_ms : null,
        now,
      ]
    );
  }

  // Determine status
  let status = 'active';
  if (budget !== undefined && budget <= 0) {
    status = 'budget_limited';
  }

  // Insert or replace
  db.run(
    `INSERT INTO session_goals (session_id, directory, goal_id, objective, status, token_budget,
                                tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       goal_id = excluded.goal_id,
       objective = excluded.objective,
       status = excluded.status,
       token_budget = excluded.token_budget,
       tokens_used = 0,
       time_used_seconds = 0,
       created_at_ms = excluded.created_at_ms,
       updated_at_ms = excluded.updated_at_ms`,
    [goalId, directory, goalId, objective.trim(), status, budget ?? null, now, now]
  );

  console.log(`Created goal: ${objective.trim()}`);
  if (budget) {
    console.log(`Budget: ${budget} tokens`);
  }
}

function cmdList(db: Database, directory: string): void {
  console.log('Active Goals:\n');

  const active = db
    .query('SELECT * FROM session_goals WHERE directory = ? ORDER BY updated_at_ms DESC')
    .all(directory) as Array<Record<string, unknown>>;

  if (active.length === 0) {
    console.log('  (none)');
  } else {
    for (const row of active) {
      console.log(formatGoalRow(row));
      console.log();
    }
  }

  console.log('Archived Goals:\n');

  const archived = db
    .query(
      'SELECT * FROM goal_archive WHERE directory = ? ORDER BY archived_at_ms DESC LIMIT 20'
    )
    .all(directory) as Array<Record<string, unknown>>;

  if (archived.length === 0) {
    console.log('  (none)');
  } else {
    for (const row of archived) {
      const status = row.status as string;
      const icon = status === 'complete' ? '✓' : '⏸';
      console.log(
        `${icon} ${row.objective as string} (${new Date(row.archived_at_ms as number).toLocaleDateString()})`
      );
    }
  }
}

function cmdPause(db: Database, directory: string): void {
  const result = db.run(
    "UPDATE session_goals SET status = 'paused', updated_at_ms = ? WHERE directory = ? AND status = 'active'",
    [nowMs(), directory]
  );

  if (result.changes === 0) {
    console.log('No active goal to pause.');
  } else {
    console.log('Goal paused.');
  }
}

function cmdResume(db: Database, directory: string): void {
  const result = db.run(
    "UPDATE session_goals SET status = 'active', updated_at_ms = ? WHERE directory = ? AND status = 'paused'",
    [nowMs(), directory]
  );

  if (result.changes === 0) {
    console.log('No paused goal to resume.');
  } else {
    console.log('Goal resumed.');
  }
}

function cmdClear(db: Database, directory: string): void {
  const existing = db
    .query('SELECT * FROM session_goals WHERE directory = ?')
    .get(directory) as Record<string, unknown> | null;

  if (existing) {
    const now = nowMs();
    db.run(
      `INSERT INTO goal_archive (session_id, directory, goal_id, objective, status, token_budget,
                                 tokens_used, time_used_seconds, created_at_ms, completed_at_ms, archived_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        existing.session_id,
        existing.directory,
        existing.goal_id,
        existing.objective,
        existing.status,
        existing.token_budget,
        existing.tokens_used,
        existing.time_used_seconds,
        existing.created_at_ms,
        now,
        now,
      ]
    );
  }

  const result = db.run('DELETE FROM session_goals WHERE directory = ?', [directory]);

  if (result.changes === 0) {
    console.log('No goal to clear.');
  } else {
    console.log('Goal cleared.');
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log('opencode-goals CLI');
  console.log('');
  console.log('Commands:');
  console.log('  goal status                    Show current goal');
  console.log('  goal create <objective>        Create a new goal');
  console.log('  goal create <objective> --budget <N>  Create with token budget');
  console.log('  goal list                      List active and archived goals');
  console.log('  goal pause                     Pause the active goal');
  console.log('  goal resume                    Resume a paused goal');
  console.log('  goal clear                     Clear the current goal');
  console.log('');
  console.log('Examples:');
  console.log('  goal create "Refactor auth module"');
  console.log('  goal create "Implement OAuth" --budget 10000');
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }

  const db = getDb();
  const directory = getCurrentDirectory();

  // Ensure tables exist
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

  try {
    switch (command) {
      case 'status':
        cmdStatus(db, directory);
        break;
      case 'create': {
        const objective = args[1];
        let budget: number | undefined;
        const budgetIndex = args.indexOf('--budget');
        if (budgetIndex !== -1 && args[budgetIndex + 1]) {
          budget = parseInt(args[budgetIndex + 1], 10);
          if (isNaN(budget)) {
            console.error('Error: budget must be a number');
            process.exit(1);
          }
        }
        cmdCreate(db, directory, objective, budget);
        break;
      }
      case 'list':
        cmdList(db, directory);
        break;
      case 'pause':
        cmdPause(db, directory);
        break;
      case 'resume':
        cmdResume(db, directory);
        break;
      case 'clear':
        cmdClear(db, directory);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
