import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolPart } from '../types/sse';
import { extractFileRead } from './toolRenderers';
import { resolveChildOwners, resolveThreadSubagentSessions } from './threadSubagents';
import { isHistoryToolName } from './toolNames';
import { collectMagicContextWorkers } from './pluginCompatibility';

const PARENT_SESSION_ID = 'ses-parent';

function makeTaskPart(
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): ToolPart {
  return {
    id: 'part-task',
    messageID: 'msg-assistant',
    sessionID: PARENT_SESSION_ID,
    type: 'tool',
    callID: 'call-task',
    tool: 'task',
    state: {
      status: 'running',
      input,
      metadata,
      time: { start: 1 },
    },
  };
}

const rendererHelpers = {
  FILE_READ_EVENT_TYPES: new Set<string>(),
  FILE_WRITE_EVENT_TYPES: new Set<string>(),
  MESSAGE_EVENT_TYPES: new Set(['message.part.updated']),
  parsePatchTextBlocks: () => [],
  guessLanguage: () => 'text',
  shouldRenderToolWindow: () => true,
  extractToolOutputText: (value: unknown) => (typeof value === 'string' ? value : undefined),
  formatToolValue: (value: unknown) => String(value ?? ''),
  renderWorkerHtml: vi.fn(async () => '<pre>rendered</pre>'),
  renderReadHtmlFromApi: async () => '<pre>read</pre>',
  resolveReadWritePath: () => '',
  guessLanguageFromPath: () => 'text',
  resolveReadRange: () => ({}),
  renderEditDiffHtml: ({ diff }: { diff: string }) => diff,
  formatGlobToolTitle: () => '',
  formatListToolTitle: () => '',
  formatWebfetchToolTitle: () => '',
  formatQueryToolTitle: () => '',
  formatTaskToolOutput: (value: string) => value,
  GrepContent: {},
  GlobContent: {},
  WebContent: {},
};

describe('plugin subagent compatibility', () => {
  it('preserves the task title while adding the category to Sisyphus-Junior', () => {
    const task = makeTaskPart(
      { category: 'quick', description: 'Browser QA category worker' },
      { sessionId: 'ses-category-worker' },
    );

    expect(
      resolveThreadSubagentSessions([task], PARENT_SESSION_ID, {
        'ses-category-worker': {
          parentID: PARENT_SESSION_ID,
          label: 'Browser QA category worker (@Sisyphus-Junior subagent)',
        },
      }),
    ).toEqual([
      {
        sessionId: 'ses-category-worker',
        label: 'Browser QA category worker (@Sisyphus-Junior(quick) subagent)',
      },
    ]);
  });

  it('updates only the final subagent marker when the title also mentions Sisyphus-Junior', () => {
    const task = makeTaskPart(
      { category: 'quick', description: 'Investigate Sisyphus-Junior failures' },
      { sessionId: 'ses-category-worker' },
    );

    expect(
      resolveThreadSubagentSessions([task], PARENT_SESSION_ID, {
        'ses-category-worker': {
          parentID: PARENT_SESSION_ID,
          label: 'Investigate Sisyphus-Junior failures (@Sisyphus-Junior(old) subagent)',
        },
      }),
    ).toEqual([
      {
        sessionId: 'ses-category-worker',
        label: 'Investigate Sisyphus-Junior failures (@Sisyphus-Junior(quick) subagent)',
      },
    ]);
  });

  it('excludes magic-context workers from exact and fallback thread cards', () => {
    const exactTask = makeTaskPart({}, { sessionId: 'ses-mc-exact' });
    const meta = {
      'ses-mc-exact': { parentID: PARENT_SESSION_ID, label: 'magic-context-reviewer' },
      'ses-mc-fallback': { parentID: PARENT_SESSION_ID, label: 'magic-context-historian' },
    };

    expect(resolveThreadSubagentSessions([exactTask], PARENT_SESSION_ID, meta)).toEqual([]);
    expect(
      resolveChildOwners(
        [{ rootId: 'root', parts: [makeTaskPart({ description: 'other' }, {})] }],
        PARENT_SESSION_ID,
        meta,
      ),
    ).toEqual({});
  });

  it('collects known canonical states only from the selected root session', () => {
    const meta = {
      root: { label: 'Root session', status: 'idle' as const },
      nestedParent: {
        parentID: 'root',
        label: 'Sisyphus-Junior',
        status: 'idle' as const,
      },
      unknown: { parentID: 'root', label: 'magic-context-unknown' },
      idle: { parentID: 'root', label: 'magic-context-historian', status: 'idle' as const },
      retry: {
        parentID: 'nestedParent',
        label: 'magic-context-recomp',
        status: 'retry' as const,
      },
      busy: { parentID: 'root', label: 'magic-context-reviewer', status: 'busy' as const },
      otherRoot: { label: 'Other root', status: 'idle' as const },
      unrelated: {
        parentID: 'otherRoot',
        label: 'magic-context-unrelated',
        status: 'busy' as const,
      },
    };

    expect(
      collectMagicContextWorkers(meta, 'root'),
    ).toEqual([
      { sessionId: 'busy', name: 'magic-context-reviewer', status: 'busy' },
      { sessionId: 'retry', name: 'magic-context-recomp', status: 'retry' },
      { sessionId: 'idle', name: 'magic-context-historian', status: 'idle' },
    ]);
  });
});

describe.each([
  'lsp_diagnostics',
  'codegraph_codegraph_explore',
  'ctx_search',
])('plugin tool compatibility: %s', (tool) => {
  beforeEach(() => {
    vi.mocked(rendererHelpers.renderWorkerHtml).mockClear();
  });

  it('keeps the tool available from thread history', () => {
    expect(isHistoryToolName(tool)).toBe(true);
  });

  it('renders completed output in a generic floating window', async () => {
    const result = extractFileRead(
      {
        payload: {
          properties: {
            part: {
              type: 'tool',
              callID: `call-${tool}`,
              tool,
              state: {
                status: 'completed',
                input: { query: 'status' },
                output: 'plugin output',
                metadata: {},
              },
            },
          },
        },
      },
      'message.part.updated',
      rendererHelpers,
      (key: string) => key,
    );

    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) throw new Error('Expected plugin tool window');
    expect(result).toMatchObject({ toolName: tool, toolStatus: 'completed', variant: 'plain' });
    expect(result.title).toContain(tool);
    expect(typeof result.content).toBe('function');
    if (typeof result.content !== 'function') throw new Error('Expected rendered content');
    await expect(result.content()).resolves.toBe('<pre>rendered</pre>');
    expect(rendererHelpers.renderWorkerHtml).toHaveBeenCalledWith(
      expect.objectContaining({ copyButtons: false }),
    );
  });
});
