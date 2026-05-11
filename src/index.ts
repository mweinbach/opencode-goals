import type { Event } from '@opencode-ai/sdk';
import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { initializeSchema } from './db/schema.js';
import {
  deleteThreadGoal,
  getThreadGoal,
  insertThreadGoal,
  pauseActiveThreadGoal,
  updateThreadGoal,
} from './db/goals.js';
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
import { validateThreadGoalObjective } from './types.js';

const pluginId = 'opencode-goals';
const runtimeStates = new Map<string, GoalRuntimeState>();
const zeroTokenUsage: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

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

    'command.execute.before': async (input, output) => {
      if (input.command !== 'goal') return;

      output.parts = [
        {
          type: 'text',
          text: await handleGoalSlashCommand(input.sessionID, input.arguments, client),
        } as any,
      ];
    },

    'tool.execute.after': async (input, output) => {
      const sessionId = input.sessionID;
      const state = getOrCreateState(sessionId);
      await logGoalToolOutcome(client, input.tool, output.output);

      const goal = getThreadGoal(sessionId);

      if (!goal || (goal.status !== 'active' && goal.status !== 'budget_limited')) return;

      const currentUsage = await readLatestTokenUsage(client, sessionId);
      if (!currentUsage) {
        recordToolExecution(state);
        return;
      }

      const shouldSteer = await accountObservedGoalUsage(
        state,
        sessionId,
        currentUsage,
        input.tool === 'update_goal' ? 'suppressed' : 'allowed'
      );
      recordToolExecution(state);

      if (shouldSteer) {
        await handleBudgetLimitSteering(state, client, sessionId);
        const updated = getThreadGoal(sessionId);
        if (updated?.status === 'budget_limited') {
          await logGoalMetric(client, 'goal.budget_limited', updated);
        }
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
    if (readTokenUsageFromMessage(list[index] as any)) {
      latest = list[index];
      break;
    }
  }
  if (!latest) return null;

  const info: any = latest.info;
  const tokens = readTokenUsageFromMessage(latest);
  if (!tokens) return null;

  return {
    turnId: info.id ?? crypto.randomUUID(),
    tokens,
  };
}

async function handleEvent(event: Event, client: Parameters<Plugin>[0]['client']): Promise<void> {
  const eventType = (event as any).type as string;
  const properties = (event as any).properties ?? {};
  const sessionId =
    properties.sessionID ??
    properties.sessionId ??
    properties.session?.id ??
    properties.info?.id;

  if (eventType === 'session.deleted' && sessionId) {
    deleteThreadGoal(sessionId);
    removeState(sessionId);
    return;
  }

  if (eventType === 'session.idle' && sessionId) {
    const state = getOrCreateState(sessionId);
    const goal = getThreadGoal(sessionId);
    if (!goal || goal.status !== 'active') return;

    await accountLatestGoalUsage(state, client, sessionId, 'suppressed');

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

  if (eventType === 'message.updated') {
    if (!sessionId) return;
    const role = properties.role ?? properties.message?.role ?? properties.info?.role;
    if (role === 'user') {
      resetContinuationSuppression(getOrCreateState(sessionId));
      return;
    }

    const state = getOrCreateState(sessionId);
    const shouldSteer = await accountLatestGoalUsage(state, client, sessionId, 'allowed');
    if (shouldSteer) {
      await handleBudgetLimitSteering(state, client, sessionId);
      const updated = getThreadGoal(sessionId);
      if (updated?.status === 'budget_limited') {
        await logGoalMetric(client, 'goal.budget_limited', updated);
      }
    }
    return;
  }

  if (eventType === 'message.part.updated') {
    if (!sessionId) return;
    const state = getOrCreateState(sessionId);
    const shouldSteer = await accountLatestGoalUsage(state, client, sessionId, 'allowed');
    if (shouldSteer) {
      await handleBudgetLimitSteering(state, client, sessionId);
    }
  }
}

async function accountLatestGoalUsage(
  state: GoalRuntimeState,
  client: Parameters<Plugin>[0]['client'],
  sessionId: string,
  budgetLimitSteering: 'allowed' | 'suppressed'
): Promise<boolean> {
  const currentUsage = await readLatestTokenUsage(client, sessionId);
  if (!currentUsage) return false;
  return accountObservedGoalUsage(state, sessionId, currentUsage, budgetLimitSteering);
}

async function accountObservedGoalUsage(
  state: GoalRuntimeState,
  sessionId: string,
  currentUsage: { turnId: string; tokens: TokenUsage },
  budgetLimitSteering: 'allowed' | 'suppressed'
): Promise<boolean> {
  if (!state.accounting.turn || state.accounting.turn.turnId !== currentUsage.turnId) {
    await handleTurnStarted(state, sessionId, currentUsage.turnId, zeroTokenUsage);
  }

  return accountGoalProgress(state, sessionId, currentUsage.tokens, budgetLimitSteering);
}

function readTokenUsageFromMessage(message: any): TokenUsage | null {
  const stepTokens =
    message?.parts
      ?.filter((part: any) => part?.type === 'step-finish' && part.tokens)
      ?.map((part: any) => normalizeTokenUsage(part.tokens)) ?? [];

  if (stepTokens.length > 0) return sumTokenUsage(stepTokens);

  const infoTokens = message?.info?.tokens;
  return infoTokens ? normalizeTokenUsage(infoTokens) : null;
}

function normalizeTokenUsage(tokens: any): TokenUsage {
  return {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cache: {
      read: tokens?.cache?.read ?? 0,
      write: tokens?.cache?.write ?? 0,
    },
  };
}

function sumTokenUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce<TokenUsage>(
    (total, usage) => ({
      input: total.input + usage.input,
      output: total.output + usage.output,
      reasoning: total.reasoning + usage.reasoning,
      cache: {
        read: total.cache.read + usage.cache.read,
        write: total.cache.write + usage.cache.write,
      },
    }),
    { ...zeroTokenUsage, cache: { ...zeroTokenUsage.cache } }
  );
}

