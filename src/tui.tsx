/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui';
import { createSignal } from 'solid-js';
import { initializeSchema } from './db/schema.js';
import {
  deleteThreadGoal,
  getThreadGoal,
  pauseActiveThreadGoal,
  replaceThreadGoal,
  updateThreadGoal,
} from './db/goals.js';
import { buildContinuationPrompt } from './prompts/builders.js';
import { validateThreadGoalObjective } from './types.js';
import type { ThreadGoal } from './types.js';

const id = 'opencode-goals-tui';

export type GoalState = Pick<
  ThreadGoal,
  | 'threadId'
  | 'objective'
  | 'status'
  | 'tokenBudget'
  | 'tokensUsed'
  | 'inputTokensUsed'
  | 'cachedInputTokensUsed'
  | 'outputTokensUsed'
  | 'timeUsedSeconds'
  | 'updatedAt'
>;

const tui: TuiPlugin = async (api) => {
  initializeSchema();

  const [goal, setGoal] = createSignal<GoalState | null>(null);
  const [clock, setClock] = createSignal(Date.now());
  const resumePrompted = new Set<string>();

  function setGoalState(next: GoalState | null): void {
    setGoal((current) => (sameGoal(current, next) ? current : next));
  }

  async function currentSessionId(): Promise<string | null> {
    const route = api.route.current;
    if (route.name === 'session' && typeof route.params?.sessionID === 'string') {
      return route.params.sessionID;
    }
    return null;
  }

  async function ensureGoalSession(objective: string): Promise<{ sessionId: string; created: boolean }> {
    const current = await currentSessionId();
    if (current) return { sessionId: current, created: false };

    const created = await api.client.session.create({
      directory: api.state.path.directory,
      title: `Goal: ${truncate(objective, 80)}`,
    });

    if ((created as any).error) {
      throw new Error('Creating a session failed');
    }

    const sessionId = (created as any).data?.id;
    if (typeof sessionId !== 'string') {
      throw new Error('Creating a session did not return an id');
    }

    api.route.navigate('session', { sessionID: sessionId });
    return { sessionId, created: true };
  }

  async function fetchGoal(sessionId?: string): Promise<void> {
    const id = sessionId ?? (await currentSessionId());
    if (!id) {
      setGoalState(null);
      return;
    }

    const next = getThreadGoal(id);
    setGoalState(next);
    maybePromptResume(next);
  }

  function openCreateDialog(): void {
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title="Create Goal"
        placeholder="Enter objective..."
        onConfirm={(value: string) => {
          const objective = value.trim();
          if (!objective) return;
          openBudgetDialog(objective);
        }}
        onCancel={() => {
          api.ui.dialog.clear();
        }}
      />
    ));
  }

  function openBudgetDialog(objective: string): void {
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title="Token Budget"
        placeholder="Optional tokens, blank for none"
        onConfirm={(value: string) => {
          let tokenBudget: number | null;
          try {
            tokenBudget = parseOptionalTokenBudget(value);
          } catch (error) {
            api.ui.toast({
              variant: 'error',
              message: error instanceof Error ? error.message : 'Invalid token budget',
              duration: 3000,
            });
            openBudgetDialog(objective);
            return;
          }

          api.ui.dialog.clear();
          void createGoal(objective, tokenBudget);
        }}
        onCancel={() => {
          api.ui.dialog.clear();
        }}
      />
    ));
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: 'goals.create',
        title: 'Goals: Create Goal',
        category: 'Goals',
        namespace: 'palette',
        slashName: 'goal-create',
        run() {
          openCreateDialog();
        },
      },
      {
        name: 'goals.summary',
        title: 'Goals: Summary',
        category: 'Goals',
        namespace: 'palette',
        slashName: 'goal',
        slashAliases: ['goals'],
        run() {
          showGoalSummary();
        },
      },
      {
        name: 'goals.pause_resume',
        title: 'Goals: Pause/Resume Goal',
        category: 'Goals',
        namespace: 'palette',
        slashName: 'goal-toggle',
        enabled: () => goal() !== null,
        run() {
          void togglePause();
        },
      },
      {
        name: 'goals.clear',
        title: 'Goals: Clear Goal',
        category: 'Goals',
        namespace: 'palette',
        slashName: 'goal-clear',
        enabled: () => goal() !== null,
        run() {
          void clearGoal();
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather('goals.palette', [
      'goals.create',
      'goals.summary',
      'goals.pause_resume',
      'goals.clear',
    ]),
  });

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        const now = clock();
        const current = goal();
        if (!current || current.threadId !== props.session_id) {
          return (
            <box padding={1}>
              <text fg={api.theme.current.textMuted}>No active goal</text>
            </box>
          );
        }

        const statusColor =
          current.status === 'active'
            ? api.theme.current.success
            : current.status === 'budget_limited'
              ? api.theme.current.error
              : current.status === 'paused'
                ? api.theme.current.warning
                : api.theme.current.textMuted;

        const timeUsedSeconds = displayedTimeUsedSeconds(
          current,
          api.state.session.status(props.session_id),
          now
        );

        const statusIcon =
          current.status === 'active'
            ? '●'
            : current.status === 'paused'
              ? '⏸'
              : current.status === 'complete'
                ? '✓'
                : '⊘';

        return (
          <box padding={1} flexDirection="column" gap={1}>
            <text fg={statusColor}>
              <b>{statusIcon} GOAL</b>
            </text>
            <text fg={api.theme.current.text}>{truncate(current.objective, 40)}</text>
            {progressLine(current)}
            {current.tokenBudget !== null && (
              <text fg={api.theme.current.textMuted}>
                {budgetLine(current)}
              </text>
            )}
            <text fg={api.theme.current.textMuted}>
              {tokenBreakdownLine(current)}
            </text>
            <text fg={api.theme.current.textMuted}>
              {formatTime(timeUsedSeconds)}
            </text>
          </box>
        );
      },
      session_prompt_right(_ctx, props) {
        const now = clock();
        const current = goal();
        if (!current || current.threadId !== props.session_id || current.status !== 'active') {
          return null;
        }

        const timeUsedSeconds = displayedTimeUsedSeconds(
          current,
          api.state.session.status(props.session_id),
          now
        );

        return (
          <box flexDirection="row" gap={1}>
            <text fg={api.theme.current.success}>
              ● {truncate(current.objective, 30)}
            </text>
            <text fg={api.theme.current.textMuted}>
              {compactUsageLine(current, timeUsedSeconds)}
            </text>
          </box>
        );
      },
    },
  });

  const pollInterval = setInterval(() => {
    void fetchGoal();
  }, 1000);
  const clockInterval = setInterval(() => {
    setClock(Date.now());
  }, 1000);

  void fetchGoal();
  api.event.on('session.created', () => void fetchGoal());
  api.event.on('session.updated', () => void fetchGoal());
  api.event.on('session.status', () => void fetchGoal());
  api.event.on('session.idle', () => void fetchGoal());
  api.event.on('message.updated', (event: any) => {
    maybePauseAfterInterruptedEvent(event);
    void fetchGoal();
  });
  api.event.on('message.part.updated', (event: any) => {
    maybePauseAfterInterruptedEvent(event);
    void fetchGoal();
  });

  api.lifecycle.onDispose(() => {
    clearInterval(pollInterval);
    clearInterval(clockInterval);
  });

  async function createGoal(objective: string, tokenBudget: number | null): Promise<void> {
    try {
      const { sessionId, created } = await ensureGoalSession(objective);

      const existing = getThreadGoal(sessionId);
      if (existing) {
        confirmReplaceGoal(sessionId, objective, tokenBudget);
        return;
      }

      const next = createOrReplaceGoal(sessionId, objective, tokenBudget);
      const started = await startGoalTurnIfIdle(next).catch(() => false);
      await fetchGoal(sessionId);
      api.ui.toast({
        variant: 'success',
        message: started
          ? `${created ? 'Goal thread started' : 'Goal started'}: ${truncate(objective, 40)}`
          : `Goal created: ${truncate(objective, 40)}`,
        duration: 3000,
      });
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to create goal', duration: 3000 });
    }
  }

  async function togglePause(): Promise<void> {
    const current = goal();
    if (!current) return;

    try {
      if (current.status === 'active') {
        const paused = pauseActiveThreadGoal(current.threadId);
        if (!paused) {
          api.ui.toast({ variant: 'error', message: 'Goal could not be paused', duration: 2000 });
          return;
        }
        resumePrompted.add(current.threadId);
        await fetchGoal(current.threadId);
        api.ui.toast({
          variant: 'info',
          message: 'Goal paused. Auto-continuation stopped.',
          duration: 2500,
        });
        return;
      }

      await resumeGoal(current);
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to update goal', duration: 2000 });
    }
  }

  async function resumeGoal(current: GoalState): Promise<void> {
    const updated = updateThreadGoal(current.threadId, {
      status: 'active',
    });

    if (!updated || updated.status !== 'active') {
      api.ui.toast({
        variant: 'error',
        message: `Goal could not be resumed because it is ${updated?.status ?? current.status}`,
        duration: 3000,
      });
      await fetchGoal(current.threadId);
      return;
    }

    resumePrompted.delete(current.threadId);
    const started = await startGoalTurnIfIdle(updated).catch(() => false);
    await fetchGoal(current.threadId);
    api.ui.toast({
      variant: 'success',
      message: started ? 'Goal resumed and started' : 'Goal resumed',
      duration: 2500,
    });
  }

  async function clearGoal(): Promise<void> {
    const current = goal();
    if (!current) return;

    try {
      deleteThreadGoal(current.threadId);
      resumePrompted.delete(current.threadId);
      await fetchGoal(current.threadId);
      api.ui.toast({ variant: 'info', message: 'Goal cleared', duration: 2000 });
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to clear goal', duration: 2000 });
    }
  }

  function createOrReplaceGoal(
    sessionId: string,
    objective: string,
    tokenBudget: number | null
  ): ThreadGoal {
    validateThreadGoalObjective(objective);
    const next = replaceThreadGoal(sessionId, objective, 'active', tokenBudget);
    resumePrompted.delete(sessionId);
    return next;
  }

  async function startGoalTurnIfIdle(next: ThreadGoal): Promise<boolean> {
    const status = api.state.session.status(next.threadId);
    if (status && status.type !== 'idle') return false;

    const prompt = buildContinuationPrompt(next);
    const sessionClient = api.client.session as any;
    const payload = {
      sessionID: next.threadId,
      directory: api.state.path.directory,
      noReply: false,
      parts: [{ type: 'text', text: prompt }],
    };

    if (typeof sessionClient.promptAsync === 'function') {
      await sessionClient.promptAsync(payload);
    } else {
      await sessionClient.prompt(payload);
    }

    return true;
  }

  async function replaceExistingGoal(
    sessionId: string,
    objective: string,
    tokenBudget: number | null
  ): Promise<void> {
    try {
      const next = createOrReplaceGoal(sessionId, objective, tokenBudget);
      const started = await startGoalTurnIfIdle(next).catch(() => false);
      await fetchGoal(sessionId);
      api.ui.toast({
        variant: 'success',
        message: started
          ? `Goal replaced and started: ${truncate(objective, 40)}`
          : `Goal replaced: ${truncate(objective, 40)}`,
        duration: 3000,
      });
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to replace goal', duration: 3000 });
    }
  }

  function confirmReplaceGoal(sessionId: string, objective: string, tokenBudget: number | null): void {
    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title="Replace current goal?"
        message="This session already has a goal. Replacing it resets token and time accounting."
        onConfirm={() => {
          api.ui.dialog.clear();
          void replaceExistingGoal(sessionId, objective, tokenBudget);
        }}
        onCancel={() => {
          api.ui.dialog.clear();
        }}
      />
    ));
  }

  function maybePromptResume(current: GoalState | null): void {
    if (!current || current.status !== 'paused' || resumePrompted.has(current.threadId)) return;
    if (api.ui.dialog.open) return;

    resumePrompted.add(current.threadId);
    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title="Resume paused goal?"
        message={truncate(current.objective, 120)}
        onConfirm={() => {
          api.ui.dialog.clear();
          void resumeGoal(current);
        }}
        onCancel={() => {
          api.ui.dialog.clear();
        }}
      />
    ));
  }

  function showGoalSummary(): void {
    const current = goal();
    if (!current) {
      api.ui.dialog.replace(() => (
        <api.ui.DialogSelect
          title="Goal"
          options={[
            {
              title: 'Create Goal',
              value: 'create',
              onSelect: () => {
                api.ui.dialog.clear();
                openCreateDialog();
              },
            },
          ]}
          onSelect={(option) => option.onSelect?.()}
        />
      ));
      return;
    }

    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="Goal"
        options={[
          {
            title: truncate(current.objective, 70),
            value: 'status',
            description: `${current.status} | ${summaryUsageLine(current)} | ${formatTime(
              current.timeUsedSeconds
            )}`,
            disabled: true,
          },
          {
            title: current.status === 'active' ? 'Pause Goal' : 'Resume Goal',
            value: 'toggle',
            disabled: current.status === 'budget_limited',
            onSelect: () => {
              api.ui.dialog.clear();
              void togglePause();
            },
          },
          {
            title: 'Replace Goal',
            value: 'replace',
            onSelect: () => {
              api.ui.dialog.clear();
              openCreateDialog();
            },
          },
          {
            title: 'Clear Goal',
            value: 'clear',
            onSelect: () => {
              api.ui.dialog.clear();
              void clearGoal();
            },
          },
        ]}
        onSelect={(option) => option.onSelect?.()}
      />
    ));
  }

  function showGoalStatus(current: GoalState): void {
    const remaining =
      current.tokenBudget !== null
        ? Math.max(0, current.tokenBudget - current.tokensUsed)
        : null;

    api.ui.toast({
      variant: 'info',
      message: `${current.status.toUpperCase()}: ${current.objective}${
        remaining !== null ? ` · ${remaining} tokens remaining` : ''
      }`,
      duration: 5000,
    });
  }

  function progressLine(current: GoalState) {
    if (current.tokenBudget === null) return null;

    const pct = Math.min(100, Math.round((current.tokensUsed / current.tokenBudget) * 100));
    const barWidth = 16;
    const filled = Math.round((pct / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

    return (
      <box>
        <text>
          {bar} {pct}%
        </text>
      </box>
    );
  }

  function maybePauseAfterInterruptedEvent(event: any): void {
    const sessionId = event?.properties?.sessionID;
    if (typeof sessionId !== 'string') return;
    if (!isInterruptedEvent(event)) return;

    const paused = pauseActiveThreadGoal(sessionId);
    if (!paused) return;

    resumePrompted.add(sessionId);
    setGoalState(paused);
    api.ui.toast({
      variant: 'info',
      message: 'Goal paused after stop. Resume from /goal when ready.',
      duration: 3500,
    });
  }
};

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default plugin;

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

function parseOptionalTokenBudget(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const tokenBudget = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0 || String(tokenBudget) !== trimmed) {
    throw new Error('Token budget must be a positive integer, or blank for no budget');
  }

  return tokenBudget;
}

