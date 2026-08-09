import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createFixture,
  installFixtureCleanup,
  readHealthStatus,
  reservePort,
  runCli,
  startFixture,
} from './visBridgeDaemonTestHarness';

installFixtureCleanup();

const credentialNames = [
  'VIS_BRIDGE_DAEMON_CONTROL_TOKEN',
  'VIS_BRIDGE_TOKEN',
  'VIS_BRIDGE_CODEX_TOKEN',
  'VIS_BRIDGE_CODEX_TOKEN_FILE',
  'VIS_BRIDGE_CODEX_AUTHORIZATION',
] as const;

function credentialProbeScript(outputPath: string) {
  return `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(${JSON.stringify(credentialNames)}.map((name) => process.env[name] ?? null)))`;
}

async function readCredentialProbe(outputPath: string) {
  let values: unknown;
  await vi.waitFor(async () => {
    values = JSON.parse(await readFile(outputPath, 'utf8')) as unknown;
    expect(values).toEqual(credentialNames.map(() => null));
  });
  return values;
}

function postJson(port: number, pathname: string, token: string, body: object) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const httpRequest = request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      }));
    });
    httpRequest.once('error', reject);
    httpRequest.end(payload);
  });
}

describe('vis_bridge daemon security and fatal startup', { timeout: 15_000 }, () => {
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

  it('keeps bridge credentials out of command, PTY, and ACP child environments', async () => {
    const fixture = await createFixture();
    const bridgeToken = 'child-environment-bridge-secret';
    const upstreamAuthorization = 'Bearer child-environment-upstream-secret';
    const acpProbePath = path.join(fixture.directory, 'acp-environment.json');
    const ptyProbePath = path.join(fixture.directory, 'pty-environment.json');
    const tokenFilePath = path.join(fixture.directory, 'upstream-token.txt');
    await writeFile(tokenFilePath, 'child-environment-token-file-secret', 'utf8');
    await writeFile(fixture.configPath, JSON.stringify({
      version: 1,
      acpAgents: [{
        id: 'environment-probe',
        name: 'Environment probe',
        command: process.execPath,
        args: ['-e', credentialProbeScript(acpProbePath)],
        enabled: true,
      }],
    }), 'utf8');
    const environment = {
      ...fixture.env,
      VIS_BRIDGE_TOKEN: bridgeToken,
      VIS_BRIDGE_CODEX_TOKEN: 'child-environment-codex-token',
      VIS_BRIDGE_CODEX_TOKEN_FILE: tokenFilePath,
      VIS_BRIDGE_CODEX_AUTHORIZATION: upstreamAuthorization,
    };
    await runCli(
      ['start', '--port', String(fixture.port), '--config', fixture.configPath],
      environment,
    );
    await expect(readHealthStatus(fixture.port, bridgeToken)).resolves.toBe(200);
    if (process.platform === 'linux') {
      const state = JSON.parse(
        await readFile(path.join(fixture.directory, 'state', 'daemon.json'), 'utf8'),
      ) as { pid: number };
      const daemonEnvironment = await readFile(`/proc/${state.pid}/environ`, 'utf8');
      for (const name of credentialNames) expect(daemonEnvironment).not.toContain(`${name}=`);
    }

    const commandResponse = await postJson(fixture.port, '/command/exec', bridgeToken, {
        command: process.execPath,
        args: ['-e', `process.stdout.write(JSON.stringify(${JSON.stringify(credentialNames)}.map((name) => process.env[name] ?? null)))`],
    });
    expect(commandResponse.status).toBe(200);
    const commandResult = commandResponse.body as { stdout?: string };
    expect(JSON.parse(commandResult.stdout ?? '')).toEqual(credentialNames.map(() => null));

    const ptyResponse = await postJson(fixture.port, '/pty', bridgeToken, {
        command: process.execPath,
        args: ['-e', credentialProbeScript(ptyProbePath)],
    });
    expect(ptyResponse.status).toBe(200);
    await readCredentialProbe(ptyProbePath);
    await readCredentialProbe(acpProbePath);

    expect(upstreamAuthorization).toContain('child-environment-upstream-secret');
  }, 15_000);

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
