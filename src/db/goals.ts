import { getDb } from './connection.js';
import type {
  ThreadGoal,
  ThreadGoalUpdate,
  ThreadGoalAccountingMode,
  ThreadGoalAccountingOutcome,
} from '../types.js';

function nowMs(): number {
  return Date.now();
}

function generateGoalId(): string {
  return `goal_${crypto.randomUUID()}`;
}

function rowToGoal(row: Record<string, unknown>): ThreadGoal {
  return {
    sessionId: row.session_id as string,
    directory: row.directory as string,
    goalId: row.goal_id as string,
    objective: row.objective as string,
    status: row.status as ThreadGoal['status'],
    tokenBudget: row.token_budget !== null ? (row.token_budget as number) : null,
    tokensUsed: row.tokens_used as number,
    timeUsedSeconds: row.time_used_seconds as number,
    createdAt: row.created_at_ms as number,
    updatedAt: row.updated_at_ms as number,
  };
}

// ─── CRUD Operations ─────────────────────────────────────────────────────────

export function getThreadGoal(sessionId: string): ThreadGoal | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT session_id, directory, goal_id, objective, status, token_budget,
              tokens_used, time_used_seconds, created_at_ms, updated_at_ms
       FROM session_goals WHERE session_id = ?`
    )
    .get(sessionId) as Record<string, unknown> | null;

  return row ? rowToGoal(row) : null;
}

export function replaceThreadGoal(
  sessionId: string,
  directory: string,
  objective: string,
  status: ThreadGoal['status'],
  tokenBudget: number | null
): ThreadGoal {
  const db = getDb();
  const goalId = generateGoalId();
  const now = nowMs();

  // Coerce status: if active with budget <= 0, flip to budget_limited
  let effectiveStatus = status;
  if (status === 'active' && tokenBudget !== null && tokenBudget <= 0) {
    effectiveStatus = 'budget_limited';
  }

  // Archive existing goal if present
  archiveCurrentGoal(sessionId);

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
    [sessionId, directory, goalId, objective, effectiveStatus, tokenBudget, now, now]
  );

  return getThreadGoal(sessionId)!;
}

export function insertThreadGoal(
  sessionId: string,
  directory: string,
  objective: string,
  status: ThreadGoal['status'],
  tokenBudget: number | null
): ThreadGoal | null {
  const db = getDb();

  // Check if goal already exists
  const existing = getThreadGoal(sessionId);
  if (existing) return null;

  return replaceThreadGoal(sessionId, directory, objective, status, tokenBudget);
}

export function updateThreadGoal(
  sessionId: string,
  update: ThreadGoalUpdate
): ThreadGoal | null {
  const db = getDb();
  const now = nowMs();

  const current = getThreadGoal(sessionId);
  if (!current) return null;

  const expectedGoalId = update.expectedGoalId ?? current.goalId;

  // If expected_goal_id doesn't match, it's a stale update (no-op)
  if (update.expectedGoalId && current.goalId !== update.expectedGoalId) {
    return current; // Return current as unchanged
  }

  let newStatus = update.status ?? current.status;
  const newTokenBudget = update.tokenBudget !== undefined ? update.tokenBudget : current.tokenBudget;

  // Budget limit coercion logic
  if (newStatus === 'active' && newTokenBudget !== null && current.tokensUsed >= newTokenBudget) {
    newStatus = 'budget_limited';
  }

  // Pause preserves budget_limited
  if (current.status === 'budget_limited' && newStatus === 'paused') {
    newStatus = 'budget_limited';
  }

  db.run(
    `UPDATE session_goals
     SET status = ?,
         token_budget = ?,
         updated_at_ms = ?
     WHERE session_id = ? AND goal_id = ?`,
    [newStatus, newTokenBudget, now, sessionId, expectedGoalId]
  );

  const updated = getThreadGoal(sessionId);
  return updated;
}

export function pauseActiveThreadGoal(sessionId: string): ThreadGoal | null {
  const db = getDb();
  const now = nowMs();

  const current = getThreadGoal(sessionId);
  if (!current || current.status !== 'active') return null;

  db.run(
    `UPDATE session_goals
     SET status = 'paused', updated_at_ms = ?
     WHERE session_id = ? AND status = 'active'`,
    [now, sessionId]
  );

  return getThreadGoal(sessionId);
}

export function deleteThreadGoal(sessionId: string): boolean {
  const db = getDb();

  // Archive before delete
  archiveCurrentGoal(sessionId);

  const result = db.run('DELETE FROM session_goals WHERE session_id = ?', [sessionId]);
  return result.changes > 0;
}

export function accountThreadGoalUsage(
  sessionId: string,
  timeDeltaSeconds: number,
  tokenDelta: number,
  mode: ThreadGoalAccountingMode,
  expectedGoalId?: string
): ThreadGoalAccountingOutcome {
  const db = getDb();
  const now = nowMs();

  // Clamp deltas
  const clampedTime = Math.max(0, timeDeltaSeconds);
  const clampedTokens = Math.max(0, tokenDelta);

  if (clampedTime === 0 && clampedTokens === 0) {
    const current = getThreadGoal(sessionId);
    return { type: 'unchanged', goal: current };
  }

  // Build status filter based on mode
  const statusFilter = buildStatusFilter(mode);
  const budgetLimitFilter = buildBudgetLimitStatusFilter(mode);

  // Build the dynamic UPDATE query
  const query = `
    UPDATE session_goals
    SET
      time_used_seconds = time_used_seconds + ?,
      tokens_used = tokens_used + ?,
      status = CASE
        WHEN ${budgetLimitFilter}
             AND token_budget IS NOT NULL
             AND tokens_used + ? >= token_budget
          THEN 'budget_limited'
        ELSE status
      END,
      updated_at_ms = ?
    WHERE session_id = ?
      AND ${statusFilter}
      AND (? IS NULL OR goal_id = ?)
    RETURNING *
  `;

  const result = db
    .query(query)
    .get(clampedTime, clampedTokens, clampedTokens, now, sessionId, expectedGoalId ?? null, expectedGoalId ?? null) as Record<string, unknown> | null;

  if (result) {
    return { type: 'updated', goal: rowToGoal(result) };
  }

  // No row updated - goal may have changed status or been replaced
  const current = getThreadGoal(sessionId);
  return { type: 'unchanged', goal: current };
}

// ─── Archive Operations ──────────────────────────────────────────────────────

function archiveCurrentGoal(sessionId: string): void {
  const db = getDb();
  const current = getThreadGoal(sessionId);
  if (!current) return;

  db.run(
    `INSERT INTO goal_archive (session_id, directory, goal_id, objective, status, token_budget,
                               tokens_used, time_used_seconds, created_at_ms, completed_at_ms, archived_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      current.sessionId,
      current.directory,
      current.goalId,
      current.objective,
      current.status,
      current.tokenBudget,
      current.tokensUsed,
      current.timeUsedSeconds,
      current.createdAt,
      current.status === 'complete' ? current.updatedAt : null,
      nowMs(),
    ]
  );
}

