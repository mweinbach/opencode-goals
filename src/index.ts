import type { Event } from '@opencode-ai/sdk';
import type { Plugin, PluginModule } from '@opencode-ai/plugin';
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

const pluginId = 'opencode-goals';
const runtimeStates = new Map<string, GoalRuntimeState>();

function getOrCreateState(sessionId: string): GoalRuntimeState {
  let state = runtimeStates.get(sessionId);
  if (!state) {
    state = createGoalRuntimeState();
    runtimeStates.set(sessionId, state);
  }
  return state;
}

function removeState(sessionId: string): void {
  runtimeStates.delete(sessionId);
}

export const OpenCodeGoalsPlugin: Plugin = async ({ client }) => {
  initializeSchema();

  await client.app
    .log({
      body: {
        service: pluginId,
        level: 'info',
        message: 'Goals plugin initialized',
      },
    })
    .catch(() => undefined);

  return {
    tool: {
      get_goal: getGoalTool,
      create_goal: createGoalTool,
      update_goal: updateGoalTool,
    },

    event: async ({ event }) => {
      await handleEvent(event, client);
    },

    'tool.execute.after': async (input) => {
      const sessionId = input.sessionID;
      const state = getOrCreateState(sessionId);
      const goal = getThreadGoal(sessionId);

      if (!goal || (goal.status !== 'active' && goal.status !== 'budget_limited')) return;

      recordToolExecution(state);

      const currentUsage = await readLatestTokenUsage(client, sessionId);
      if (!currentUsage) return;

      if (!state.accounting.turn || state.accounting.turn.turnId !== currentUsage.turnId) {
        await handleTurnStarted(state, sessionId, currentUsage.turnId, currentUsage.tokens);
      }

      const shouldSteer = await accountGoalProgress(
        state,
        sessionId,
        currentUsage.tokens,
        input.tool === 'update_goal' ? 'suppressed' : 'allowed'
      );

      if (shouldSteer) {
        await handleBudgetLimitSteering(state, client, sessionId);
      }
    },

    'experimental.session.compacting': async (input, output) => {
      const goal = getThreadGoal(input.sessionID);
      if (!goal || goal.status !== 'active') return;

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
    },
  };
};

type TokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
};

async function readLatestTokenUsage(
  client: Parameters<Plugin>[0]['client'],
  sessionId: string
): Promise<{ turnId: string; tokens: TokenUsage } | null> {
  const messages = await client.session.messages({ path: { id: sessionId } });
  let latest: any;
  const list = messages.data ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if ((list[index] as any).info?.tokens) {
      latest = list[index];
      break;
    }
  }
  const info: any = latest?.info;
  const tokens: any = info?.tokens;
  if (!tokens) return null;

  return {
    turnId: info.id ?? crypto.randomUUID(),
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cache: {
        read: tokens.cache?.read ?? 0,
        write: tokens.cache?.write ?? 0,
      },
    },
  };
}

async function handleEvent(event: Event, client: Parameters<Plugin>[0]['client']): Promise<void> {
  const eventType = event.type;
  const properties = (event as any).properties ?? {};
  const sessionId = properties.sessionID ?? properties.sessionId ?? properties.session?.id;

  if (eventType === 'session.deleted' && sessionId) {
    removeState(sessionId);
    return;
  }

  if (eventType === 'session.idle' && sessionId) {
    const state = getOrCreateState(sessionId);
    const goal = getThreadGoal(sessionId);
    if (!goal || goal.status !== 'active') return;

    if (state.isContinuationTurn && state.toolsExecutedThisTurn === 0) {
      state.continuationSuppressed = true;
      state.isContinuationTurn = false;
      await client.app
        .log({
          body: {
            service: pluginId,
            level: 'info',
            message: 'Continuation suppressed: no autonomous activity in last turn',
          },
        })
        .catch(() => undefined);
      return;
    }

    state.isContinuationTurn = false;

    const continued = await maybeContinueGoal(state, client, sessionId);
    if (continued) {
      await client.app
        .log({
          body: {
            service: pluginId,
            level: 'info',
            message: `Auto-continued goal: ${goal.objective.slice(0, 50)}...`,
          },
        })
        .catch(() => undefined);
    }
    return;
  }

  if (eventType === 'message.updated' || eventType === 'message.part.updated') {
    if (!sessionId) return;
    const role = properties.role ?? properties.message?.role ?? properties.info?.role;
    if (role === 'user') {
      resetContinuationSuppression(getOrCreateState(sessionId));
    }
  }
}

const plugin: PluginModule & { id: string } = {
  id: pluginId,
  server: OpenCodeGoalsPlugin,
};

export default plugin;
