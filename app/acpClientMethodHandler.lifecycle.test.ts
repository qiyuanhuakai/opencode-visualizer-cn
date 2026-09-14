import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAcpClientMethodHandler } from '../bridge/acpClientMethodHandler.js';

const tempDirectories: string[] = [];

function registerSession(
  handler: ReturnType<typeof createAcpClientMethodHandler>,
  agentId: string,
  sessionId: string,
  cwd: string,
  requestId: number,
) {
  handler.observeClientMessage(
    { id: requestId, method: 'session/new', params: { cwd, additionalDirectories: [] } },
    { agentId },
  );
  handler.observeAgentMessage(
    { id: requestId, result: { sessionId } },
    { agentId },
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ACP client generation lifecycle', () => {
  it('releases one agent terminals, roots, and pending sessions without touching another agent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-acp-owner-'));
    tempDirectories.push(directory);
    const file = path.join(directory, 'context.txt');
    await writeFile(file, 'owned', 'utf8');
    const release = vi.fn(async () => ({}));
    const terminalManager = {
      create: vi.fn(async () => ({ terminalId: 'terminal-1' })),
      output: vi.fn(() => ({ output: '', truncated: false })),
      waitForExit: vi.fn(),
      kill: vi.fn(),
      release,
      stopAll: vi.fn(),
    };
    const handler = createAcpClientMethodHandler({ terminalManager });
    registerSession(handler, 'old-agent', 'old-session', directory, 1);
    registerSession(handler, 'other-agent', 'other-session', directory, 2);
    await handler(
      {
        id: 4,
        method: 'terminal/create',
        params: { sessionId: 'old-session', command: process.execPath, args: ['-e', ''] },
      },
      { agentId: 'old-agent' },
    );

    await handler.releaseAgent('old-agent');
    handler.observeClientMessage(
      { id: 3, method: 'session/new', params: { cwd: directory, additionalDirectories: [] } },
      { agentId: 'old-agent' },
    );
    handler.observeAgentMessage(
      { id: 3, result: { sessionId: 'late-session' } },
      { agentId: 'old-agent' },
    );

    expect(release).toHaveBeenCalledExactlyOnceWith('terminal-1');
    for (const sessionId of ['old-session', 'late-session']) {
      await expect(
        handler(
          { id: 5, method: 'fs/read_text_file', params: { sessionId, path: file } },
          { agentId: 'old-agent' },
        ),
      ).rejects.toThrow('ACP agent is not active');
    }
    await expect(
      handler(
        {
          id: 6,
          method: 'fs/read_text_file',
          params: { sessionId: 'other-session', path: file },
        },
        { agentId: 'other-agent' },
      ),
    ).resolves.toEqual({ content: 'owned' });
  });

  it('reclaims a terminal whose creation finishes after its agent was released', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-acp-owner-'));
    tempDirectories.push(directory);
    let finishCreate!: (value: { terminalId: string }) => void;
    const create = vi.fn(
      () => new Promise<{ terminalId: string }>((resolve) => {
        finishCreate = resolve;
      }),
    );
    const release = vi.fn(async () => ({}));
    const handler = createAcpClientMethodHandler({
      terminalManager: {
        create,
        output: vi.fn(),
        waitForExit: vi.fn(),
        kill: vi.fn(),
        release,
        stopAll: vi.fn(),
      },
    });
    registerSession(handler, 'old-agent', 'old-session', directory, 1);
    const creating = handler(
      {
        id: 2,
        method: 'terminal/create',
        params: { sessionId: 'old-session', command: process.execPath, args: ['-e', ''] },
      },
      { agentId: 'old-agent' },
    );
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

    await handler.releaseAgent('old-agent');
    finishCreate({ terminalId: 'late-terminal' });

    await expect(creating).rejects.toThrow('ACP agent is not active');
    expect(release).toHaveBeenCalledExactlyOnceWith('late-terminal');
  });

  it('retains terminal ownership when release fails so the same agent can retry', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-acp-owner-'));
    tempDirectories.push(directory);
    const release = vi
      .fn<() => Promise<object>>()
      .mockRejectedValueOnce(new Error('terminal tree survived'))
      .mockResolvedValueOnce({});
    const handler = createAcpClientMethodHandler({
      terminalManager: {
        create: vi.fn(async () => ({ terminalId: 'terminal-1' })),
        output: vi.fn(),
        waitForExit: vi.fn(),
        kill: vi.fn(),
        release,
        stopAll: vi.fn(),
      },
    });
    registerSession(handler, 'agent', 'session', directory, 1);
    await handler(
      {
        id: 2,
        method: 'terminal/create',
        params: { sessionId: 'session', command: process.execPath, args: ['-e', ''] },
      },
      { agentId: 'agent' },
    );

    await expect(handler.releaseAgent('agent')).rejects.toThrow('terminal tree survived');
    await expect(handler.releaseAgent('agent')).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenNthCalledWith(1, 'terminal-1');
    expect(release).toHaveBeenNthCalledWith(2, 'terminal-1');
  });

  it('stops all agent terminals and clears every pending session and root', async () => {
    // Given: two ACP agents own known roots, pending session creations, and terminals.
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-acp-owner-'));
    tempDirectories.push(directory);
    const file = path.join(directory, 'context.txt');
    await writeFile(file, 'owned', 'utf8');
    const stopAll = vi.fn(async () => ({}));
    const handler = createAcpClientMethodHandler({
      terminalManager: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ terminalId: 'terminal-a' })
          .mockResolvedValueOnce({ terminalId: 'terminal-b' }),
        output: vi.fn(() => ({ output: '', truncated: false })),
        waitForExit: vi.fn(),
        kill: vi.fn(),
        release: vi.fn(),
        stopAll,
      },
    });
    registerSession(handler, 'agent-a', 'session-a', directory, 1);
    registerSession(handler, 'agent-b', 'session-b', directory, 2);
    handler.observeClientMessage(
      { id: 3, method: 'session/new', params: { cwd: directory, additionalDirectories: [] } },
      { agentId: 'agent-a' },
    );
    handler.observeClientMessage(
      { id: 4, method: 'session/new', params: { cwd: directory, additionalDirectories: [] } },
      { agentId: 'agent-b' },
    );
    await handler(
      {
        id: 5,
        method: 'terminal/create',
        params: { sessionId: 'session-a', command: process.execPath, args: ['-e', ''] },
      },
      { agentId: 'agent-a' },
    );
    await handler(
      {
        id: 6,
        method: 'terminal/create',
        params: { sessionId: 'session-b', command: process.execPath, args: ['-e', ''] },
      },
      { agentId: 'agent-b' },
    );

    // When: the all-agent stop hook runs and an old pending session response arrives late.
    await handler.stopAll();
    handler.observeAgentMessage(
      { id: 3, result: { sessionId: 'late-session-a' } },
      { agentId: 'agent-a' },
    );
    handler.observeAgentMessage(
      { id: 4, result: { sessionId: 'late-session-b' } },
      { agentId: 'agent-b' },
    );

    // Then: the real terminal stop hook ran and every previous/pending root is gone.
    expect(stopAll).toHaveBeenCalledOnce();
    for (const [agentId, sessionId] of [
      ['agent-a', 'session-a'],
      ['agent-b', 'session-b'],
      ['agent-a', 'late-session-a'],
      ['agent-b', 'late-session-b'],
    ]) {
      await expect(
        handler(
          { id: 7, method: 'fs/read_text_file', params: { sessionId, path: file } },
          { agentId },
        ),
      ).rejects.toThrow(`ACP session roots are unknown: ${sessionId}`);
    }
    await expect(
      handler(
        {
          id: 8,
          method: 'terminal/output',
          params: { sessionId: 'session-a', terminalId: 'terminal-a' },
        },
        { agentId: 'agent-b' },
      ),
    ).resolves.toEqual({ output: '', truncated: false });
  });
});
