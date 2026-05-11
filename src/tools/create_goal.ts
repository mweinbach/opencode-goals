import { tool } from '@opencode-ai/plugin';
import { getThreadGoal, insertThreadGoal } from '../db/goals.js';
import { validateThreadGoalObjective } from '../types.js';

export const createGoalTool = tool({
  description:
    'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status.',
  args: {
    objective: tool.schema
      .string()
      .describe(
        'The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails.'
      ),
    token_budget: tool.schema
      .number()
      .optional()
      .describe('Optional positive token budget for the new active goal.'),
  },
  async execute(args, context) {
    try {
      // Check if goal already exists
      const existing = getThreadGoal(context.sessionID);
      if (existing) {
        return JSON.stringify({
          error: `Cannot create a new goal because this session already has a goal: "${existing.objective}". Use update_goal to modify it, or clear it first.`,
        });
      }

      // Validate objective
      validateThreadGoalObjective(args.objective);

      // Validate budget
      if (
        args.token_budget !== undefined &&
        (!Number.isInteger(args.token_budget) || args.token_budget <= 0)
      ) {
        return JSON.stringify({
          error: 'token_budget must be a positive integer',
        });
      }

      const goal = insertThreadGoal(
        context.sessionID,
        args.objective.trim(),
        'active',
        args.token_budget ?? null
      );

      if (!goal) {
        return JSON.stringify({
          error: 'Cannot create a new goal because this session already has a goal.',
        });
      }

      const remainingTokens =
        goal.tokenBudget !== null ? Math.max(0, goal.tokenBudget - goal.tokensUsed) : null;

      return JSON.stringify({
        goal: {
          threadId: goal.threadId,
          objective: goal.objective,
          status: goal.status,
          tokenBudget: goal.tokenBudget,
          tokensUsed: goal.tokensUsed,
          inputTokensUsed: goal.inputTokensUsed,
          cachedInputTokensUsed: goal.cachedInputTokensUsed,
          outputTokensUsed: goal.outputTokensUsed,
          timeUsedSeconds: goal.timeUsedSeconds,
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt,
        },
        remainingTokens,
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error creating goal',
      });
    }
  },
});
