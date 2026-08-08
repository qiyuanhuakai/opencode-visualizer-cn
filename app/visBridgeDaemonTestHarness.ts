import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach } from 'vitest';

const execFileAsync = promisify(execFile);
const workspacePath = path.resolve(import.meta.dirname, '..');
const entryPath = path.join(workspacePath, 'vis_bridge.js');
const temporaryDirectories: string[] = [];
const fixtureEnvironments: NodeJS.ProcessEnv[] = [];

export type DaemonFixture = {
  readonly directory: string;
  readonly configPath: string;
  readonly port: number;
  readonly env: NodeJS.ProcessEnv;
};

export async function reservePort() {
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

export async function createFixture(): Promise<DaemonFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-bridge-daemon-test-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'bridge.json');
  await writeFile(
    configPath,
    `${JSON.stringify({
      version: 1,
      acpAgents: [{
        id: 'broken-acp',
        name: 'Broken ACP',
        command: 'vis-definitely-missing-acp',
        args: [],
        enabled: true,
      }],
    })}\n`,
    'utf8',
  );
  const fixture: DaemonFixture = {
    directory,
    configPath,
    port: await reservePort(),
    env: { ...process.env, VIS_BRIDGE_STATE_DIR: path.join(directory, 'state') },
  };
  fixtureEnvironments.push(fixture.env);
  return fixture;
}

export function installFixtureCleanup() {
  afterEach(async () => {
    await Promise.allSettled(
      fixtureEnvironments.splice(0).map((env) =>
        execFileAsync(process.execPath, [entryPath, 'stop'], { cwd: workspacePath, env }),
      ),
    );
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });
}

export function readHealthStatus(port: number, bridgeToken?: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const healthRequest = request({
      host: '127.0.0.1',
      port,
      path: '/healthz',
      method: 'GET',
      ...(bridgeToken ? { headers: { Authorization: `Bearer ${bridgeToken}` } } : {}),
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    healthRequest.once('error', reject);
    healthRequest.end();
  });
}

export function runCommandRequest(port: number, payload: object) {
  return new Promise<void>((resolve, reject) => {
    const body = JSON.stringify(payload);
    const commandRequest = request({
      host: '127.0.0.1',
      port,
      path: '/command/exec',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    commandRequest.once('error', reject);
    commandRequest.end(body);
  });
}

export function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForTextFile(filePath: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

export function runCli(arguments_: string[], env: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, [entryPath, ...arguments_], { cwd: workspacePath, env });
}

export function startFixture(fixture: DaemonFixture) {
  return runCli(
    ['start', '--port', String(fixture.port), '--config', fixture.configPath],
    fixture.env,
  );
}
