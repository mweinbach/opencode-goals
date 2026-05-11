import { expect, test } from 'bun:test';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, setDbPathForTests } from '../src/db/connection.js';
import { getThreadGoal } from '../src/db/goals.js';

ensureRuntimePluginSupport();

test('server plugin exports a server-only OpenCode module', async () => {
  const mod = await import('../src/index.ts');

  expect(mod.default.id).toBe('opencode-goals');
  expect(typeof mod.default.server).toBe('function');
  expect('tui' in mod.default).toBe(false);
});

test('tui plugin exports a tui-only OpenCode module', async () => {
  const mod = await import('../src/tui.tsx');

  expect(mod.default.id).toBe('opencode-goals-tui');
  expect(typeof mod.default.tui).toBe('function');
  expect('server' in mod.default).toBe(false);
});

test('tui plugin registers goal commands and host slots', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'opencode-goals-tui-test-'));
  setDbPathForTests(join(tempDir, 'goals.db'));

  const mod = await import('../src/tui.tsx');
  const layers: any[] = [];
  const slots: any[] = [];
  const disposers: Array<() => void> = [];

  const api = {
    route: {
      current: { name: 'home' },
    },
    client: {
      session: {
        list: async () => ({ data: [] }),
      },
    },
    state: {
      path: {
        directory: tempDir,
      },
    },
    tuiConfig: {
      keybinds: {
        gather: () => [],
      },
    },
    keymap: {
      registerLayer(layer: any) {
        layers.push(layer);
        return () => undefined;
      },
    },
    slots: {
      register(plugin: any) {
        slots.push(plugin);
        return 'test-slots';
      },
    },
    ui: {
      DialogPrompt: () => null,
      DialogConfirm: () => null,
      DialogSelect: () => null,
      dialog: {
        replace: () => undefined,
        clear: () => undefined,
        setSize: () => undefined,
        size: 'medium',
        depth: 0,
        open: false,
      },
      toast: () => undefined,
    },
    theme: {
      current: {
        textMuted: {},
        text: {},
        success: {},
        error: {},
        warning: {},
      },
    },
    event: {
      on: () => () => undefined,
    },
    lifecycle: {
      onDispose(fn: () => void) {
        disposers.push(fn);
        return () => undefined;
      },
    },
  };

  try {
    await mod.default.tui(api as any);

    const commands = layers.flatMap((layer) => layer.commands ?? []);
    expect(commands.map((command) => command.name)).toContain('goals.create');
    expect(commands.map((command) => command.name)).toContain('goals.summary');
    expect(commands.find((command) => command.name === 'goals.summary')?.slashName).toBe('goal');
    expect(commands.find((command) => command.name === 'goals.create')?.slashName).toBe(
      'goal-create'
    );
    expect(slots[0].slots.sidebar_content).toBeFunction();
    expect(slots[0].slots.session_prompt_right).toBeFunction();
  } finally {
    for (const dispose of disposers) dispose();
    closeDb();
    setDbPathForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('tui create goal opens a new session and starts the goal turn from home', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'opencode-goals-tui-create-test-'));
  setDbPathForTests(join(tempDir, 'goals.db'));

  const mod = await import('../src/tui.tsx');
  const layers: any[] = [];
  const disposers: Array<() => void> = [];
  const navigations: any[] = [];
  const sessionCreates: any[] = [];
  const prompts: any[] = [];
  const toasts: any[] = [];
  let promptConfirm: ((value: string) => void) | undefined;

  const api: any = {
    route: {
      current: { name: 'home' },
      navigate(name: string, params?: Record<string, unknown>) {
        navigations.push({ name, params });
        this.current = { name, params };
      },
    },
    client: {
      session: {
        create: async (input: unknown) => {
          sessionCreates.push(input);
          return { data: { id: 'new-session' } };
        },
        promptAsync: async (input: unknown) => {
          prompts.push(input);
          return {};
        },
      },
    },
    state: {
      path: {
        directory: tempDir,
      },
      session: {
        status: () => ({ type: 'idle' }),
      },
    },
    tuiConfig: {
      keybinds: {
        gather: () => [],
      },
    },
    keymap: {
      registerLayer(layer: any) {
        layers.push(layer);
        return () => undefined;
      },
    },
    slots: {
      register() {
        return 'test-slots';
      },
    },
    ui: {
      DialogPrompt: (props: any) => {
        promptConfirm = props.onConfirm;
        return null;
      },
      DialogConfirm: () => null,
      DialogSelect: () => null,
      dialog: {
        replace: (render: () => unknown) => {
          render();
        },
        clear: () => undefined,
        setSize: () => undefined,
        size: 'medium',
        depth: 0,
        open: false,
      },
      toast: (input: unknown) => {
        toasts.push(input);
      },
    },
    theme: {
      current: {
        textMuted: {},
        text: {},
        success: {},
        error: {},
        warning: {},
      },
    },
    event: {
      on: () => () => undefined,
    },
    lifecycle: {
      onDispose(fn: () => void) {
        disposers.push(fn);
        return () => undefined;
      },
    },
  };

  try {
    await mod.default.tui(api);

    const commands = layers.flatMap((layer) => layer.commands ?? []);
    commands.find((command) => command.name === 'goals.create')?.run();
    expect(promptConfirm).toBeFunction();

    promptConfirm?.('Write tests for goal creation');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionCreates).toHaveLength(1);
    expect(sessionCreates[0]).toMatchObject({
      directory: tempDir,
      title: 'Goal: Write tests for goal creation',
    });
    expect(navigations).toEqual([{ name: 'session', params: { sessionID: 'new-session' } }]);
    expect(getThreadGoal('new-session')?.objective).toBe('Write tests for goal creation');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      sessionID: 'new-session',
      directory: tempDir,
      noReply: false,
    });
    expect(prompts[0].parts[0].text).toContain(
      '<untrusted_objective>\nWrite tests for goal creation\n</untrusted_objective>'
    );
    expect(toasts[0]).toMatchObject({
      variant: 'success',
      message: 'Goal thread started: Write tests for goal creation',
    });
  } finally {
    for (const dispose of disposers) dispose();
    closeDb();
    setDbPathForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
