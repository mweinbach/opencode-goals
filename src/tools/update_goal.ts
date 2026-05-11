import { tool } from '@opencode-ai/plugin';
import { completeThreadGoal, getThreadGoal } from '../db/goals.js';

export const updateGoalTool = tool({
  description:
    'Update the existing goal. Use this tool only to mark the goal achieved. Set status to complete only when the objective has actually been achieved and no required work remains. Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work. You cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user or system. When marking a budgeted goal achieved with status complete, report the final token usage from the tool result to the user.',
  args: {
    status: tool.schema
      .enum(['complete'])
      .describe(
        'Required. Set to complete only when the objective is achieved and no required work remains.'
      ),
  },
  async execute(args, context) {
    try {
      if (args.status !== 'complete') {
        return JSON.stringify({
          error:
            'update_goal can only mark the existing goal complete; pause, resume, and budget-limited status changes are controlled by the user or system',
        });
      }

      const current = getThreadGoal(context.sessionID);
      if (!current) {
        return JSON.stringify({
          error: 'No active goal found for this session',
        });
      }

      const updated = completeThreadGoal(context.sessionID, current.goalId);

      if (!updated) {
        return JSON.stringify({
          error: 'Goal update failed. The goal may have been replaced.',
        });
      }

      const completionBudgetReport =
        updated.tokenBudget !== null
          ? `Goal complete. Tokens used: ${updated.tokensUsed} / ${updated.tokenBudget}. Time: ${updated.timeUsedSeconds}s.`
          : `Goal complete. Time: ${updated.timeUsedSeconds}s.`;

      return JSON.stringify({
        goal: {
          sessionId: updated.sessionId,
          objective: updated.objective,
          status: updated.status,
          tokenBudget: updated.tokenBudget,
          tokensUsed: updated.tokensUsed,
          timeUsedSeconds: updated.timeUsedSeconds,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
        remainingTokens: 0,
        completionBudgetReport,
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error updating goal',
      });
    }
  },
});
