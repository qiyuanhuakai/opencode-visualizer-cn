import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createBridgeConfigStore,
  createDefaultBridgeConfig,
  parseBridgeConfig,
} from '../bridge/bridgeConfig.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createConfigPath() {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-bridge-config-'));
  tempDirectories.push(directory);
  return path.join(directory, 'bridge.json');
}

describe('bridgeConfig', () => {
  it('provides ACP presets with verified launch commands', () => {
    expect(createDefaultBridgeConfig().acpAgents).toEqual([
      {
        id: 'pi',
        name: 'Pi',
        command: 'pi-acp',
        args: [],
        enabled: true,
      },
      {
        id: 'oh-my-pi',
        name: 'Oh My Pi',
        command: 'omp',
        args: ['--mode', 'acp'],
        enabled: true,
      },
      {
        id: 'kimi-code',
        name: 'Kimi Code',
        command: 'kimi',
        args: ['acp'],
        enabled: true,
      },
    ]);
  });

  it('persists agent updates atomically and reloads them', async () => {
    const configPath = await createConfigPath();
    const store = createBridgeConfigStore({ configPath });

    await store.load();
    await store.upsertAgent({
      id: 'oh-my-pi',
      name: 'Oh My Pi',
      command: 'omp',
      args: ['--mode', 'acp'],
      enabled: true,
    });

    const reloaded = await createBridgeConfigStore({ configPath }).load();
    expect(reloaded.acpAgents.find((agent: { id: string }) => agent.id === 'oh-my-pi')?.enabled).toBe(true);
    await expect(readFile(configPath, 'utf8')).resolves.toContain('"version": 1');
  });

  it('rejects malformed external config at the system boundary', () => {
    expect(() => parseBridgeConfig({
      version: 1,
      acpAgents: [{ id: 'broken', name: 'Broken', command: ' ', args: [], enabled: true }],
    })).toThrow('ACP agent command must not be empty');
  });
});
