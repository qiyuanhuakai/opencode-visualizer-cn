import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcpClientMethodHandler } from '../bridge/acpClientMethodHandler.js';

const tempDirectories: string[] = [];

async function createWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-acp-client-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function registerSession(
  handler: ReturnType<typeof createAcpClientMethodHandler>,
  cwd: string,
  agentId = 'echo',
  sessionId = 'session-1',
  requestId = 1,
) {
  handler.observeClientMessage(
    {
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/new',
      params: { cwd, additionalDirectories: [] },
    },
    { agentId },
  );
  handler.observeAgentMessage(
    {
      jsonrpc: '2.0',
      id: requestId,
      result: { sessionId },
    },
    { agentId },
  );
}

describe('ACP client method handler', () => {
  it('reads and writes only inside roots registered by session/new', async () => {
    const workspace = await createWorkspace();
    const file = path.join(workspace, 'notes.txt');
    await writeFile(file, 'first\nsecond\nthird\n', 'utf8');
    const handler = createAcpClientMethodHandler();
    registerSession(handler, workspace);

    await expect(
      handler(
        {
          id: 2,
          method: 'fs/read_text_file',
          params: { sessionId: 'session-1', path: file, line: 2, limit: 1 },
        },
        { agentId: 'echo' },
      ),
    ).resolves.toEqual({ content: 'second' });
    await expect(
      handler(
        {
          id: 3,
          method: 'fs/write_text_file',
          params: { sessionId: 'session-1', path: file, content: 'updated' },
        },
        { agentId: 'echo' },
      ),
    ).resolves.toEqual({});
    await expect(readFile(file, 'utf8')).resolves.toBe('updated');

    await expect(
      handler(
        {
          id: 4,
          method: 'fs/read_text_file',
          params: { sessionId: 'session-1', path: path.join(workspace, '..', 'secret') },
        },
        { agentId: 'echo' },
      ),
    ).rejects.toThrow('outside the ACP session roots');
  });

  it('rejects writes through a final symlink that escapes the session root', async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    const outsideFile = path.join(outside, 'outside.txt');
    const link = path.join(workspace, 'linked.txt');
    await writeFile(outsideFile, 'protected', 'utf8');
    await symlink(outsideFile, link);
    const handler = createAcpClientMethodHandler();
    registerSession(handler, workspace);

    await expect(
      handler(
        {
          id: 10,
          method: 'fs/write_text_file',
          params: { sessionId: 'session-1', path: link, content: 'escaped' },
        },
        { agentId: 'echo' },
      ),
    ).rejects.toThrow('outside the ACP session roots');
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('protected');
  });

  it('implements the complete ACP terminal polling lifecycle', async () => {
    const workspace = await createWorkspace();
    const handler = createAcpClientMethodHandler();
    await expect(
      handler(
        {
          id: 4,
          method: 'terminal/create',
          params: { sessionId: 'unknown', command: process.execPath, args: ['-e', ''] },
        },
        { agentId: 'echo' },
      ),
    ).rejects.toThrow('ACP session roots are unknown');
    registerSession(handler, workspace);

    const created = await handler(
      {
        id: 5,
        method: 'terminal/create',
        params: {
          sessionId: 'session-1',
          command: process.execPath,
          args: ['-e', "process.stdout.write('terminal-ok')"],
          cwd: workspace,
          outputByteLimit: 1024,
        },
      },
      { agentId: 'echo' },
    );
    expect(created).toEqual({ terminalId: expect.any(String) });
    const terminalId = (created as { terminalId: string }).terminalId;

    await expect(
      handler(
        {
          id: 6,
          method: 'terminal/wait_for_exit',
          params: { sessionId: 'session-1', terminalId },
        },
        { agentId: 'echo' },
      ),
    ).resolves.toEqual({ exitCode: 0, signal: null });
    await expect(
      handler(
        {
          id: 7,
          method: 'terminal/output',
          params: { sessionId: 'session-1', terminalId },
        },
        { agentId: 'echo' },
      ),
    ).resolves.toEqual({
      output: 'terminal-ok',
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
    });
    await expect(
      handler(
        {
          id: 8,
          method: 'terminal/release',
          params: { sessionId: 'session-1', terminalId },
        },
        { agentId: 'echo' },
      ),
    ).resolves.toEqual({});
    await expect(
      handler(
        {
          id: 9,
          method: 'terminal/output',
          params: { sessionId: 'session-1', terminalId },
        },
        { agentId: 'echo' },
      ),
    ).rejects.toThrow('ACP terminal not found');
  });

  it('rejects terminal access from another agent or session', async () => {
    const workspace = await createWorkspace();
    const handler = createAcpClientMethodHandler();
    registerSession(handler, workspace);
    registerSession(handler, workspace, 'echo', 'session-2', 2);
    registerSession(handler, workspace, 'other', 'session-1', 3);
    const created = await handler(
      {
        id: 11,
        method: 'terminal/create',
        params: {
          sessionId: 'session-1',
          command: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 1000)'],
          cwd: workspace,
        },
      },
      { agentId: 'echo' },
    );
    const terminalId = (created as { terminalId: string }).terminalId;

    await expect(
      handler(
        {
          id: 12,
          method: 'terminal/output',
          params: { sessionId: 'session-2', terminalId },
        },
        { agentId: 'echo' },
      ),
    ).rejects.toThrow('does not belong to this ACP session');
    await expect(
      handler(
        {
          id: 13,
          method: 'terminal/output',
          params: { sessionId: 'session-1', terminalId },
        },
        { agentId: 'other' },
      ),
    ).rejects.toThrow('does not belong to this ACP session');
    await handler(
      {
        id: 14,
        method: 'terminal/release',
        params: { sessionId: 'session-1', terminalId },
      },
      { agentId: 'echo' },
    );
  });
  it('returns empty content for missing files inside the agent data dir but still errors for workspace misses', async () => {
    const workspace = await createWorkspace();
    const fakeHome = await createWorkspace();
    const handler = createAcpClientMethodHandler({ homeDir: fakeHome });
    registerSession(handler, workspace, 'kimi-code');

    // Transient plan artifact deleted after the turn: degrade to empty content.
    const missingPlan = path.join(fakeHome, '.kimi-code', 'sessions', 'wd_x', 'session_1', 'agents', 'main', 'plans', 'gone.md');
    await expect(
      handler(
        {
          id: 30,
          method: 'fs/read_text_file',
          params: { sessionId: 'session-1', path: missingPlan },
        },
        { agentId: 'kimi-code' },
      ),
    ).resolves.toEqual({ content: '' });

    // A missing file inside the workspace must surface an error (not silent empty).
    await expect(
      handler(
        {
          id: 31,
          method: 'fs/read_text_file',
          params: { sessionId: 'session-1', path: path.join(workspace, 'missing.txt') },
        },
        { agentId: 'kimi-code' },
      ),
    ).rejects.toThrow();
  });


  it('allows filesystem access inside the agent data directory but not for other agents', async () => {
    const workspace = await createWorkspace();
    const fakeHome = await createWorkspace();
    const planDir = path.join(fakeHome, '.kimi-code', 'sessions', 'wd_x', 'session_1', 'agents', 'main', 'plans');
    await mkdir(planDir, { recursive: true });
    const planFile = path.join(planDir, 'plan.md');
    await writeFile(planFile, 'plan-content', 'utf8');

    const handler = createAcpClientMethodHandler({ homeDir: fakeHome });
    registerSession(handler, workspace, 'kimi-code');
    registerSession(handler, workspace, 'other-agent', 'session-2', 2);

    await expect(
      handler(
        {
          id: 20,
          method: 'fs/read_text_file',
          params: { sessionId: 'session-1', path: planFile },
        },
        { agentId: 'kimi-code' },
      ),
    ).resolves.toEqual({ content: 'plan-content' });

    await expect(
      handler(
        {
          id: 21,
          method: 'fs/read_text_file',
          params: { sessionId: 'session-2', path: planFile },
        },
        { agentId: 'other-agent' },
      ),
    ).rejects.toThrow('outside the ACP session roots');
  });


});
