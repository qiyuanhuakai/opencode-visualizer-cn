import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createFixture,
  installFixtureCleanup,
  isAlive,
  readHealthStatus,
  runCli,
  runCommandRequest,
  startFixture,
  waitForTextFile,
} from './visBridgeDaemonTestHarness';

installFixtureCleanup();

describe('vis_bridge daemon CLI', () => {
  it('keeps the legacy option-first invocation as daemon start', async () => {
    const fixture = await createFixture();
    const result = await runCli(
      ['--port', String(fixture.port), '--config', fixture.configPath],
      fixture.env,
    );

    expect(result.stdout).toContain('vis_bridge started');
    await expect(readHealthStatus(fixture.port)).resolves.toBe(200);
  });

  it('starts detached and reports an ACP startup failure when the bridge becomes ready', async () => {
    const fixture = await createFixture();
    const result = await startFixture(fixture);

    expect(result.stdout).toContain('vis_bridge started');
    expect(result.stderr).toContain('Broken ACP');
    await expect(readHealthStatus(fixture.port)).resolves.toBe(200);
    await runCli(['stop'], fixture.env);
  });

  it('reports an ACP process that exits shortly after it spawns', async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.configPath,
      `${JSON.stringify({
        version: 1,
        acpAgents: [{
          id: 'early-exit',
          name: 'Early Exit ACP',
          command: process.execPath,
          args: ['-e', "process.stderr.write('ACP boot failed'); setTimeout(() => process.exit(23), 50)"],
          enabled: true,
        }],
      })}\n`,
      'utf8',
    );

    const result = await startFixture(fixture);
    expect(result.stderr).toContain('Early Exit ACP: ACP boot failed');
    await expect(readHealthStatus(fixture.port)).resolves.toBe(200);
  });

  it('restarts with persisted launch options and replaces the daemon process', { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    await startFixture(fixture);
    const statePath = path.join(fixture.directory, 'state', 'daemon.json');
    const previousState: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    if (!previousState || typeof previousState !== 'object' || !('pid' in previousState)) {
      throw new Error('Expected the initial daemon state.');
    }

    const result = await runCli(['restart'], fixture.env);
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
    const fixture = await createFixture();
    await startFixture(fixture);
    const result = await runCli(['stop'], fixture.env);

    expect(result.stdout).toContain('vis_bridge stopped');
    await expect(readHealthStatus(fixture.port)).rejects.toThrow();
  });

  it('stops while a client keeps an incomplete HTTP request open', { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    await startFixture(fixture);
    const socket = connect(fixture.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      'POST /command/exec HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{',
    );

    try {
      const result = await runCli(['stop'], fixture.env);
      expect(result.stdout).toContain('vis_bridge stopped');
      await expect(readHealthStatus(fixture.port)).rejects.toThrow();
    } finally {
      socket.destroy();
    }
  });

  it('terminates a running workspace command tree during daemon stop', { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    await startFixture(fixture);
    const pidPath = path.join(fixture.directory, 'command.pid');
    const command = runCommandRequest(fixture.port, {
      command: process.execPath,
      args: [
        '-e',
        "const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
        pidPath,
      ],
    }).catch(() => undefined);
    const commandPid = Number.parseInt(await waitForTextFile(pidPath), 10);

    try {
      await runCli(['stop'], fixture.env);
      const deadline = Date.now() + 3_000;
      while (isAlive(commandPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isAlive(commandPid)).toBe(false);
      await command;
    } finally {
      if (isAlive(commandPid)) process.kill(commandPid, 'SIGKILL');
    }
  });
});
