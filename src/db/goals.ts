import { getDb } from './connection.js';
import type {
  ThreadGoal,
  ThreadGoalAccountingMode,
  ThreadGoalAccountingOutcome,
  ThreadGoalUpdate,
} from '../types.js';

function nowMs(): number {
  return Date.now();
}

function generateGoalId(): string {
  return crypto.randomUUID();
}

function rowToGoal(row: Record<string, unknown>): ThreadGoal {
  return {
    threadId: row.thread_id as string,
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

export function getThreadGoal(threadId: string): ThreadGoal | null {
  const row = getDb()
    .query(
      `SELECT thread_id, goal_id, objective, status, token_budget,
              tokens_used, time_used_seconds, created_at_ms, updated_at_ms
       FROM thread_goals
       WHERE thread_id = ?`
    )
    .get(threadId) as Record<string, unknown> | null;

  return row ? rowToGoal(row) : null;
}

export function replaceThreadGoal(
  threadId: string,
  objective: string,
  status: ThreadGoal['status'],
  tokenBudget: number | null
): ThreadGoal {
  const goalId = generateGoalId();
  const now = nowMs();
  const effectiveStatus = coerceStatus(status, tokenBudget, 0);

  getDb().run(
    `INSERT INTO thread_goals (
       thread_id, goal_id, objective, status, token_budget,
       tokens_used, time_used_seconds, created_at_ms, updated_at_ms
     )
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       goal_id = excluded.goal_id,
       objective = excluded.objective,
       status = excluded.status,
       token_budget = excluded.token_budget,
       tokens_used = 0,
       time_used_seconds = 0,
       created_at_ms = excluded.created_at_ms,
       updated_at_ms = excluded.updated_at_ms`,
    [threadId, goalId, objective, effectiveStatus, tokenBudget, now, now]
  );

  return getThreadGoal(threadId)!;
}

export function insertThreadGoal(
  threadId: string,
  objective: string,
  status: ThreadGoal['status'],
  tokenBudget: number | null
): ThreadGoal | null {
  const goalId = generateGoalId();
  const now = nowMs();
  const effectiveStatus = coerceStatus(status, tokenBudget, 0);

  const result = getDb().run(
    `INSERT INTO thread_goals (
       thread_id, goal_id, objective, status, token_budget,
       tokens_used, time_used_seconds, created_at_ms, updated_at_ms
     )
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(thread_id) DO NOTHING`,
    [threadId, goalId, objective, effectiveStatus, tokenBudget, now, now]
  );

  if (result.changes === 0) return null;
  return getThreadGoal(threadId);
}

export function updateThreadGoal(threadId: string, update: ThreadGoalUpdate): ThreadGoal | null {
  const current = getThreadGoal(threadId);
  if (!current) return null;
  if (update.expectedGoalId && current.goalId !== update.expectedGoalId) return current;

  const tokenBudget = update.tokenBudget !== undefined ? update.tokenBudget : current.tokenBudget;
  let status = update.status ?? current.status;

  if (current.status === 'budget_limited' && status === 'paused') {
    status = 'budget_limited';
  }
  status = coerceStatus(status, tokenBudget, current.tokensUsed);

  const row = getDb()
    .query(
      `UPDATE thread_goals
       SET status = ?,
           token_budget = ?,
           updated_at_ms = ?
       WHERE thread_id = ?
         AND goal_id = ?
       RETURNING thread_id, goal_id, objective, status, token_budget,
                 tokens_used, time_used_seconds, created_at_ms, updated_at_ms`
    )
    .get(status, tokenBudget, nowMs(), threadId, current.goalId) as Record<string, unknown> | null;

  return row ? rowToGoal(row) : getThreadGoal(threadId);
}

export function completeThreadGoal(threadId: string, expectedGoalId?: string): ThreadGoal | null {
  const updated = updateThreadGoal(threadId, {
    status: 'complete',
    expectedGoalId,
  });

  if (!updated || updated.status !== 'complete') return updated;

  getDb().run('DELETE FROM thread_goals WHERE thread_id = ? AND goal_id = ?', [
    threadId,
    updated.goalId,
  ]);

  return updated;
}

export function pauseActiveThreadGoal(threadId: string): ThreadGoal | null {
  const row = getDb()
    .query(
      `UPDATE thread_goals
       SET status = 'paused', updated_at_ms = ?
       WHERE thread_id = ?
         AND status = 'active'
       RETURNING thread_id, goal_id, objective, status, token_budget,
                 tokens_used, time_used_seconds, created_at_ms, updated_at_ms`
    )
    .get(nowMs(), threadId) as Record<string, unknown> | null;

  return row ? rowToGoal(row) : null;
}

export function deleteThreadGoal(threadId: string): boolean {
  const result = getDb().run('DELETE FROM thread_goals WHERE thread_id = ?', [threadId]);
  return result.changes > 0;
}

export function accountThreadGoalUsage(
  threadId: string,
  timeDeltaSeconds: number,
  tokenDelta: number,
  mode: ThreadGoalAccountingMode,
  expectedGoalId?: string
): ThreadGoalAccountingOutcome {
  const clampedTime = Math.max(0, Math.floor(timeDeltaSeconds));
  const clampedTokens = Math.max(0, Math.floor(tokenDelta));

  if (clampedTime === 0 && clampedTokens === 0) {
    return { type: 'unchanged', goal: getThreadGoal(threadId) };
  }

  const row = getDb()
    .query(
      `UPDATE thread_goals
       SET
         time_used_seconds = time_used_seconds + ?,
         tokens_used = tokens_used + ?,
         status = CASE
           WHEN status = 'active'
                AND token_budget IS NOT NULL
                AND tokens_used + ? >= token_budget
             THEN 'budget_limited'
           ELSE status
         END,
         updated_at_ms = ?
       WHERE thread_id = ?
         AND ${buildStatusFilter(mode)}
         AND (? IS NULL OR goal_id = ?)
       RETURNING thread_id, goal_id, objective, status, token_budget,
                 tokens_used, time_used_seconds, created_at_ms, updated_at_ms`
    )
    .get(
      clampedTime,
      clampedTokens,
      clampedTokens,
      nowMs(),
      threadId,
      expectedGoalId ?? null,
      expectedGoalId ?? null
    ) as Record<string, unknown> | null;

  if (row) return { type: 'updated', goal: rowToGoal(row) };
  return { type: 'unchanged', goal: getThreadGoal(threadId) };
}

function coerceStatus(
  status: ThreadGoal['status'],
  tokenBudget: number | null,
  tokensUsed: number
): ThreadGoal['status'] {
  if (status === 'active' && tokenBudget !== null && tokensUsed >= tokenBudget) {
    return 'budget_limited';
  }
  return status;
}

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
