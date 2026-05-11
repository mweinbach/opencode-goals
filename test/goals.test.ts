import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb, setDbPathForTests } from '../src/db/connection.js';
import { initializeSchema } from '../src/db/schema.js';
import {
  accountThreadGoalUsage,
  completeThreadGoal,
  getThreadGoal,
  insertThreadGoal,
  pauseActiveThreadGoal,
  replaceThreadGoal,
  updateThreadGoal,
} from '../src/db/goals.js';
import {
  computeTokenDelta,
  goalTokenDeltaForUsage,
} from '../src/runtime/accounting.js';
import { buildBudgetLimitPrompt, buildContinuationPrompt } from '../src/prompts/builders.js';
import { createGoalTool } from '../src/tools/create_goal.js';
import { getGoalTool } from '../src/tools/get_goal.js';
import { updateGoalTool } from '../src/tools/update_goal.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'opencode-goals-test-'));
  setDbPathForTests(join(tempDir, 'goals.db'));
});

afterEach(() => {
  closeDb();
  setDbPathForTests(null);
  rmSync(tempDir, { recursive: true, force: true });
});

test('schema creates thread_goals and migrates legacy session_goals rows', () => {
  const db = getDb();
  db.run(`
    CREATE TABLE session_goals (
      session_id TEXT PRIMARY KEY NOT NULL,
      directory TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  db.run(
    `INSERT INTO session_goals (
      session_id, directory, goal_id, objective, status, token_budget,
      tokens_used, time_used_seconds, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['session-a', '/tmp/project', 'goal-a', 'legacy goal', 'active', null, 7, 11, 1, 2]
  );

  initializeSchema();

  const migrated = getThreadGoal('session-a');
  expect(migrated?.threadId).toBe('session-a');
  expect(migrated?.objective).toBe('legacy goal');
  expect(migrated?.tokensUsed).toBe(7);
  expect(migrated?.timeUsedSeconds).toBe(11);
});

test('insert is create-only and replace resets accounting with a new goal id', () => {
  initializeSchema();

  const first = insertThreadGoal('thread-1', 'write tests', 'active', null);
  expect(first?.objective).toBe('write tests');
  expect(insertThreadGoal('thread-1', 'duplicate', 'active', null)).toBeNull();

  accountThreadGoalUsage('thread-1', 9, 25, 'active_only', first!.goalId);
  const replacement = replaceThreadGoal('thread-1', 'ship plugin', 'active', 100);

  expect(replacement.goalId).not.toBe(first!.goalId);
  expect(replacement.objective).toBe('ship plugin');
  expect(replacement.tokensUsed).toBe(0);
  expect(replacement.timeUsedSeconds).toBe(0);
  expect(replacement.tokenBudget).toBe(100);
});

test('accounting clamps deltas, respects expected goal id, and promotes active goals over budget', () => {
  initializeSchema();
  const goal = replaceThreadGoal('thread-1', 'budgeted', 'active', 10);

  const wrongExpected = accountThreadGoalUsage('thread-1', 3, 5, 'active_only', 'wrong-goal');
  expect(wrongExpected.type).toBe('unchanged');
  expect(wrongExpected.goal?.tokensUsed).toBe(0);

  const negative = accountThreadGoalUsage('thread-1', -3, -5, 'active_only', goal.goalId);
  expect(negative.type).toBe('unchanged');

  const updated = accountThreadGoalUsage('thread-1', 4, 12, 'active_only', goal.goalId);
  expect(updated.type).toBe('updated');
  expect(updated.goal.status).toBe('budget_limited');
  expect(updated.goal.tokensUsed).toBe(12);
  expect(updated.goal.timeUsedSeconds).toBe(4);
});

test('pause and resume preserve budget limit invariants', () => {
  initializeSchema();
  const goal = replaceThreadGoal('thread-1', 'budgeted', 'active', 10);
  accountThreadGoalUsage('thread-1', 0, 12, 'active_only', goal.goalId);

  expect(pauseActiveThreadGoal('thread-1')).toBeNull();

  const resumed = updateThreadGoal('thread-1', { status: 'active' });
  expect(resumed?.status).toBe('budget_limited');

  const unbudgeted = replaceThreadGoal('thread-1', 'pause me', 'active', null);
  const paused = pauseActiveThreadGoal('thread-1');
  expect(paused?.status).toBe('paused');

  const stoppedAccounting = accountThreadGoalUsage(
    'thread-1',
    5,
    2,
    'active_or_stopped',
    unbudgeted.goalId
  );
  expect(stoppedAccounting.type).toBe('updated');
  expect(stoppedAccounting.goal.status).toBe('paused');
});

test('lowering a budget below usage immediately marks the goal budget_limited', () => {
  initializeSchema();
  const goal = replaceThreadGoal('thread-1', 'set lower budget', 'active', null);
  accountThreadGoalUsage('thread-1', 0, 25, 'active_only', goal.goalId);

  const lowered = updateThreadGoal('thread-1', { tokenBudget: 20 });
  expect(lowered?.status).toBe('budget_limited');
});

test('complete returns final usage and clears the current row', () => {
  initializeSchema();
  const goal = replaceThreadGoal('thread-1', 'finish me', 'active', 100);
  accountThreadGoalUsage('thread-1', 8, 40, 'active_only', goal.goalId);

  const completed = completeThreadGoal('thread-1', goal.goalId);
  expect(completed?.status).toBe('complete');
  expect(completed?.tokensUsed).toBe(40);
  expect(getThreadGoal('thread-1')).toBeNull();
});

test('token accounting excludes cached input and never returns negative deltas', () => {
  expect(
    goalTokenDeltaForUsage({
      input: 100,
      output: 30,
      reasoning: 0,
      cache: { read: 80, write: 0 },
    })
  ).toBe(50);

  expect(
    computeTokenDelta(
      { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      { input: 80, output: 30, reasoning: 0, cache: { read: 0, write: 0 } }
    )
  ).toBe(0);
});

test('prompts render unbudgeted goals and XML-escape objectives', () => {
  const goal = {
    threadId: 'thread-1',
    goalId: 'goal-1',
    objective: 'finish <tests> & report',
    status: 'active' as const,
    tokenBudget: null,
    tokensUsed: 12,
    timeUsedSeconds: 34,
    createdAt: 1,
    updatedAt: 2,
  };

  const continuation = buildContinuationPrompt(goal);
  expect(continuation).toContain('finish &lt;tests&gt; &amp; report');
  expect(continuation).toContain('Token budget: none');
  expect(continuation).toContain('Tokens remaining: unbounded');

  const budget = buildBudgetLimitPrompt({ ...goal, tokenBudget: 100 });
  expect(budget).toContain('finish &lt;tests&gt; &amp; report');
  expect(budget).toContain('Token budget: 100');
});

test('model tools enforce create-only and complete-only contracts', async () => {
  initializeSchema();
  const context = {
    sessionID: 'thread-1',
    messageID: 'message-1',
    agent: 'build',
    directory: tempDir,
    worktree: tempDir,
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      throw new Error('not used');
    },
  } as any;

  const invalidBudget = JSON.parse(
    (await createGoalTool.execute({ objective: 'x', token_budget: 0 }, context)) as string
  );
  expect(invalidBudget.error).toContain('positive integer');

  const created = JSON.parse(
    (await createGoalTool.execute({ objective: 'ship the thing', token_budget: 100 }, context)) as string
  );
  expect(created.goal.threadId).toBe('thread-1');
  expect(created.remainingTokens).toBe(100);

  const duplicate = JSON.parse(
    (await createGoalTool.execute({ objective: 'another' }, context)) as string
  );
  expect(duplicate.error).toContain('already has a goal');

  accountThreadGoalUsage('thread-1', 3, 40, 'active_only', getThreadGoal('thread-1')!.goalId);
  const current = JSON.parse((await getGoalTool.execute({}, context)) as string);
  expect(current.goal.tokensUsed).toBe(40);

  const completed = JSON.parse(
    (await updateGoalTool.execute({ status: 'complete' }, context)) as string
  );
  expect(completed.goal.status).toBe('complete');
  expect(completed.remainingTokens).toBe(60);
  expect(completed.completionBudgetReport).toContain('40 of 100');
  expect(getThreadGoal('thread-1')).toBeNull();
});

test('server accounts message updates from the first observed token usage', async () => {
  initializeSchema();
  replaceThreadGoal('message-update-thread', 'track live tokens', 'active', null);

  let latestMessage: any = {
    info: {
      id: 'assistant-1',
      role: 'assistant',
      tokens: {
        input: 100,
        output: 20,
        reasoning: 0,
        cache: { read: 40, write: 0 },
      },
    },
    parts: [],
  };

  const mod = await import('../src/index.js');
  const hooks = await mod.default.server({
    client: {
      app: {
        log: async () => ({}),
      },
      session: {
        messages: async () => ({ data: [latestMessage] }),
        prompt: async () => ({}),
      },
    },
  } as any);

  await hooks.event?.({
    event: {
      type: 'message.updated',
      properties: {
        sessionID: 'message-update-thread',
        info: latestMessage.info,
      },
    } as any,
  });

  expect(getThreadGoal('message-update-thread')?.tokensUsed).toBe(80);

  latestMessage = {
    ...latestMessage,
    info: {
      ...latestMessage.info,
      tokens: {
        input: 100,
        output: 30,
        reasoning: 0,
        cache: { read: 40, write: 0 },
      },
    },
  };

  await hooks.event?.({
    event: {
      type: 'message.updated',
      properties: {
        sessionID: 'message-update-thread',
        info: latestMessage.info,
      },
    } as any,
  });

  expect(getThreadGoal('message-update-thread')?.tokensUsed).toBe(90);
});

test('server sums step-finish token usage for live multi-step accounting', async () => {
  initializeSchema();
  replaceThreadGoal('step-finish-thread', 'track step usage', 'active', null);

  const latestMessage = {
    info: {
      id: 'assistant-steps',
      role: 'assistant',
      tokens: {
        input: 50,
        output: 10,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        type: 'step-finish',
        tokens: {
          input: 100,
          output: 20,
          reasoning: 0,
          cache: { read: 20, write: 0 },
        },
      },
      {
        type: 'step-finish',
        tokens: {
          input: 50,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    ],
  };

  const mod = await import('../src/index.js');
  const hooks = await mod.default.server({
    client: {
      app: {
        log: async () => ({}),
      },
      session: {
        messages: async () => ({ data: [latestMessage] }),
        prompt: async () => ({}),
      },
    },
  } as any);

  await hooks.event?.({
    event: {
      type: 'message.updated',
      properties: {
        sessionID: 'step-finish-thread',
        info: latestMessage.info,
      },
    } as any,
  });

  expect(getThreadGoal('step-finish-thread')?.tokensUsed).toBe(160);
});
