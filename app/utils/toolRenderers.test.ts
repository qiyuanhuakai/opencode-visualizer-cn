import { describe, expect, it } from 'vitest';

import {
  extractFileRead,
  extractStepFinish,
  extractXmlTagContent,
} from './toolRenderers';

describe('extractXmlTagContent', () => {
  it('extracts content between tags', () => {
    expect(extractXmlTagContent('hello <foo>world</foo> bye', 'foo')).toBe('world');
  });

  it('trims extracted content', () => {
    expect(extractXmlTagContent('<foo>  spaced  </foo>', 'foo')).toBe('spaced');
  });

  it('returns null when open tag is missing', () => {
    expect(extractXmlTagContent('no tags here', 'foo')).toBeNull();
  });

  it('returns null when close tag is missing', () => {
    expect(extractXmlTagContent('<foo>incomplete', 'foo')).toBeNull();
  });

  it('returns null when close tag appears before open tag', () => {
    expect(extractXmlTagContent('</foo><foo> reversed', 'foo')).toBeNull();
  });
});

describe('extractStepFinish', () => {
  const helpers = {
    MESSAGE_EVENT_TYPES: new Set(['message.part.delta']),
  };

  it('returns null for non-object payload', () => {
    expect(extractStepFinish(null, 'message.part.delta', helpers)).toBeNull();
    expect(extractStepFinish('string', 'message.part.delta', helpers)).toBeNull();
  });

  it('returns null when event type is not in MESSAGE_EVENT_TYPES', () => {
    expect(extractStepFinish({}, 'other.event', helpers)).toBeNull();
  });

  it('extracts step-finish data from payload', () => {
    const payload = {
      payload: {
        properties: {
          part: {
            type: 'step-finish',
            reason: 'done',
            sessionID: 's1',
            messageID: 'm1',
          },
        },
      },
    };
    expect(extractStepFinish(payload, 'message.part.delta', helpers)).toEqual({
      reason: 'done',
      sessionId: 's1',
      messageId: 'm1',
    });
  });

  it('falls back to record.properties when nested payload is absent', () => {
    const payload = {
      properties: {
        part: {
          type: 'step-finish',
          reason: 'aborted',
          sessionID: 's2',
          messageID: 'm2',
        },
      },
    };
    expect(extractStepFinish(payload, 'message.part.delta', helpers)).toEqual({
      reason: 'aborted',
      sessionId: 's2',
      messageId: 'm2',
    });
  });

  it('returns null when part type is not step-finish', () => {
    const payload = {
      properties: {
        part: { type: 'other' },
      },
    };
    expect(extractStepFinish(payload, 'message.part.delta', helpers)).toBeNull();
  });
});

