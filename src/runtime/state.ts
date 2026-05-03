import type {
  GoalAccountingSnapshot,
  TokenUsage,
  ThreadGoal,
  ThreadGoalAccountingMode,
} from '../types.js';
import {
  getThreadGoal,
  accountThreadGoalUsage,
  updateThreadGoal,
} from '../db/goals.js';
import {
  createFreshAccountingSnapshot,
  markTurnStarted,
  accountTurnProgress,
  updateSnapshotAfterAccounting,
  clearTurnSnapshot,
  resetWallClockBaseline,
  shouldClearActiveGoal,
  computeWallClockDelta,
} from './accounting.js';
import { buildContinuationPrompt, buildBudgetLimitPrompt } from '../prompts/builders.js';

export interface GoalRuntimeState {
  accounting: GoalAccountingSnapshot;
  budgetLimitReportedGoalId: string | null;
  continuationTurnId: string | null;
  continuationSuppressed: boolean;
  // Track tool calls in current turn for suppression logic
  toolsExecutedThisTurn: number;
  isContinuationTurn: boolean;
}

export function createGoalRuntimeState(): GoalRuntimeState {
  return {
    accounting: createFreshAccountingSnapshot(),
    budgetLimitReportedGoalId: null,
    continuationTurnId: null,
    continuationSuppressed: false,
    toolsExecutedThisTurn: 0,
    isContinuationTurn: false,
  };
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

export async function handleTurnStarted(
  state: GoalRuntimeState,
  sessionId: string,
  turnId: string,
  tokenUsage: TokenUsage
): Promise<void> {
  const goal = getThreadGoal(sessionId);

  state.continuationTurnId = null;
  state.toolsExecutedThisTurn = 0;
  // isContinuationTurn is set by maybeContinueGoal when it injects the prompt

  if (goal && (goal.status === 'active' || goal.status === 'budget_limited')) {
    markTurnStarted(state.accounting, turnId, tokenUsage, goal.goalId);
  } else {
    markTurnStarted(state.accounting, turnId, tokenUsage, null);
    state.accounting.wallClock.activeGoalId = null;
  }
}

export function recordToolExecution(state: GoalRuntimeState): void {
  state.toolsExecutedThisTurn += 1;
}

export async function accountGoalProgress(
  state: GoalRuntimeState,
  sessionId: string,
  currentTokenUsage: TokenUsage,
  budgetLimitSteering: 'allowed' | 'suppressed'
): Promise<boolean> {
  const goal = getThreadGoal(sessionId);
  if (!goal || !state.accounting.turn || !state.accounting.turn.activeGoalId) {
    return false;
  }

  const { tokenDelta, timeDeltaSeconds, expectedGoalId } = accountTurnProgress(
    state.accounting,
    currentTokenUsage
  );

  if (tokenDelta === 0 && timeDeltaSeconds === 0) {
    return false;
  }

  const outcome = accountThreadGoalUsage(
    sessionId,
    timeDeltaSeconds,
    tokenDelta,
    'active_only',
    expectedGoalId ?? undefined
  );

  if (outcome.type === 'unchanged') {
    return false;
  }

  const updatedGoal = outcome.goal;
  const clearActive = shouldClearActiveGoal(updatedGoal.status);

  updateSnapshotAfterAccounting(
    state.accounting,
    currentTokenUsage,
    timeDeltaSeconds,
    clearActive
  );

  // Budget limit steering
  const shouldSteerBudgetLimit =
    budgetLimitSteering === 'allowed' &&
    updatedGoal.status === 'budget_limited' &&
    state.budgetLimitReportedGoalId !== updatedGoal.goalId;

  if (updatedGoal.status !== 'budget_limited') {
    state.budgetLimitReportedGoalId = null;
  }

  return shouldSteerBudgetLimit;
}

export async function handleBudgetLimitSteering(
  state: GoalRuntimeState,
  client: any,
  sessionId: string
): Promise<void> {
  const goal = getThreadGoal(sessionId);
  if (!goal || goal.status !== 'budget_limited') return;
  if (state.budgetLimitReportedGoalId === goal.goalId) return;

  const prompt = buildBudgetLimitPrompt(goal);

  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: prompt }],
      },
    });
    state.budgetLimitReportedGoalId = goal.goalId;
  } catch {
    // Silently fail injection
  }
}