async function handleGoalSlashCommand(
  sessionId: string,
  rawArguments: string,
  client: Parameters<Plugin>[0]['client']
): Promise<string> {
  const args = rawArguments.trim();
  const lower = args.toLowerCase();

  if (!args || lower === 'status') {
    return formatGoalForCommand(getThreadGoal(sessionId));
  }

  if (lower === 'pause') {
    const paused = pauseActiveThreadGoal(sessionId);
    if (!paused) return 'No active goal is available to pause.';
    return `Goal paused.\n\n${formatGoalForCommand(paused)}`;
  }

  if (lower === 'resume') {
    const current = getThreadGoal(sessionId);
    if (!current) return 'No paused goal is available to resume.';

    const updated = updateThreadGoal(sessionId, {
      status: 'active',
      expectedGoalId: current.goalId,
    });

    if (!updated || updated.status !== 'active') {
      return `Goal could not be resumed because it is ${updated?.status ?? current.status}.`;
    }

    resetContinuationSuppression(getOrCreateState(sessionId));
    return `Goal resumed.\n\n${formatGoalForCommand(updated)}`;
  }

  if (lower === 'clear') {
    const cleared = deleteThreadGoal(sessionId);
    removeState(sessionId);
    return cleared ? 'Goal cleared for this session.' : 'No goal is available to clear.';
  }

  const parsed = parseCreateGoalArguments(args);
  if ('error' in parsed) return parsed.error;

  const existing = getThreadGoal(sessionId);
  if (existing) {
    return `This session already has a goal and /goal will not replace it implicitly.\n\n${formatGoalForCommand(
      existing
    )}\n\nUse the TUI Goals: Create Goal command to confirm replacement, or /goal clear first.`;
  }

  try {
    validateThreadGoalObjective(parsed.objective);
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid goal objective.';
  }

  const goal = insertThreadGoal(sessionId, parsed.objective, 'active', parsed.tokenBudget);
  if (!goal) return 'Cannot create a new goal because this session already has a goal.';

  await logGoalMetric(client, 'goal.created', goal);
  return `Goal created.\n\n${formatGoalForCommand(goal)}`;
}

function parseCreateGoalArguments(
  args: string
): { objective: string; tokenBudget: number | null } | { error: string } {
  let objective = args.replace(/^create\s+/i, '').trim();
  let tokenBudget: number | null = null;
  const budgetMatch = objective.match(/(?:^|\s)--budget\s+(\d+)\b/);

  if (budgetMatch) {
    tokenBudget = Number.parseInt(budgetMatch[1], 10);
    objective = objective.replace(budgetMatch[0], ' ').trim();
  }

  if (objective.length === 0) {
    return { error: 'Goal objective must not be empty.' };
  }

  if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
    return { error: 'token_budget must be a positive integer.' };
  }

  return { objective, tokenBudget };
}

function formatGoalForCommand(goal: ReturnType<typeof getThreadGoal>): string {
  if (!goal) return 'No goal is set for this session.';

  const budget =
    goal.tokenBudget === null
      ? `tokens used: ${goal.tokensUsed}; token budget: none`
      : `tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}; remaining: ${Math.max(
          0,
          goal.tokenBudget - goal.tokensUsed
        )}`;

  return [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Usage: ${budget}; time used: ${goal.timeUsedSeconds} seconds`,
  ].join('\n');
}

async function logGoalToolOutcome(
  client: Parameters<Plugin>[0]['client'],
  toolName: string,
  output: string
): Promise<void> {
  if (toolName !== 'create_goal' && toolName !== 'update_goal') return;

  try {
    const parsed = JSON.parse(output) as { goal?: unknown; error?: unknown };
    if (!parsed.goal || parsed.error) return;
    await logGoalMetric(
      client,
      toolName === 'create_goal' ? 'goal.created' : 'goal.completed',
      parsed.goal
    );
  } catch {
    return;
  }
}

async function logGoalMetric(
  client: Parameters<Plugin>[0]['client'],
  metric: string,
  goal: unknown
): Promise<void> {
  await client.app
    .log({
      body: {
        service: pluginId,
        level: 'info',
        message: JSON.stringify({ metric, goal }),
      },
    })
    .catch(() => undefined);
}

const plugin: PluginModule & { id: string } = {
  id: pluginId,
  server: OpenCodeGoalsPlugin,
};

export default plugin;
