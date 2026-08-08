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
});
