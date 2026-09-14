import { beforeEach, describe, expect, it } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { ToolStatePending } from '../types/sse';
import { createAdapterMock, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('falls back to running output while preserving finalized title and metadata', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Complete a tool with streamed output.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-fallback',
          type: 'commandExecution',
          command: ['printf', 'ok'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'command/exec/outputDelta',
      params: { callId: 'cmd-fallback', delta: 'streamed output' },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-fallback',
          type: 'commandExecution',
          command: ['printf', 'ok'],
          cwd: '/repo',
          status: 'completed',
        },
      },
    });

    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'cmd-fallback');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        output: 'streamed output',
        title: 'printf ok',
        metadata: { source: 'codex', codexStatus: 'completed' },
      },
    });
  });

  it('uses running title and metadata when a completed item has no canonical tool part', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Complete a forward-compatible tool.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'future-tool',
          type: 'commandExecution',
          command: ['echo', 'fallback'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'future-tool',
          type: 'futureTool',
          status: 'completed',
          aggregatedOutput: 'future output',
        },
      },
    });

    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'future-tool');
    expect(toolPart).toMatchObject({
      type: 'tool',
      state: {
        status: 'completed',
        output: 'future output',
        title: 'echo fallback',
        metadata: { source: 'codex', codexStatus: 'completed' },
      },
    });
  });

  it('preserves failed and declined status when completion has no canonical tool part', async () => {
    // Given: both tools are running, but completion uses an unknown item type.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Complete tools without canonical parts.');

    for (const id of ['future-failed', 'future-declined'] as const) {
      mock.emit({
        method: 'item/started',
        params: {
          item: { id, type: 'commandExecution', command: ['echo', id], cwd: '/repo' },
        },
      });
    }

    // When: the server reports terminal failures that the normalizer does not know yet.
    for (const [id, status] of [
      ['future-failed', 'failed'],
      ['future-declined', 'declined'],
    ] as const) {
      mock.emit({
        method: 'item/completed',
        params: { item: { id, type: 'futureTool', status } },
      });
    }

    // Then: the running record still becomes an error with the wire status preserved.
    for (const [id, status] of [
      ['future-failed', 'failed'],
      ['future-declined', 'declined'],
    ] as const) {
      const toolPart = api.realtimeHistoryQueue.value
        .flatMap((entry) => entry.parts)
        .find((part) => part.id === id);
      expect(toolPart).toMatchObject({
        type: 'tool',
        state: { status: 'error', error: status, metadata: { codexStatus: status } },
      });
    }
  });

  it('keeps default error and live-completed metadata fallbacks on the public path', async () => {
    // Given: a live completed record without metadata and a live error record without metadata.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Exercise terminal fallbacks.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'live-completed',
          type: 'commandExecution',
          command: ['echo', 'live'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'live-error',
          type: 'commandExecution',
          command: ['echo', 'error'],
          cwd: '/repo',
        },
      },
    });

    const liveCompleted = api.realtimeToolParts.value.find(
      (entry) => entry.part.id === 'live-completed',
    );
    const liveError = api.realtimeToolParts.value.find((entry) => entry.part.id === 'live-error');
    if (!liveCompleted || !liveError) throw new Error('Expected live tool records');
    const completedState = {
      status: 'completed',
      input: {},
      output: 'live output',
      title: 'live title',
      metadata: { source: 'codex' },
      time: { start: 1, end: 2 },
    } satisfies Extract<typeof liveCompleted.part.state, { status: 'completed' }>;
    const errorState = {
      status: 'error',
      input: {},
      error: '',
      metadata: { source: 'codex' },
      time: { start: 1, end: 2 },
    } satisfies Extract<typeof liveError.part.state, { status: 'error' }>;
    Reflect.deleteProperty(completedState, 'metadata');
    Reflect.deleteProperty(errorState, 'metadata');
    api.realtimeToolParts.value = [
      { ...liveCompleted, part: { ...liveCompleted.part, state: completedState } },
      { ...liveError, part: { ...liveError.part, state: errorState } },
    ];

    // When: completion arrives without a canonical part, output, or wire status.
    for (const id of ['live-completed', 'live-error'] as const) {
      mock.emit({ method: 'item/completed', params: { item: { id, type: 'futureTool' } } });
    }

    // Then: completed metadata uses the source fallback and errors use the default message.
    const parts = api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts);
    expect(parts.find((part) => part.id === 'live-completed')).toMatchObject({
      state: {
        status: 'completed',
        output: 'live output',
        title: 'live title',
        metadata: { source: 'codex' },
      },
    });
    expect(parts.find((part) => part.id === 'live-error')).toMatchObject({
      state: { status: 'error', error: 'Codex tool failed', metadata: { source: 'codex' } },
    });
  });

  it('uses safe public completion fallbacks for absent and malformed running metadata', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Exercise running metadata fallbacks.');

    for (const id of ['missing-running-metadata', 'malformed-running-metadata'] as const) {
      mock.emit({
        method: 'item/started',
        params: { item: { id, type: 'commandExecution', command: ['echo', id], cwd: '/repo' } },
      });
    }
    const missing = api.realtimeToolParts.value.find(
      (entry) => entry.part.id === 'missing-running-metadata',
    );
    const malformed = api.realtimeToolParts.value.find(
      (entry) => entry.part.id === 'malformed-running-metadata',
    );
    if (
      !missing ||
      !malformed ||
      missing.part.state.status !== 'running' ||
      malformed.part.state.status !== 'running'
    ) {
      throw new Error('Expected running tool records');
    }
    const missingState = { ...missing.part.state };
    Reflect.deleteProperty(missingState, 'metadata');
    api.realtimeToolParts.value = api.realtimeToolParts.value.map((entry) =>
      entry.part.id === missing.part.id
        ? { ...entry, part: { ...entry.part, state: missingState } }
        : entry.part.id === malformed.part.id
          ? {
              ...entry,
              part: {
                ...entry.part,
                state: {
                  ...entry.part.state,
                  metadata: { output: 42, codexStatus: { bad: true } },
                },
              },
            }
          : entry,
    );

    for (const id of ['missing-running-metadata', 'malformed-running-metadata'] as const) {
      mock.emit({ method: 'item/completed', params: { item: { id, type: 'futureTool' } } });
    }

    const parts = api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts);
    expect(parts.find((part) => part.id === 'missing-running-metadata')).toMatchObject({
      state: { status: 'completed', output: '', metadata: { source: 'codex' } },
    });
    expect(parts.find((part) => part.id === 'malformed-running-metadata')).toMatchObject({
      state: {
        status: 'completed',
        output: '',
        metadata: { output: 42, codexStatus: { bad: true } },
      },
    });
  });

  it('falls back to completion time and empty output for pending public tool state', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Exercise pending completion fallback.');
    mock.emit({
      method: 'item/started',
      params: {
        item: { id: 'pending-tool', type: 'commandExecution', command: ['echo', 'pending'] },
      },
    });
    const pending = api.realtimeToolParts.value.find((entry) => entry.part.id === 'pending-tool');
    if (!pending) throw new Error('Expected pending tool record');
    const pendingState = {
      status: 'pending',
      input: pending.part.state.input,
      raw: 'pending',
    } satisfies ToolStatePending;
    api.realtimeToolParts.value = api.realtimeToolParts.value.map((entry) =>
      entry.part.id === 'pending-tool'
        ? { ...entry, part: { ...entry.part, state: pendingState } }
        : entry,
    );

    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'pending-tool', type: 'futureTool' } },
    });

    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'pending-tool');
    expect(toolPart).toMatchObject({
      state: {
        status: 'completed',
        output: '',
        title: 'bash',
        time: { start: expect.any(Number) },
      },
    });
  });

  it('prefers finalized title over the running title', async () => {
    // Given: a running command has an initial title.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Finalize the command title.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'title-final',
          type: 'commandExecution',
          command: ['echo', 'running'],
          cwd: '/repo',
        },
      },
    });

    // When: completion supplies a different canonical command title.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'title-final',
          type: 'commandExecution',
          command: ['echo', 'finalized'],
          cwd: '/repo',
          status: 'completed',
        },
      },
    });

    // Then: the finalized title wins.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'title-final');
    expect(toolPart).toMatchObject({ state: { status: 'completed', title: 'echo finalized' } });
  });

  it('uses finalized input in the error branch', async () => {
    // Given: a file change is running with an initial input path.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Fail a file change.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'input-error',
          type: 'fileChange',
          changes: [{ path: 'started.ts', diff: '' }],
        },
      },
    });

    // When: the failed completion supplies its final input path.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'input-error',
          type: 'fileChange',
          status: 'failed',
          changes: [{ path: 'final.ts', diff: '' }],
        },
      },
    });

    // Then: error state input comes from the finalized part.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'input-error');
    expect(toolPart).toMatchObject({
      state: { status: 'error', input: { files: ['final.ts'], filePath: 'final.ts' } },
    });
  });

  it('concatenates streamed and finalized output before applying error status', async () => {
    // Given: streamed output is attached to a running command with a failed wire status.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Fail after streamed output.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'output-error',
          type: 'commandExecution',
          command: ['echo', 'error'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'command/exec/outputDelta',
      params: { callId: 'output-error', delta: 'streamed error output' },
    });
    const running = api.realtimeToolParts.value.find((entry) => entry.part.id === 'output-error');
    if (!running || running.part.state.status !== 'running')
      throw new Error('Expected running tool');
    const runningState = running.part.state;
    api.realtimeToolParts.value = api.realtimeToolParts.value.map((entry) =>
      entry.part.id === 'output-error'
        ? {
            ...entry,
            part: {
              ...entry.part,
              state: {
                ...runningState,
                metadata: { ...runningState.metadata, codexStatus: 'failed' },
              },
            },
          }
        : entry,
    );

    // When: completion supplies finalized output without a status field.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'output-error',
          type: 'commandExecution',
          command: ['echo', 'error'],
          cwd: '/repo',
          aggregatedOutput: 'finalized error output',
        },
      },
    });

    // Then: the error message preserves the same output precedence as success.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'output-error');
    expect(toolPart).toMatchObject({
      state: { status: 'error', error: 'streamed error outputfinalized error output' },
    });
  });

  it('preserves the running time.start through completion', async () => {
    // Given: a running command with an observable start time.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Preserve tool timing.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'time-start',
          type: 'commandExecution',
          command: ['echo', 'time'],
          cwd: '/repo',
        },
      },
    });
    const running = api.realtimeToolParts.value.find((entry) => entry.part.id === 'time-start');
    if (!running || running.part.state.status !== 'running')
      throw new Error('Expected running tool');
    const start = running.part.state.time.start;

    // When: the command completes normally.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'time-start',
          type: 'commandExecution',
          command: ['echo', 'time'],
          cwd: '/repo',
          status: 'completed',
        },
      },
    });

    // Then: completion keeps the original start timestamp.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'time-start');
    expect(toolPart).toMatchObject({ state: { status: 'completed', time: { start } } });
  });
});