export function listGoalsForDirectory(directory: string): Array<{
  sessionId: string;
  goalId: string;
  objective: string;
  status: ThreadGoal['status'];
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt: number;
}> {
  const db = getDb();

  const active = db
    .query(
      `SELECT session_id, goal_id, objective, status, tokens_used, time_used_seconds, updated_at_ms
       FROM session_goals WHERE directory = ? ORDER BY updated_at_ms DESC`
    )
    .all(directory) as Array<Record<string, unknown>>;

  const archived = db
    .query(
      `SELECT session_id, goal_id, objective, status, tokens_used, time_used_seconds, archived_at_ms as updated_at_ms
       FROM goal_archive WHERE directory = ? ORDER BY archived_at_ms DESC`
    )
    .all(directory) as Array<Record<string, unknown>>;

  const combined = [...active, ...archived];
  return combined.map((row) => ({
    sessionId: row.session_id as string,
    goalId: row.goal_id as string,
    objective: row.objective as string,
    status: row.status as ThreadGoal['status'],
    tokensUsed: row.tokens_used as number,
    timeUsedSeconds: row.time_used_seconds as number,
    updatedAt: row.updated_at_ms as number,
  }));
}

export function listArchivedGoalsForSession(sessionId: string): Array<{
  id: number;
  goalId: string;
  objective: string;
  status: ThreadGoal['status'];
  archivedAt: number;
}> {
  const db = getDb();

  const rows = db
    .query(
      `SELECT id, goal_id, objective, status, archived_at_ms
       FROM goal_archive WHERE session_id = ? ORDER BY archived_at_ms DESC`
    )
    .all(sessionId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as number,
    goalId: row.goal_id as string,
    objective: row.objective as string,
    status: row.status as ThreadGoal['status'],
    archivedAt: row.archived_at_ms as number,
  }));
}

export function restoreGoalFromArchive(sessionId: string, archiveId: number): ThreadGoal | null {
  const db = getDb();

  const row = db
    .query('SELECT * FROM goal_archive WHERE id = ?')
    .get(archiveId) as Record<string, unknown> | null;

  if (!row) return null;

  // Archive current goal if exists
  archiveCurrentGoal(sessionId);

  const now = nowMs();
  const goalId = generateGoalId();

  db.run(
    `INSERT INTO session_goals (session_id, directory, goal_id, objective, status, token_budget,
                                tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       goal_id = excluded.goal_id,
       objective = excluded.objective,
       status = 'active',
       token_budget = excluded.token_budget,
       tokens_used = excluded.tokens_used,
       time_used_seconds = excluded.time_used_seconds,
       created_at_ms = excluded.created_at_ms,
       updated_at_ms = excluded.updated_at_ms`,
    [
      sessionId,
      row.directory as string,
      goalId,
      row.objective as string,
      'active',
      row.token_budget as number | null,
      row.tokens_used as number,
      row.time_used_seconds as number,
      row.created_at_ms as number,
      now,
    ]
  );

  return getThreadGoal(sessionId);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildStatusFilter(mode: ThreadGoalAccountingMode): string {
  switch (mode) {
    case 'active_status_only':
      return "status = 'active'";
    case 'active_only':
      return "status IN ('active', 'budget_limited')";
    case 'active_or_complete':
      return "status IN ('active', 'budget_limited', 'complete')";
    case 'active_or_stopped':
      return "status IN ('active', 'paused', 'budget_limited')";
    default:
      return "status = 'active'";
  }
}

function buildBudgetLimitStatusFilter(mode: ThreadGoalAccountingMode): string {
  switch (mode) {
    case 'active_status_only':
    case 'active_only':
    case 'active_or_complete':
      return "status = 'active'";
    case 'active_or_stopped':
      return "status IN ('active', 'paused', 'budget_limited')";
    default:
      return "status = 'active'";
  }
}
