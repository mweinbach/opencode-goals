// Core types matching Codex protocol spec

export type ThreadGoalStatus = 'active' | 'paused' | 'budget_limited' | 'complete';

export interface ThreadGoal {
  threadId: string;
  goalId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  /** Billable goal tokens: non-cached input + output. Cached input is tracked separately. */
  tokensUsed: number;
  inputTokensUsed: number;
  cachedInputTokensUsed: number;
  outputTokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadGoalUpdate {
  status?: ThreadGoalStatus;
  tokenBudget?: number | null;
  expectedGoalId?: string;
}

export type ThreadGoalAccountingMode =
  | 'active_status_only'
  | 'active_only'
  | 'active_or_complete'
  | 'active_or_stopped';

export type ThreadGoalAccountingOutcome =
  | { type: 'unchanged'; goal: ThreadGoal | null }
  | { type: 'updated'; goal: ThreadGoal };

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface ThreadGoalTokenDelta {
  billableTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface GoalTurnAccountingSnapshot {
  turnId: string;
  lastAccountedTokenUsage: TokenUsage;
  activeGoalId: string | null;
}

export interface GoalWallClockAccountingSnapshot {
  lastAccountedAt: number; // epoch ms
  activeGoalId: string | null;
}

export interface GoalAccountingSnapshot {
  turn: GoalTurnAccountingSnapshot | null;
  wallClock: GoalWallClockAccountingSnapshot;
}

export interface GoalContinuationCandidate {
  goalId: string;
  items: Array<{ role: string; content: string }>;
}

export const MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4000;

export function validateThreadGoalObjective(value: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error('goal objective must not be empty');
  }
  if (value.length > MAX_THREAD_GOAL_OBJECTIVE_CHARS) {
    throw new Error(
      `goal objective must be at most ${MAX_THREAD_GOAL_OBJECTIVE_CHARS} characters`
    );
  }
}

export function escapeXmlText(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Simplified SDK client type for our usage
export interface OpencodeClient {
  app: {
    log: (params: {
      body: {
        service: string;
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
      };
    }) => Promise<unknown>;
    agents: (params: Record<string, never>) => Promise<{
      data?: Array<{ name: string; description?: string; mode?: string }>;
    }>;
  };
  config: {
    get: () => Promise<{ data?: Record<string, unknown> }>;
  };
  session: {
    list: () => Promise<{
      data?: Array<{
        id: string;
        status?: string;
        parentID?: string | null;
      }>;
    }>;
    get: (params: { path: { id: string } }) => Promise<{
      data?: { id: string; parentID?: string | null } | null;
    }>;
    create: (params: {
      body: {
        title: string;
        parentID?: string;
      };
    }) => Promise<{ data?: { id: string } | null }>;
    delete: (params: { path: { id: string } }) => Promise<unknown>;
    messages: (params: { path: { id: string } }) => Promise<{
      data?: Array<{
        info: {
          id: string;
          role: string;
          tokens?: {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          };
        };
        parts: Array<{
          type: string;
          text?: string;
        }>;
      }>;
    }>;
    prompt: (params: {
      path: { id: string };
      body: {
        noReply?: boolean;
        agent?: string;
        parts: Array<{ type: string; text: string }>;
        tools?: Record<string, boolean>;
      };
    }) => Promise<unknown>;
  };
  event: {
    subscribe: () => Promise<{
      stream: AsyncIterable<{
        type: string;
        properties?: Record<string, unknown>;
      }>;
      cancel?: () => void;
    }>;
  };
}
