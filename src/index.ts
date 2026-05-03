import type { Plugin } from '@opencode-ai/plugin';
import type { Event } from '@opencode-ai/sdk';
import { initializeSchema } from './db/schema.js';
import { getThreadGoal } from './db/goals.js';
import { getGoalTool } from './tools/get_goal.js';
import { createGoalTool } from './tools/create_goal.js';
import { updateGoalTool } from './tools/update_goal.js';
import {
  createGoalRuntimeState,
  handleTurnStarted,
  accountGoalProgress,
  handleBudgetLimitSteering,
  maybeContinueGoal,
  resetContinuationSuppression,
  recordToolExecution,
} from './runtime/state.js';
import type { GoalRuntimeState } from './runtime/state.js';

// Map session IDs to their runtime state
const runtimeStates = new Map<string, GoalRuntimeState>();

function getOrCreateState(sessionId: string): GoalRuntimeState {
  let state = runtimeStates.get(sessionId);
  if (!state) {
    state = createGoalRuntimeState();
    runtimeStates.set(sessionId, state);
  }
  return state;
}

function getState(sessionId: string): GoalRuntimeState | undefined {
  return runtimeStates.get(sessionId);
}

function removeState(sessionId: string): void {
  runtimeStates.delete(sessionId);
}

export const OpenCodeGoalsPlugin: Plugin = async ({ directory, client }) => {
  // Initialize database
  initializeSchema();

  await client.app.log({
    body: {
      service: 'opencode-goals',
      level: 'info',
      message: 'Goals plugin initialized',
    },
  });

  // Subscribe to events for session lifecycle management
  let eventStream: { stream: AsyncIterable<Event>; cancel?: () => void } | null = null;

  try {
    eventStream = await client.event.subscribe();

    // Start event processing loop
    (async () => {
      if (!eventStream) return;
      for await (const event of eventStream.stream) {
        await handleEvent(event, client);
      }
    })().catch(() => {
      // Event stream errors are non-fatal
    });
  } catch {
    // Event subscription may fail in some contexts
  }

  return {
    // ─── Model Tools ─────────────────────────────────────────────────────────
    tool: {
      get_goal: getGoalTool,
      create_goal: createGoalTool,
      update_goal: updateGoalTool,
    },

    // ─── Session Lifecycle Hooks ─────────────────────────────────────────────
    'session.created': async () => {
      // We can't easily get the new session ID here, so we rely on
      // the first tool execution or event to establish state
    },

    'session.idle': async () => {
      // Try to get current session from project
      try {
        const sessions = await client.session.list();
        const activeSession = sessions.data?.find((s: any) => s.status === 'active');
        if (!activeSession?.id) return;

        const sessionId = activeSession.id;
        const state = getOrCreateState(sessionId);

        // Suppression check: if last continuation turn had 0 tool calls, stop looping
        if (state.isContinuationTurn && state.toolsExecutedThisTurn === 0) {
          state.continuationSuppressed = true;
          state.isContinuationTurn = false;
          await client.app.log({
            body: {
              service: 'opencode-goals',
              level: 'info',
              message: 'Continuation suppressed: no autonomous activity in last turn',
            },
          });
          return;
        }

        // Reset continuation flag for next check
        state.isContinuationTurn = false;

        // Try to continue goal if active
        const goal = getThreadGoal(sessionId);
        if (goal?.status === 'active') {
          const continued = await maybeContinueGoal(state, client, sessionId);
          if (continued) {
            await client.app.log({
              body: {
                service: 'opencode-goals',
                level: 'info',
                message: `Auto-continued goal: ${goal.objective.slice(0, 50)}...`,
              },
            });
          }
        }
      } catch {
        // Silently fail
      }
    },

    'session.deleted': async () => {
      // Clean up state when session is deleted
      try {
        const sessions = await client.session.list();
        const activeIds = new Set(sessions.data?.map((s: any) => s.id) ?? []);
        for (const [sessionId] of runtimeStates) {
          if (!activeIds.has(sessionId)) {
            removeState(sessionId);
          }
        }
      } catch {
        // Silently fail
      }
    },

    // ─── Tool Execution Hooks ────────────────────────────────────────────────
    'tool.execute.before': async () => {
      // Capture token baseline before tool execution if we have an active turn
      try {
        const sessions = await client.session.list();
        const activeSession = sessions.data?.find((s: any) => s.status === 'active');
        if (!activeSession?.id) return;

        const sessionId = activeSession.id;
        const state = getOrCreateState(sessionId);

        // We can't get token usage here easily, so we'll do it in after hook
      } catch {
        // Silently fail
      }
    },

    'tool.execute.after': async (input) => {
      try {
        const sessions = await client.session.list();
        const activeSession = sessions.data?.find((s: any) => s.status === 'active');
        if (!activeSession?.id) return;

        const sessionId = activeSession.id;
        const state = getOrCreateState(sessionId);
        const goal = getThreadGoal(sessionId);

        if (!goal || (goal.status !== 'active' && goal.status !== 'budget_limited')) return;

        // Get current messages to extract token usage
        const messages = await client.session.messages({ path: { id: sessionId } });
        const lastMessage = messages.data?.[messages.data.length - 1];

        const messageInfo: any = lastMessage?.info;
        if (messageInfo?.tokens) {
          const tokens: any = messageInfo.tokens;

          const currentUsage = {
            input: tokens.input ?? 0,
            output: tokens.output ?? 0,
            reasoning: tokens.reasoning ?? 0,
            cache: {
              read: tokens.cache?.read ?? 0,
              write: tokens.cache?.write ?? 0,
            },
          };

          // If this is the first tool in a turn, establish baseline
          if (!state.accounting.turn) {
            const turnId = messageInfo.id || crypto.randomUUID();
            handleTurnStarted(state, sessionId, turnId, currentUsage);
          }

          // Track that this turn had tool activity
          recordToolExecution(state);

          // Account progress (suppressed for update_goal tool)
          const isUpdateGoal = input.tool === 'update_goal';
          const shouldSteer = await accountGoalProgress(
            state,
            sessionId,
            currentUsage,
            isUpdateGoal ? 'suppressed' : 'allowed'
          );

          if (shouldSteer) {
            await handleBudgetLimitSteering(state, client as any, sessionId);
          }
        }
      } catch {
        // Silently fail
      }
    },

    // ─── Compaction Hook ─────────────────────────────────────────────────────
    'experimental.session.compacting': async (_input, output) => {
      try {
        const sessions = await client.session.list();
        const activeSession = sessions.data?.find((s: any) => s.status === 'active');
        if (!activeSession?.id) return;

        const sessionId = activeSession.id;
        const goal = getThreadGoal(sessionId);

        if (goal && goal.status === 'active') {
          const remainingTokens =
            goal.tokenBudget !== null
              ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
              : 'unbounded';

          output.context.push(
            `## Active Goal\n` +
              `Objective: ${goal.objective}\n` +
              `Status: ${goal.status}\n` +
              `Tokens used: ${goal.tokensUsed}${goal.tokenBudget !== null ? ` / ${goal.tokenBudget}` : ''}\n` +
              `Remaining: ${remainingTokens}\n` +
              `Time: ${goal.timeUsedSeconds}s\n\n` +
              `This goal is in progress and should be preserved across compaction.`
          );
        }
      } catch {
        // Silently fail
      }
    },
  };
};

// ─── Event Handler ───────────────────────────────────────────────────────────

async function handleEvent(event: Event, client: any): Promise<void> {
  try {
    const eventType = event.type;
    const properties = (event as any).properties || {};

    if (eventType === 'session.idle') {
      const sessionId = properties.sessionID || properties.sessionId;
      if (!sessionId) return;

      const state = getOrCreateState(sessionId);
      const goal = getThreadGoal(sessionId);

      if (goal?.status === 'active') {
        const continued = await maybeContinueGoal(state, client, sessionId);
        if (continued) {
          await client.app.log({
            body: {
              service: 'opencode-goals',
              level: 'info',
              message: `Auto-continued goal: ${goal.objective.slice(0, 50)}...`,
            },
          });
        }
      }
    }

    if (eventType === 'message.updated' || eventType === 'message.part.updated') {
      const sessionId = properties.sessionID || properties.sessionId;
      if (!sessionId) return;

      const state = getOrCreateState(sessionId);

      // Reset continuation suppression on new user input
      if (properties.role === 'user') {
        resetContinuationSuppression(state);
      }
    }
  } catch {
    // Event handling errors are non-fatal
  }
}

export default OpenCodeGoalsPlugin;