function budgetLine(goal: GoalState): string {
  if (goal.tokenBudget === null) return '';

  const pct = Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100));
  return `budget ${formatNumber(goal.tokensUsed)} / ${formatNumber(goal.tokenBudget)} (${pct}%)`;
}

export function tokenBreakdownLine(goal: GoalState): string {
  return [
    `input ${formatNumber(goal.inputTokensUsed)}`,
    `cached ${formatNumber(goal.cachedInputTokensUsed)}`,
    `output ${formatNumber(goal.outputTokensUsed)}`,
  ].join(' · ');
}

function summaryUsageLine(goal: GoalState): string {
  if (goal.tokenBudget !== null) {
    return `${budgetLine(goal)} | ${tokenBreakdownLine(goal)}`;
  }
  return tokenBreakdownLine(goal);
}

function compactUsageLine(goal: GoalState, timeUsedSeconds = goal.timeUsedSeconds): string {
  if (goal.tokenBudget !== null) return budgetLine(goal);
  return formatTime(timeUsedSeconds);
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export function displayedTimeUsedSeconds(
  goal: GoalState,
  sessionStatus: { type: string } | undefined,
  nowMs: number
): number {
  if (goal.status !== 'active') return goal.timeUsedSeconds;
  if (!sessionStatus || sessionStatus.type === 'idle') return goal.timeUsedSeconds;

  const liveDelta = Math.max(0, Math.floor((nowMs - goal.updatedAt) / 1000));
  return goal.timeUsedSeconds + liveDelta;
}

function isInterruptedEvent(event: any): boolean {
  const properties = event?.properties ?? {};
  if (isInterruptedPart(properties.part)) return true;
  return isAbortLikeError(properties.info?.error ?? properties.message?.error);
}

function isInterruptedPart(part: any): boolean {
  if (!part) return false;
  const state = part.state;
  return (
    state?.metadata?.interrupted === true ||
    state?.error === 'Tool execution aborted' ||
    part.errorText === '[Tool execution was interrupted]'
  );
}

function isAbortLikeError(error: any): boolean {
  if (!error) return false;
  const name = String(error.name ?? error.type ?? error.code ?? '');
  if (/abort|interrupt/i.test(name)) return true;

  const message = String(error.message ?? error.data?.message ?? '');
  return /abort|interrupt/i.test(message);
}

function sameGoal(left: GoalState | null, right: GoalState | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.threadId === right.threadId &&
    left.objective === right.objective &&
    left.status === right.status &&
    left.tokenBudget === right.tokenBudget &&
    left.tokensUsed === right.tokensUsed &&
    left.inputTokensUsed === right.inputTokensUsed &&
    left.cachedInputTokensUsed === right.cachedInputTokensUsed &&
    left.outputTokensUsed === right.outputTokensUsed &&
    left.timeUsedSeconds === right.timeUsedSeconds &&
    left.updatedAt === right.updatedAt
  );
}
