import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const workspacePath = path.resolve(import.meta.dirname, '..');
const entryPath = path.join(workspacePath, 'vis_bridge.js');
const temporaryDirectories: string[] = [];
const fixtureEnvironments: NodeJS.ProcessEnv[] = [];

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port.');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-bridge-daemon-test-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'bridge.json');
  await writeFile(
    configPath,
    `${JSON.stringify({
      version: 1,
      acpAgents: [
        {
          id: 'broken-acp',
          name: 'Broken ACP',
          command: 'vis-definitely-missing-acp',
          args: [],
          enabled: true,
        },
      ],
    })}\n`,
    'utf8',
  );
  const fixture = {
    directory,
    configPath,
    port: await reservePort(),
    env: { ...process.env, VIS_BRIDGE_STATE_DIR: path.join(directory, 'state') },
  };
  fixtureEnvironments.push(fixture.env);
  return fixture;
}

afterEach(async () => {
  await Promise.allSettled(
    fixtureEnvironments.splice(0).map((env) =>
      execFileAsync(process.execPath, [entryPath, 'stop'], { cwd: workspacePath, env }),
    ),
  );
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function readHealthStatus(port: number) {
  return new Promise<number | undefined>((resolve, reject) => {
    const healthRequest = request(
      { host: '127.0.0.1', port, path: '/healthz', method: 'GET' },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    healthRequest.once('error', reject);
    healthRequest.end();
  });
}

function runCli(arguments_: string[], env: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, [entryPath, ...arguments_], {
    cwd: workspacePath,
    env,
  });
}

async function startFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return runCli(
    ['start', '--port', String(fixture.port), '--config', fixture.configPath],
    fixture.env,
  );
}

describe('vis_bridge daemon CLI', () => {
  it('starts detached and reports an ACP startup failure when the bridge becomes ready', async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = await startFixture(fixture);

    // Then
    expect(result.stdout).toContain('vis_bridge started');
    expect(result.stderr).toContain('Broken ACP');
    await expect(readHealthStatus(fixture.port)).resolves.toBe(200);

    await runCli(['stop'], fixture.env);
  });

  it('restarts with the persisted launch options and replaces the daemon process', { timeout: 15_000 }, async () => {
    // Given
    const fixture = await createFixture();
    await startFixture(fixture);
    const statePath = path.join(fixture.directory, 'state', 'daemon.json');
    const previousState: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    if (!previousState || typeof previousState !== 'object' || !('pid' in previousState)) {
      throw new Error('Expected the initial daemon state.');
    }

    // When
    const result = await runCli(['restart'], fixture.env);

    // Then
    const nextState: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    if (!nextState || typeof nextState !== 'object' || !('pid' in nextState)) {
      throw new Error('Expected the restarted daemon state.');
    }
    expect(result.stdout).toContain('vis_bridge stopped');
    expect(result.stdout).toContain('vis_bridge started');
    expect(nextState.pid).not.toBe(previousState.pid);
    await expect(readHealthStatus(fixture.port)).resolves.toBe(200);
  });

  it('stops the detached daemon through the authenticated control channel', async () => {
    // Given
    const fixture = await createFixture();
    await startFixture(fixture);

    // When
    const result = await runCli(['stop'], fixture.env);

    // Then
    expect(result.stdout).toContain('vis_bridge stopped');
    await expect(readHealthStatus(fixture.port)).rejects.toThrow();
  });

  it('rejects start with different options while the authenticated daemon is running', async () => {
    // Given
    const fixture = await createFixture();
    await startFixture(fixture);
    const differentPort = await reservePort();

    // When
    const secondStart = runCli(
      ['start', '--port', String(differentPort), '--config', fixture.configPath],
      fixture.env,
    );

    // Then
    await expect(secondStart).rejects.toMatchObject({
      stderr: expect.stringContaining('use vis_bridge restart'),
    });
    await expect(readHealthStatus(fixture.port)).resolves.toBe(200);
    await expect(readHealthStatus(differentPort)).rejects.toThrow();
  });

  it('returns the configuration startup error instead of publishing a ready daemon', async () => {
    // Given
    const fixture = await createFixture();
    await writeFile(fixture.configPath, '{', 'utf8');

    // When
    const startup = runCli(
      ['start', '--port', String(fixture.port), '--config', fixture.configPath],
      fixture.env,
    );

    // Then
    await expect(startup).rejects.toMatchObject({
      stderr: expect.stringContaining('JSON'),
    });
    await expect(readHealthStatus(fixture.port)).rejects.toThrow();
    const state: unknown = JSON.parse(
      await readFile(path.join(fixture.directory, 'state', 'daemon.json'), 'utf8'),
    );
    expect(state).toMatchObject({
      state: 'error',
      error: expect.stringContaining('JSON'),
    });
  });

  it('returns the listen error when the requested bridge port is occupied', async () => {
    // Given
    const fixture = await createFixture();
    const blocker = createServer();
    blocker.listen(fixture.port, '127.0.0.1');
    await new Promise<void>((resolve) => blocker.once('listening', resolve));

    // When
    const startup = runCli(
      ['start', '--port', String(fixture.port), '--config', fixture.configPath],
      fixture.env,
    );

    // Then
    await expect(startup).rejects.toMatchObject({ stderr: expect.stringContaining('EADDRINUSE') });
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
});
