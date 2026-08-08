import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createFixture,
  installFixtureCleanup,
  readHealthStatus,
  reservePort,
  runCli,
  startFixture,
} from './visBridgeDaemonTestHarness';

installFixtureCleanup();

describe('vis_bridge daemon security and fatal startup', () => {
  it('keeps direct authentication tokens out of daemon state and process arguments', async () => {
    const fixture = await createFixture();
    const bridgeToken = 'bridge-token-sentinel';
    const upstreamToken = 'upstream-token-sentinel';
    await runCli([
      'start',
      '--port',
      String(fixture.port),
      '--config',
      fixture.configPath,
      '--bridge-token',
      bridgeToken,
      '--upstream-token',
      upstreamToken,
    ], fixture.env);

    const stateText = await readFile(path.join(fixture.directory, 'state', 'daemon.json'), 'utf8');
    expect(stateText).not.toContain(bridgeToken);
    expect(stateText).not.toContain(upstreamToken);
    await expect(readHealthStatus(fixture.port, bridgeToken)).resolves.toBe(200);
    if (process.platform === 'linux') {
      const state: unknown = JSON.parse(stateText);
      if (!state || typeof state !== 'object' || !('pid' in state) || typeof state.pid !== 'number') {
        throw new Error('Expected a daemon PID in state.');
      }
      const commandLine = await readFile(`/proc/${state.pid}/cmdline`, 'utf8');
      expect(commandLine).not.toContain(bridgeToken);
      expect(commandLine).not.toContain(upstreamToken);
    }
  });

  it('rejects a second start when its effective bridge token changed', async () => {
    const fixture = await createFixture();
    await runCli([
      'start',
      '--port',
      String(fixture.port),
      '--config',
      fixture.configPath,
      '--bridge-token',
      'old-token',
    ], fixture.env);

    await expect(runCli([
      'start',
      '--port',
      String(fixture.port),
      '--config',
      fixture.configPath,
      '--bridge-token',
      'new-token',
    ], fixture.env)).rejects.toMatchObject({ stderr: expect.stringContaining('different options') });
    await expect(readHealthStatus(fixture.port, 'old-token')).resolves.toBe(200);
    await expect(readHealthStatus(fixture.port, 'new-token')).resolves.toBe(401);
  });

  it('rejects a second start when an environment bridge token changed', async () => {
    const fixture = await createFixture();
    const initialEnvironment = { ...fixture.env, VIS_BRIDGE_TOKEN: 'old-environment-token' };
    await runCli(
      ['start', '--port', String(fixture.port), '--config', fixture.configPath],
      initialEnvironment,
    );

    await expect(runCli(
      ['start', '--port', String(fixture.port), '--config', fixture.configPath],
      { ...initialEnvironment, VIS_BRIDGE_TOKEN: 'new-environment-token' },
    )).rejects.toMatchObject({ stderr: expect.stringContaining('different options') });
    await expect(readHealthStatus(fixture.port, 'old-environment-token')).resolves.toBe(200);
    await expect(readHealthStatus(fixture.port, 'new-environment-token')).resolves.toBe(401);
  });

  it('refuses unattended restart after direct token options were removed from state', async () => {
    const fixture = await createFixture();
    await runCli([
      'start',
      '--port',
      String(fixture.port),
      '--config',
      fixture.configPath,
      '--bridge-token',
      'restart-token-sentinel',
    ], fixture.env);

    await expect(runCli(['restart'], fixture.env)).rejects.toMatchObject({
      stderr: expect.stringContaining('requires the original direct token options'),
    });
    await expect(readHealthStatus(fixture.port)).resolves.toBe(401);
  });

  it('rejects start with different options while the authenticated daemon is running', async () => {
    const fixture = await createFixture();
    await startFixture(fixture);
    const differentPort = await reservePort();

    await expect(runCli(
      ['start', '--port', String(differentPort), '--config', fixture.configPath],
      fixture.env,
    )).rejects.toMatchObject({ stderr: expect.stringContaining('use vis_bridge restart') });
    await expect(readHealthStatus(fixture.port)).resolves.toBe(200);
    await expect(readHealthStatus(differentPort)).rejects.toThrow();
  });

  it('returns the configuration startup error instead of publishing a ready daemon', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.configPath, '{', 'utf8');

    await expect(runCli(
      ['start', '--port', String(fixture.port), '--config', fixture.configPath],
      fixture.env,
    )).rejects.toMatchObject({ stderr: expect.stringContaining('JSON') });
    await expect(readHealthStatus(fixture.port)).rejects.toThrow();
    const state: unknown = JSON.parse(
      await readFile(path.join(fixture.directory, 'state', 'daemon.json'), 'utf8'),
    );
    expect(state).toMatchObject({ state: 'error', error: expect.stringContaining('JSON') });
  });

  it('returns the listen error when the requested bridge port is occupied', async () => {
    const fixture = await createFixture();
    const blocker = createServer();
    blocker.listen(fixture.port, '127.0.0.1');
    await new Promise<void>((resolve) => blocker.once('listening', resolve));

    await expect(runCli(
      ['start', '--port', String(fixture.port), '--config', fixture.configPath],
      fixture.env,
    )).rejects.toMatchObject({ stderr: expect.stringContaining('EADDRINUSE') });
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
});