describe('extractFileRead for edit/multiedit', () => {
  const renderWorkerHtmlMock = async (_args?: Record<string, unknown>) => '<pre>rendered</pre>';
  const helpers = {
    FILE_READ_EVENT_TYPES: new Set<string>(),
    FILE_WRITE_EVENT_TYPES: new Set<string>(),
    MESSAGE_EVENT_TYPES: new Set(['message.part.updated']),
    parsePatchTextBlocks: () => [],
    guessLanguage: () => 'text',
    shouldRenderToolWindow: () => true,
    extractToolOutputText: (value: unknown) => (typeof value === 'string' ? value : undefined),
    formatToolValue: (value: unknown) => String(value ?? ''),
    renderWorkerHtml: renderWorkerHtmlMock,
    renderReadHtmlFromApi: async () => '<pre>read</pre>',
    resolveReadWritePath: (input?: Record<string, unknown>) => (typeof input?.filePath === 'string' ? input.filePath : ''),
    guessLanguageFromPath: () => 'text',
    resolveReadRange: () => ({}),
    renderEditDiffHtml: ({ patch, diff }: { patch?: string; diff: string }) => `DIFF:${patch ?? diff}`,
    formatGlobToolTitle: () => '',
    formatListToolTitle: () => '',
    formatWebfetchToolTitle: () => '',
    formatQueryToolTitle: () => '',
    formatTaskToolOutput: (value: string) => value,
    GrepContent: {},
    GlobContent: {},
    WebContent: {},
  };

  it('renders edit tool windows even when Codex diff text is missing', () => {
    const result = extractFileRead({
      payload: {
        properties: {
          part: {
            type: 'tool',
            id: 'edit-1',
            callID: 'edit-1',
            tool: 'edit',
            state: {
              status: 'completed',
              input: { filePath: 'empty.ts' },
              output: 'File changed: empty.ts',
              metadata: { filediff: { patch: 'File changed: empty.ts' } },
            },
          },
        },
      },
    }, 'message.part.updated', helpers, (key: string) => key);

    expect(result).toMatchObject({
      toolName: 'edit',
      title: '🔧 [toolTitles.edit] empty.ts',
      content: 'DIFF:File changed: empty.ts',
    });
  });

  it('renders multiedit entries with each file path in the title', () => {
    const result = extractFileRead({
      payload: {
        properties: {
          part: {
            type: 'tool',
            id: 'multiedit-1',
            callID: 'multiedit-1',
            tool: 'multiedit',
            state: {
              status: 'completed',
              input: { filePath: 'a.ts', files: ['a.ts', 'b.ts'] },
              output: 'File changed: a.ts\nFile changed: b.ts',
              metadata: {
                results: [
                  { path: 'a.ts', diff: 'File changed: a.ts', filediff: { patch: 'File changed: a.ts' } },
                  { path: 'b.ts', diff: 'File changed: b.ts', filediff: { patch: 'File changed: b.ts' } },
                ],
              },
            },
          },
        },
      },
    }, 'message.part.updated', helpers, (key: string) => key);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toMatchObject([
      { toolName: 'multiedit', title: '🔧 [toolTitles.edit] a.ts (1/2)', content: 'DIFF:File changed: a.ts' },
      { toolName: 'multiedit', title: '🔧 [toolTitles.edit] b.ts (2/2)', content: 'DIFF:File changed: b.ts' },
    ]);
  });

  it('renders completed read tools into floating-window content instead of returning null', async () => {
    const result = extractFileRead({
      payload: {
        properties: {
          part: {
            type: 'tool',
            id: 'read-1',
            callID: 'read-1',
            tool: 'read',
            state: {
              status: 'completed',
              input: { filePath: 'notes.md' },
              output: '# hello',
              title: 'read notes.md',
              metadata: { source: 'codex' },
            },
          },
        },
      },
    }, 'message.part.updated', helpers, (key: string) => key);

    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) throw new Error('Expected single read floating window result');
    expect(result).toMatchObject({
      toolName: 'read',
      title: '🔧 [toolTitles.read] notes.md',
      toolStatus: 'completed',
      variant: 'code',
    });
    const readContent = result.content;
    expect(typeof readContent).toBe('function');
    if (typeof readContent !== 'function') throw new Error('Expected read content renderer function');
    await expect(readContent()).resolves.toBe('<pre>read</pre>');
  });

  it('renders websearch markdown without copy-button chrome labels in the payload', async () => {
    let receivedArgs: Record<string, unknown> | null = null;
    const helpersWithCapture = {
      ...helpers,
      renderWorkerHtml: async (args: Record<string, unknown>) => {
        receivedArgs = args;
        return '<pre>search</pre>';
      },
    };

    const result = extractFileRead({
      payload: {
        properties: {
          part: {
            type: 'tool',
            id: 'web-1',
            callID: 'web-1',
            tool: 'websearch',
            state: {
              status: 'completed',
              input: { query: 'vite docs' },
              output: 'Result body',
              title: 'search vite docs',
              metadata: { source: 'codex' },
            },
          },
        },
      },
    }, 'message.part.updated', helpersWithCapture, (key: string) => key);

    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) throw new Error('Expected single websearch floating window result');
    const websearchContent = result.content;
    expect(typeof websearchContent).toBe('function');
    if (typeof websearchContent !== 'function') throw new Error('Expected websearch content renderer function');
    await expect(websearchContent()).resolves.toBe('<pre>search</pre>');
    expect(receivedArgs).toMatchObject({
      code: 'Result body',
      lang: 'markdown',
      copyButtonLabel: '',
      copiedLabel: '',
      copyCodeAriaLabel: '',
      copyMarkdownAriaLabel: '',
    });
  });

  it('renders webfetch markdown without copy-button chrome labels in the payload', async () => {
    let receivedArgs: Record<string, unknown> | null = null;
    const helpersWithCapture = {
      ...helpers,
      renderWorkerHtml: async (args: Record<string, unknown>) => {
        receivedArgs = args;
        return '<pre>fetch</pre>';
      },
    };

    const result = extractFileRead({
      payload: {
        properties: {
          part: {
            type: 'tool',
            id: 'fetch-1',
            callID: 'fetch-1',
            tool: 'webfetch',
            state: {
              status: 'completed',
              input: { url: 'https://vite.dev', format: 'markdown' },
              output: '# Vite',
              title: 'fetch vite',
              metadata: { source: 'codex' },
            },
          },
        },
      },
    }, 'message.part.updated', helpersWithCapture, (key: string) => key);

    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) throw new Error('Expected single webfetch floating window result');
    const webfetchContent = result.content;
    expect(typeof webfetchContent).toBe('function');
    if (typeof webfetchContent !== 'function') throw new Error('Expected webfetch content renderer function');
    await expect(webfetchContent()).resolves.toBe('<pre>fetch</pre>');
    expect(receivedArgs).toMatchObject({
      code: '# Vite',
      lang: 'markdown',
      copyButtonLabel: '',
      copiedLabel: '',
      copyCodeAriaLabel: '',
      copyMarkdownAriaLabel: '',
    });
  });
});
