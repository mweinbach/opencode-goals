import type {
  TokenUsage,
  GoalAccountingSnapshot,
  ThreadGoalAccountingMode,
  ThreadGoal,
} from '../types.js';

/**
 * Calculate token delta for goal accounting.
 * Formula: non_cached_input + output_tokens
 * Where non_cached_input = input - cache.read
 */
export function goalTokenDeltaForUsage(usage: TokenUsage): number {
  const nonCachedInput = Math.max(0, usage.input - usage.cache.read);
  return nonCachedInput + Math.max(0, usage.output);
}

export function computeTokenDelta(
  previous: TokenUsage,
  current: TokenUsage
): number {
  const prevTotal = goalTokenDeltaForUsage(previous);
  const currTotal = goalTokenDeltaForUsage(current);
  return Math.max(0, currTotal - prevTotal);
}

export function computeWallClockDelta(lastAccountedAt: number): number {
  const now = Date.now();
  const deltaMs = now - lastAccountedAt;
  return Math.max(0, Math.floor(deltaMs / 1000));
}

export function createFreshAccountingSnapshot(): GoalAccountingSnapshot {
  return {
    turn: null,
    wallClock: {
      lastAccountedAt: Date.now(),
      activeGoalId: null,
    },
  };
}

export function markTurnStarted(
  snapshot: GoalAccountingSnapshot,
  turnId: string,
  tokenUsage: TokenUsage,
  goalId: string | null
): void {
  snapshot.turn = {
    turnId,
    lastAccountedTokenUsage: { ...tokenUsage },
    activeGoalId: goalId,
  };

  if (goalId) {
    snapshot.wallClock.activeGoalId = goalId;
    snapshot.wallClock.lastAccountedAt = Date.now();
  }
}

export function accountTurnProgress(
  snapshot: GoalAccountingSnapshot,
  currentTokenUsage: TokenUsage
): {
  tokenDelta: number;
  timeDeltaSeconds: number;
  expectedGoalId: string | null;
} {
  if (!snapshot.turn || !snapshot.turn.activeGoalId) {
    return { tokenDelta: 0, timeDeltaSeconds: 0, expectedGoalId: null };
  }

  const tokenDelta = computeTokenDelta(
    snapshot.turn.lastAccountedTokenUsage,
    currentTokenUsage
  );

  const timeDeltaSeconds = computeWallClockDelta(snapshot.wallClock.lastAccountedAt);

  return {
    tokenDelta,
    timeDeltaSeconds,
    expectedGoalId: snapshot.turn.activeGoalId,
  };
}

export function updateSnapshotAfterAccounting(
  snapshot: GoalAccountingSnapshot,
  currentTokenUsage: TokenUsage,
  timeDeltaSeconds: number,
  clearActiveGoal: boolean
): void {
  if (snapshot.turn) {
    snapshot.turn.lastAccountedTokenUsage = { ...currentTokenUsage };
    if (clearActiveGoal) {
      snapshot.turn.activeGoalId = null;
    }
  }

  snapshot.wallClock.lastAccountedAt = Date.now();
  if (clearActiveGoal) {
    snapshot.wallClock.activeGoalId = null;
  }
}

export function clearTurnSnapshot(snapshot: GoalAccountingSnapshot): void {
  snapshot.turn = null;
}

export function resetWallClockBaseline(snapshot: GoalAccountingSnapshot): void {
  snapshot.wallClock.lastAccountedAt = Date.now();
}

export function shouldClearActiveGoal(status: ThreadGoal['status']): boolean {
  return status === 'paused' || status === 'complete' || status === 'budget_limited';
}
