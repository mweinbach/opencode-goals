/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui';
import { createSignal } from 'solid-js';
import { initializeSchema } from './db/schema.js';
import {
  deleteThreadGoal,
  getThreadGoal,
  replaceThreadGoal,
  updateThreadGoal,
} from './db/goals.js';
import { buildContinuationPrompt } from './prompts/builders.js';
import { validateThreadGoalObjective } from './types.js';
import type { ThreadGoal } from './types.js';

const id = 'opencode-goals-tui';

type GoalState = Pick<
  ThreadGoal,
  'threadId' | 'objective' | 'status' | 'tokenBudget' | 'tokensUsed' | 'timeUsedSeconds'
>;

const tui: TuiPlugin = async (api) => {
  initializeSchema();

  const [goal, setGoal] = createSignal<GoalState | null>(null);
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
          api.ui.dialog.clear();
          void createGoal(objective);
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
            <text fg={api.theme.current.textMuted}>
              {tokenLine(current)}
            </text>
            <text fg={api.theme.current.textMuted}>
              {formatTime(current.timeUsedSeconds)}
            </text>
          </box>
        );
      },
      session_prompt_right(_ctx, props) {
        const current = goal();
        if (!current || current.threadId !== props.session_id || current.status !== 'active') {
          return null;
        }

        return (
          <box flexDirection="row" gap={1}>
            <text fg={api.theme.current.success}>
              ● {truncate(current.objective, 30)}
            </text>
            <text fg={api.theme.current.textMuted}>
              {compactUsageLine(current)}
            </text>
          </box>
        );
      },
    },
  });

  const pollInterval = setInterval(() => {
    void fetchGoal();
  }, 2000);

  void fetchGoal();
  api.event.on('session.created', () => void fetchGoal());
  api.event.on('session.updated', () => void fetchGoal());
  api.event.on('session.idle', () => void fetchGoal());
  api.event.on('message.updated', () => void fetchGoal());

  api.lifecycle.onDispose(() => {
    clearInterval(pollInterval);
  });

  async function createGoal(objective: string): Promise<void> {
    try {
      const { sessionId, created } = await ensureGoalSession(objective);

      const existing = getThreadGoal(sessionId);
      if (existing) {
        confirmReplaceGoal(sessionId, objective);
        return;
      }

      const next = createOrReplaceGoal(sessionId, objective);
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
      updateThreadGoal(current.threadId, {
        status: current.status === 'active' ? 'paused' : 'active',
      });
      await fetchGoal(current.threadId);
      api.ui.toast({
        variant: current.status === 'active' ? 'info' : 'success',
        message: current.status === 'active' ? 'Goal paused' : 'Goal resumed',
        duration: 2000,
      });
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to update goal', duration: 2000 });
    }
  }

  async function clearGoal(): Promise<void> {
    const current = goal();
    if (!current) return;

    try {
      deleteThreadGoal(current.threadId);
      await fetchGoal(current.threadId);
      api.ui.toast({ variant: 'info', message: 'Goal cleared', duration: 2000 });
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to clear goal', duration: 2000 });
    }
  }

  function createOrReplaceGoal(sessionId: string, objective: string): ThreadGoal {
    validateThreadGoalObjective(objective);
    const next = replaceThreadGoal(sessionId, objective, 'active', null);
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

  async function replaceExistingGoal(sessionId: string, objective: string): Promise<void> {
    try {
      const next = createOrReplaceGoal(sessionId, objective);
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

  function confirmReplaceGoal(sessionId: string, objective: string): void {
    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title="Replace current goal?"
        message="This session already has a goal. Replacing it resets token and time accounting."
        onConfirm={() => {
          api.ui.dialog.clear();
          void replaceExistingGoal(sessionId, objective);
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
          updateThreadGoal(current.threadId, {
            status: 'active',
          });
          void fetchGoal(current.threadId);
          api.ui.dialog.clear();
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
            description: `${current.status} | ${tokenLine(current)} | ${formatTime(
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

function tokenLine(goal: GoalState): string {
  if (goal.tokenBudget !== null) {
    return `${formatNumber(goal.tokensUsed)} / ${formatNumber(goal.tokenBudget)} tokens`;
  }
  return `${formatNumber(goal.tokensUsed)} tokens`;
}

function compactUsageLine(goal: GoalState): string {
  if (goal.tokenBudget !== null) return tokenLine(goal);
  return formatTime(goal.timeUsedSeconds);
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

function sameGoal(left: GoalState | null, right: GoalState | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.threadId === right.threadId &&
    left.objective === right.objective &&
    left.status === right.status &&
    left.tokenBudget === right.tokenBudget &&
    left.tokensUsed === right.tokensUsed &&
    left.timeUsedSeconds === right.timeUsedSeconds
  );
}
