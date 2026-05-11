import { expect, test } from 'bun:test';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, setDbPathForTests } from '../src/db/connection.js';

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