export async function handleTurnFinished(
  state: GoalRuntimeState,
  sessionId: string,
  currentTokenUsage: TokenUsage,
  turnCompleted: boolean
): Promise<void> {
  if (turnCompleted) {
    const shouldSteer = await accountGoalProgress(
      state,
      sessionId,
      currentTokenUsage,
      'suppressed'
    );
    if (shouldSteer) {
      await handleBudgetLimitSteering(state, { session: { prompt: async () => ({}) } } as any, sessionId);
    }
  }

  state.continuationTurnId = null;
  clearTurnSnapshot(state.accounting);
}

export async function pauseGoalForInterrupt(
  state: GoalRuntimeState,
  sessionId: string
): Promise<ThreadGoal | null> {
  // Flush wall-clock time first
  const goal = getThreadGoal(sessionId);
  if (!goal || goal.status !== 'active') return null;

  const timeDelta = computeWallClockDelta(state.accounting.wallClock.lastAccountedAt);
  if (timeDelta > 0) {
    accountThreadGoalUsage(sessionId, timeDelta, 0, 'active_status_only', goal.goalId);
  }

  const { pauseActiveThreadGoal } = await import('../db/goals.js');
  const paused = pauseActiveThreadGoal(sessionId);

  if (paused) {
    state.budgetLimitReportedGoalId = null;
    state.accounting.wallClock.activeGoalId = null;
  }

  return paused;
}

export async function activatePausedGoalAfterResume(
  state: GoalRuntimeState,
  sessionId: string,
  currentTokenUsage: TokenUsage
): Promise<boolean> {
  const goal = getThreadGoal(sessionId);
  if (!goal) {
    resetRuntimeState(state);
    return false;
  }

  if (goal.status !== 'paused') {
    if (goal.status === 'active') {
      state.accounting.wallClock.activeGoalId = goal.goalId;
      resetWallClockBaseline(state.accounting);
    } else {
      state.accounting.wallClock.activeGoalId = null;
    }
    return false;
  }

  // Try to reactivate
  const updated = updateThreadGoal(sessionId, {
    status: 'active',
    expectedGoalId: goal.goalId,
  });

  if (!updated || updated.status !== 'active') {
    resetRuntimeState(state);
    return false;
  }

  state.budgetLimitReportedGoalId = null;
  state.accounting.wallClock.activeGoalId = updated.goalId;
  resetWallClockBaseline(state.accounting);

  if (state.accounting.turn) {
    state.accounting.turn.activeGoalId = updated.goalId;
  }

  return true;
}

export async function maybeContinueGoal(
  state: GoalRuntimeState,
  client: any,
  sessionId: string
): Promise<boolean> {
  if (state.continuationSuppressed) return false;

  const candidate = await getContinuationCandidate(state, sessionId);
  if (!candidate) return false;

  // Verify goal is still active
  const goal = getThreadGoal(sessionId);
  if (!goal || goal.goalId !== candidate.goalId || goal.status !== 'active') {
    return false;
  }

  try {
    // Inject continuation prompt as a no-reply message
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: false, // This triggers a response (continuation turn)
        parts: [{ type: 'text', text: candidate.items[0].content }],
      },
    });

    state.continuationTurnId = crypto.randomUUID();
    state.isContinuationTurn = true;
    state.toolsExecutedThisTurn = 0;
    return true;
  } catch {
    return false;
  }
}

async function getContinuationCandidate(
  state: GoalRuntimeState,
  sessionId: string
): Promise<{ goalId: string; items: Array<{ role: string; content: string }> } | null> {
  const goal = getThreadGoal(sessionId);
  if (!goal || goal.status !== 'active') return null;

  const prompt = buildContinuationPrompt(goal);

  return {
    goalId: goal.goalId,
    items: [{ role: 'developer', content: prompt }],
  };
}

export function resetRuntimeState(state: GoalRuntimeState): void {
  state.accounting = createFreshAccountingSnapshot();
  state.budgetLimitReportedGoalId = null;
  state.continuationTurnId = null;
  state.continuationSuppressed = false;
  state.toolsExecutedThisTurn = 0;
  state.isContinuationTurn = false;
}

export function suppressContinuation(state: GoalRuntimeState): void {
  state.continuationSuppressed = true;
}

export function resetContinuationSuppression(state: GoalRuntimeState): void {
  state.continuationSuppressed = false;
}
