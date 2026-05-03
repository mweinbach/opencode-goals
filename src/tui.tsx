import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui';
import { createSignal, createEffect } from 'solid-js';
import { getDb } from './db/connection.js';

const id = 'opencode-goals-tui';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GoalState {
  sessionId: string;
  objective: string;
  status: 'active' | 'paused' | 'budget_limited' | 'complete';
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

// ─── TUI Plugin ──────────────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  const [goal, setGoal] = createSignal<GoalState | null>(null);
  const [showGoalDialog, setShowGoalDialog] = createSignal(false);

  // ─── Goal Fetching ─────────────────────────────────────────────────────────

  async function fetchGoal() {
    try {
      // Access current session through api.state
      const sessions = await api.client.session.list();
      const currentSession = sessions.data?.find((s: any) => s.status === 'active');
      if (!currentSession?.id) {
        setGoal(null);
        return;
      }

      const db = getDb();
      const row = db
        .query(
          `SELECT session_id, objective, status, token_budget, tokens_used, time_used_seconds
           FROM session_goals WHERE session_id = ?`
        )
        .get(currentSession.id) as Record<string, unknown> | null;

      if (!row) {
        setGoal(null);
        return;
      }

      setGoal({
        sessionId: row.session_id as string,
        objective: row.objective as string,
        status: row.status as GoalState['status'],
        tokenBudget: row.token_budget !== null ? (row.token_budget as number) : null,
        tokensUsed: row.tokens_used as number,
        timeUsedSeconds: row.time_used_seconds as number,
      });
    } catch {
      setGoal(null);
    }
  }

  // Poll for goal updates every 2 seconds
  const pollInterval = setInterval(fetchGoal, 2000);
  fetchGoal();

  // Also update on session changes
  api.event.on('session.updated', fetchGoal);
  api.event.on('session.idle', fetchGoal);

  // ─── Sidebar Slot ──────────────────────────────────────────────────────────

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        const g = goal();
        if (!g) {
          return (
            <box padding={1}>
              <text fg={api.theme.current.textMuted}>No active goal</text>
            </box>
          );
        }

        const statusColor =
          g.status === 'active'
            ? api.theme.current.success
            : g.status === 'budget_limited'
              ? api.theme.current.error
              : g.status === 'paused'
                ? api.theme.current.warning
                : api.theme.current.textMuted;

        const statusIcon =
          g.status === 'active' ? '●' : g.status === 'paused' ? '⏸' : g.status === 'complete' ? '✓' : '⊘';

        // Token progress bar
        let progressBar = null;
        if (g.tokenBudget !== null) {
          const pct = Math.min(100, Math.round((g.tokensUsed / g.tokenBudget) * 100));
          const barWidth = 16;
          const filled = Math.round((pct / 100) * barWidth);
          const empty = barWidth - filled;
          const bar = '█'.repeat(filled) + '░'.repeat(empty);
          progressBar = (
            <box>
              <text>{bar} {pct}%</text>
            </box>
          );
        }

        const timeStr = formatTime(g.timeUsedSeconds);
        const tokenStr =
          g.tokenBudget !== null
            ? `${formatNumber(g.tokensUsed)} / ${formatNumber(g.tokenBudget)}`
            : `${formatNumber(g.tokensUsed)} tokens`;

        return (
          <box padding={1} flexDirection="column" gap={1}>
            <text fg={statusColor} bold>
              {statusIcon} GOAL
            </text>
            <text fg={api.theme.current.text} wrap>
              {truncate(g.objective, 40)}
            </text>
            {progressBar}
            <text fg={api.theme.current.textMuted} dim>
              {tokenStr}
            </text>
            <text fg={api.theme.current.textMuted} dim>
              ⏱ {timeStr}
            </text>
          </box>
        );
      },
    },
  });

  // ─── Footer Slot (Minimal) ─────────────────────────────────────────────────

  api.slots.register({
    order: 50,
    slots: {
      session_prompt() {
        const g = goal();
        if (!g || g.status !== 'active') return null;

        const budgetStr =
          g.tokenBudget !== null
            ? `${formatNumber(g.tokensUsed)} / ${formatNumber(g.tokenBudget)} tokens`
            : `${formatNumber(g.tokensUsed)} tokens`;

        return (
          <box flexDirection="row" gap={1}>
            <text fg={api.theme.current.success} dim>
              ● {truncate(g.objective, 30)}
            </text>
            <text fg={api.theme.current.textMuted} dim>
              · {budgetStr} · {formatTime(g.timeUsedSeconds)}
            </text>
          </box>
        );
      },
    },
  });

  // ─── Command Palette ───────────────────────────────────────────────────────

  api.command.register(() => {
    const g = goal();
    const commands: any[] = [];

    if (!g) {
      commands.push({
        title: 'Goals: Create Goal',
        value: 'goals.create',
        category: 'Goals',
        onSelect() {
          setShowGoalDialog(true);
        },
      });
    } else {
      commands.push(
        {
          title: `Goals: Show Status — ${truncate(g.objective, 30)}`,
          value: 'goals.status',
          category: 'Goals',
          onSelect() {
            showGoalStatus(g);
          },
        },
        {
          title: g.status === 'active' ? 'Goals: Pause Goal' : 'Goals: Resume Goal',
          value: g.status === 'active' ? 'goals.pause' : 'goals.resume',
          category: 'Goals',
          onSelect() {
            if (g.status === 'active') {
              pauseGoal(g.sessionId);
            } else {
              resumeGoal(g.sessionId);
            }
            fetchGoal();
          },
        },
        {
          title: 'Goals: Clear Goal',
          value: 'goals.clear',
          category: 'Goals',
          onSelect() {
            clearGoal(g.sessionId);
            fetchGoal();
          },
        }
      );
    }

    commands.push({
      title: 'Goals: List Archived',
      value: 'goals.list',
      category: 'Goals',
      onSelect() {
        showArchivedGoals();
      },
    });

    return commands;
  });

  // ─── Dialog: Create Goal ───────────────────────────────────────────────────

  // Watch for dialog state and show/hide
  createEffect(() => {
    if (showGoalDialog()) {
      api.ui.dialog.replace(() => (
        <api.ui.DialogPrompt
          title="Create Goal"
          placeholder="Enter objective..."
          onConfirm={(value: string) => {
            if (value.trim()) {
              createGoal(value.trim());
              setShowGoalDialog(false);
              fetchGoal();
            }
          }}
          onCancel={() => {
            setShowGoalDialog(false);
          }}
        />
      ));
    }
  });

  // ─── Event Listeners ───────────────────────────────────────────────────────

  api.event.on('session.created', fetchGoal);

  api.event.on('message.updated', (event: any) => {
    if (event.role === 'user') {
      fetchGoal();
    }
  });

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  api.lifecycle.onDispose(() => {
    clearInterval(pollInterval);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function showGoalStatus(g: GoalState) {
    const remaining =
      g.tokenBudget !== null ? Math.max(0, g.tokenBudget - g.tokensUsed) : null;

    api.ui.toast({
      variant: 'info',
      message: `${g.status.toUpperCase()}: ${g.objective}${remaining !== null ? ` · ${remaining} tokens remaining` : ''}`,
      duration: 5000,
    });
  }

  function showArchivedGoals() {
    try {
      const sessions = await api.client.session.list();
      const currentSession = sessions.data?.find((s: any) => s.status === 'active');
      if (!currentSession?.id) return;

      const db = getDb();
      const rows = db
        .query(
          `SELECT objective, status, archived_at_ms
           FROM goal_archive WHERE session_id = ? ORDER BY archived_at_ms DESC LIMIT 5`
        )
        .all(currentSession.id) as Array<Record<string, unknown>>;

      if (rows.length === 0) {
        api.ui.toast({ variant: 'info', message: 'No archived goals', duration: 3000 });
        return;
      }

      const lines = rows.map((r) => {
        const status = r.status as string;
        const icon = status === 'complete' ? '✓' : '⏸';
        return `${icon} ${truncate(r.objective as string, 35)}`;
      });

      api.ui.toast({
        variant: 'info',
        message: `Recent goals:\n${lines.join('\n')}`,
        duration: 5000,
      });
    } catch {
      // Silently fail
    }
  }

  async function createGoal(objective: string, budget?: number) {
    try {
      const sessions = await api.client.session.list();
      const currentSession = sessions.data?.find((s: any) => s.status === 'active');
      if (!currentSession?.id) return;

      const db = getDb();
      const now = Date.now();
      const goalId = `goal_${crypto.randomUUID()}`;

      // Archive existing
      const existing = db
        .query('SELECT * FROM session_goals WHERE session_id = ?')
        .get(currentSession.id) as Record<string, unknown> | null;

      if (existing) {
        db.run(
          `INSERT INTO goal_archive (session_id, directory, goal_id, objective, status, token_budget,
                                     tokens_used, time_used_seconds, created_at_ms, completed_at_ms, archived_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            existing.session_id,
            '',
            existing.goal_id,
            existing.objective,
            existing.status,
            existing.token_budget,
            existing.tokens_used,
            existing.time_used_seconds,
            existing.created_at_ms,
            existing.status === 'complete' ? existing.updated_at_ms : null,
            now,
          ]
        );
      }

      let status = 'active';
      if (budget !== undefined && budget <= 0) {
        status = 'budget_limited';
      }

      db.run(
        `INSERT INTO session_goals (session_id, directory, goal_id, objective, status, token_budget,
                                    tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           goal_id = excluded.goal_id,
           objective = excluded.objective,
           status = excluded.status,
           token_budget = excluded.token_budget,
           tokens_used = 0,
           time_used_seconds = 0,
           created_at_ms = excluded.created_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
        [currentSession.id, '', goalId, objective, status, budget ?? null, now, now]
      );

      api.ui.toast({
        variant: 'success',
        message: `Goal created: ${truncate(objective, 40)}`,
        duration: 3000,
      });
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to create goal', duration: 3000 });
    }
  }

  function pauseGoal(sessionId: string) {
    try {
      const db = getDb();
      db.run(
        "UPDATE session_goals SET status = 'paused', updated_at_ms = ? WHERE session_id = ? AND status = 'active'",
        [Date.now(), sessionId]
      );
      api.ui.toast({ variant: 'info', message: 'Goal paused', duration: 2000 });
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to pause goal', duration: 2000 });
    }
  }

  function resumeGoal(sessionId: string) {
    try {
      const db = getDb();
      db.run(
        "UPDATE session_goals SET status = 'active', updated_at_ms = ? WHERE session_id = ? AND status = 'paused'",
        [Date.now(), sessionId]
      );
      api.ui.toast({ variant: 'success', message: 'Goal resumed', duration: 2000 });
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to resume goal', duration: 2000 });
    }
  }

  function clearGoal(sessionId: string) {
    try {
      const db = getDb();
      const existing = db
        .query('SELECT * FROM session_goals WHERE session_id = ?')
        .get(sessionId) as Record<string, unknown> | null;

      if (existing) {
        const now = Date.now();
        db.run(
          `INSERT INTO goal_archive (session_id, directory, goal_id, objective, status, token_budget,
                                     tokens_used, time_used_seconds, created_at_ms, completed_at_ms, archived_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            existing.session_id,
            '',
            existing.goal_id,
            existing.objective,
            existing.status,
            existing.token_budget,
            existing.tokens_used,
            existing.time_used_seconds,
            existing.created_at_ms,
            now,
            now,
          ]
        );
      }

      db.run('DELETE FROM session_goals WHERE session_id = ?', [sessionId]);
      api.ui.toast({ variant: 'info', message: 'Goal cleared', duration: 2000 });
    } catch {
      api.ui.toast({ variant: 'error', message: 'Failed to clear goal', duration: 2000 });
    }
  }
};

export default {
  id,
  tui,
} as TuiPluginModule & { id: string };

// ─── Utilities ───────────────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
