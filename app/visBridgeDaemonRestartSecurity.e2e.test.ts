import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createFixture,
  installFixtureCleanup,
  readHealthStatus,
  runCli,
} from './visBridgeDaemonTestHarness';

installFixtureCleanup();

describe('vis_bridge daemon restart credential security', { timeout: 15_000 }, () => {
  it('preserves persisted options when restart supplies only credentials', async () => {
    const fixture = await createFixture();
    const environment = { ...fixture.env, VIS_BRIDGE_TOKEN: 'restart-environment-token' };
    await runCli(
      ['start', '--port', String(fixture.port), '--config', fixture.configPath],
      environment,
    );

    const result = await runCli(['restart'], environment);
    const state = JSON.parse(
      await readFile(path.join(fixture.directory, 'state', 'daemon.json'), 'utf8'),
    ) as { launchArgs: string[] };
    expect(result.stdout).toContain('vis_bridge started');
    expect(state.launchArgs).toContain(`--port=${fixture.port}`);
    expect(state.launchArgs).toContain(`--config=${fixture.configPath}`);
    await expect(readHealthStatus(fixture.port, 'restart-environment-token')).resolves.toBe(200);
  });

  it('restarts from a persisted upstream token-file without resupplying its path', async () => {
    const fixture = await createFixture();
    const tokenPath = path.join(fixture.directory, 'restart-upstream-token');
    await writeFile(tokenPath, 'restart-file-token\n', 'utf8');
    await runCli([
      'start',
      '--port',
      String(fixture.port),
      '--config',
      fixture.configPath,
      '--upstream-token-file',
      tokenPath,
    ], fixture.env);

    const result = await runCli(['restart'], fixture.env);
    const stateText = await readFile(path.join(fixture.directory, 'state', 'daemon.json'), 'utf8');
    expect(result.stdout).toContain('vis_bridge started');
    expect(stateText).toContain(`--upstream-token-file=${tokenPath}`);
    expect(stateText).not.toContain('restart-file-token');
    await expect(readHealthStatus(fixture.port)).resolves.toBe(200);
  });
});
