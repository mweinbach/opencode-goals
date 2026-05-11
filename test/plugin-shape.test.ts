import { expect, test } from 'bun:test';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';

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
