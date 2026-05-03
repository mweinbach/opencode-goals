import { tool } from '@opencode-ai/plugin';
import { getThreadGoal } from '../db/goals.js';

export const getGoalTool = tool({
  description:
    'Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.',
  args: {},
  async execute(_args, context) {
    const goal = getThreadGoal(context.sessionID);

    if (!goal) {
      return JSON.stringify({ goal: null, message: 'No active goal for this session.' });
    }

    const remainingTokens =
      goal.tokenBudget !== null ? Math.max(0, goal.tokenBudget - goal.tokensUsed) : null;

    return JSON.stringify({
      goal: {
        sessionId: goal.sessionId,
        objective: goal.objective,
        status: goal.status,
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      },
      remainingTokens,
    });
  },
});
