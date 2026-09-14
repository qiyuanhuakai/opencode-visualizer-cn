import { beforeEach, describe, expect, it } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { createAdapterMock, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('tracks tool parts from item/started notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Tool test.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
        },
      },
    });

    expect(api.realtimeToolParts.value).toHaveLength(1);
    expect(api.realtimeToolParts.value[0]?.part.type).toBe('tool');
    expect(api.realtimeToolParts.value[0]?.part.state.status).toBe('running');
  });

  it('marks realtime tool parts completed and writes them to realtime history on item completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Tool completion test.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
        },
      },
    });

    mock.emit({
      method: 'command/exec/outputDelta',
      params: { callId: 'cmd-1', delta: 'running output' },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
          aggregatedOutput: 'final output',
        },
      },
    });

    expect(api.realtimeToolParts.value).toHaveLength(0);
    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'cmd-1'),
    );
    expect(toolEntry).toBeDefined();
    const toolPart = toolEntry?.parts.find((part) => part.id === 'cmd-1');
    expect(toolPart).toMatchObject({ type: 'tool', state: { status: 'completed' } });
    expect(toolPart).toMatchObject({
      type: 'tool',
      state: { output: 'running outputfinal output' },
    });
  });

  it('replaces streamed command output with finalized output from the alternate delta method', async () => {
    // Given: a command is running and streams through item/commandExecution/outputDelta.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Finalize command output.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'command-delta',
          type: 'commandExecution',
          command: ['echo', 'ok'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'command-delta', delta: 'streamed command output' },
    });

    // When: the finalized item supplies canonical output without aggregatedOutput.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'command-delta',
          type: 'commandExecution',
          command: ['echo', 'ok'],
          cwd: '/repo',
          status: 'completed',
          output: 'canonical command output',
        },
      },
    });

    // Then: canonical output replaces the streamed fallback.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'command-delta');
    expect(toolPart).toMatchObject({
      state: { status: 'completed', output: 'canonical command output' },
    });
  });

  it('replaces streamed file output from item/fileChange/outputDelta', async () => {
    // Given: a file change is running and streams through its item-specific delta method.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Finalize file output.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'file-delta',
          type: 'fileChange',
          changes: [{ path: 'example.ts', diff: '' }],
        },
      },
    });
    mock.emit({
      method: 'item/fileChange/outputDelta',
      params: { itemId: 'file-delta', delta: 'streamed file output' },
    });

    // When: the finalized file change supplies its canonical diff.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'file-delta',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'example.ts', diff: 'canonical file output' }],
        },
      },
    });

    // Then: canonical file output replaces streamed output and metadata follows it.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'file-delta');
    expect(toolPart).toMatchObject({
      state: {
        status: 'completed',
        output: 'canonical file output',
        metadata: { filediff: { patch: 'canonical file output' } },
      },
    });
  });

  it('maps failed tool completion to error state instead of leaving tool loading forever', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Search the web');

    mock.emit({
      method: 'item/started',
      params: { item: { id: 'web-1', type: 'webSearch', query: 'vite docs' } },
    });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'web-1', type: 'webSearch', query: 'vite docs', status: 'failed' } },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'web-1'),
    );
    const toolPart = toolEntry?.parts.find((part) => part.id === 'web-1');
    expect(toolPart).toMatchObject({
      type: 'tool',
      state: {
        status: 'error',
        error: 'Query: vite docs',
        metadata: { source: 'codex', codexStatus: 'failed' },
      },
    });
    expect(api.realtimeToolParts.value).toHaveLength(0);
  });

  it('maps declined tool completion to error state with the wire status metadata', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Decline a tool.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-declined',
          type: 'commandExecution',
          command: ['rm', '-rf', '/tmp/example'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-declined',
          type: 'commandExecution',
          command: ['rm', '-rf', '/tmp/example'],
          cwd: '/repo',
          status: 'declined',
        },
      },
    });

    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'cmd-declined');
    expect(toolPart).toMatchObject({
      type: 'tool',
      state: {
        status: 'error',
        error: 'declined',
        metadata: { source: 'codex', codexStatus: 'declined' },
      },
    });
    expect(api.realtimeToolParts.value).toHaveLength(0);
  });

  it('replaces started fileChange shell parts with finalized edit metadata on completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Edit one file after start');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'edit-started-1',
          type: 'fileChange',
          changes: [{ path: 'empty.ts', diff: '' }],
        },
      },
    });

    expect(api.realtimeToolParts.value[0]?.part).toMatchObject({
      id: 'edit-started-1',
      tool: 'edit',
      state: { status: 'running' },
    });

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-started-1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'empty.ts', diff: '' }],
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'edit-started-1'),
    );
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-started-1');
    const expectedPatch =
      '## File changed\n\nPath: empty.ts\n\nStatus: completed\n\n(Codex did not provide a unified diff.)';
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'edit',
      state: {
        status: 'completed',
        input: { filePath: 'empty.ts', files: ['empty.ts'] },
        output: expectedPatch,
        metadata: { filediff: { patch: expectedPatch } },
      },
    });
  });

  it('replaces started webSearch shell parts with finalized completed output on completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Search after start');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'web-started-1',
          type: 'webSearch',
          query: '',
        },
      },
    });

    expect(api.realtimeToolParts.value[0]?.part).toMatchObject({
      id: 'web-started-1',
      tool: 'websearch',
      state: { status: 'running' },
    });

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'web-started-1',
          type: 'webSearch',
          status: 'completed',
          query: 'vite docs',
          action: { type: 'open', url: 'https://vite.dev' },
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'web-started-1'),
    );
    const toolPart = toolEntry?.parts.find((part) => part.id === 'web-started-1');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'websearch',
      state: {
        status: 'completed',
        input: { query: 'vite docs', action: 'open', url: 'https://vite.dev' },
        output: expect.stringContaining('Query: vite docs'),
      },
    });
  });

  it('maps completed single-file fileChange notifications into edit history entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Edit one file');

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'a.ts', diff: '@@ patch a' }],
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'edit-1'),
    );
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-1');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'edit',
      state: {
        status: 'completed',
        input: { filePath: 'a.ts', files: ['a.ts'] },
        metadata: { filediff: { patch: '@@ patch a' } },
      },
    });
  });

  it('maps completed multi-file fileChange notifications into multiedit history entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Edit two files');

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-2',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: 'a.ts', diff: '@@ patch a' },
            { path: 'b.ts', diff: '@@ patch b' },
          ],
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'edit-2'),
    );
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-2');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'multiedit',
      state: {
        status: 'completed',
        input: { filePath: 'a.ts', files: ['a.ts', 'b.ts'] },
        metadata: {
          results: [
            { path: 'a.ts', filediff: { patch: '@@ patch a' } },
            { path: 'b.ts', filediff: { patch: '@@ patch b' } },
          ],
        },
      },
    });
  });
});
