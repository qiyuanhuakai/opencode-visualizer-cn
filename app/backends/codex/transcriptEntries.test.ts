import { describe, expect, it, vi } from 'vitest';
import { extractItemTranscriptEntries } from './transcriptEntries';

type ExpectedEntry = {
  role: 'user' | 'assistant' | 'system';
  text: string;
};

const createTestEntry = () => {
  let nextId = 1;
  return vi.fn((role: ExpectedEntry['role'], text: string) => ({
    id: nextId++,
    role,
    text,
    time: 123,
    modelName: 'test-model',
  }));
};

describe('extractItemTranscriptEntries', () => {
  it.each([
    {
      name: 'user messages',
      item: { type: 'userMessage', content: [{ type: 'text', text: 'user prompt' }] },
      expected: [{ role: 'user', text: 'user prompt' }],
    },
    {
      name: 'agent messages',
      item: { type: 'agentMessage', text: 'agent answer' },
      expected: [{ role: 'assistant', text: 'agent answer' }],
    },
    {
      name: 'plans',
      item: { type: 'plan', text: 'plan text' },
      expected: [{ role: 'system', text: 'plan text' }],
    },
    {
      name: 'command executions',
      item: {
        type: 'commandExecution',
        command: ['pnpm', 'test'],
        cwd: '/repo',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'passed',
      },
      expected: [
        {
          role: 'system',
          text: '$ pnpm test\ncwd: /repo\nstatus: completed\nexit code: 0\n\npassed',
        },
      ],
    },
    {
      name: 'file changes',
      item: {
        type: 'fileChange',
        changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
        status: 'completed',
      },
      expected: [
        {
          role: 'system',
          text: 'File changes (2):\n  src/a.ts\n  src/b.ts\nstatus: completed',
        },
      ],
    },
    {
      name: 'reasoning',
      item: { type: 'reasoning', summary: 'reasoning text' },
      expected: [{ role: 'system', text: 'Reasoning: reasoning text' }],
    },
    {
      name: 'entered review mode',
      item: { type: 'enteredReviewMode', review: 'current changes' },
      expected: [{ role: 'system', text: 'Entered review mode: current changes' }],
    },
    {
      name: 'exited review mode',
      item: { type: 'exitedReviewMode', review: 'current changes' },
      expected: [{ role: 'system', text: 'Review: current changes' }],
    },
    {
      name: 'web searches',
      item: {
        type: 'webSearch',
        query: 'codex',
        action: { type: 'open', query: 'docs', url: 'https://example.test' },
      },
      expected: [
        {
          role: 'system',
          text: 'Web search: codex\naction: open\nquery: docs\nurl: https://example.test',
        },
      ],
    },
    {
      name: 'image views',
      item: { type: 'imageView', path: '/tmp/image.png' },
      expected: [{ role: 'system', text: 'Image: /tmp/image.png' }],
    },
    {
      name: 'MCP tool calls',
      item: {
        type: 'mcpToolCall',
        server: 'docs',
        tool: 'search',
        arguments: { query: 'codex' },
        status: 'completed',
      },
      expected: [
        {
          role: 'system',
          text: 'Tool call: docs.search\narguments:\n{\n  "query": "codex"\n}\nstatus: completed',
        },
      ],
    },
    {
      name: 'dynamic tool calls',
      item: { type: 'dynamicToolCall', tool: 'lookup', status: 'completed' },
      expected: [{ role: 'system', text: 'Tool call: lookup\nstatus: completed' }],
    },
    {
      name: 'collaboration tool calls',
      item: { type: 'collabToolCall', tool: 'delegate', status: 'completed' },
      expected: [{ role: 'system', text: 'Tool call: delegate\nstatus: completed' }],
    },
    {
      name: 'context compaction',
      item: { type: 'contextCompaction' },
      expected: [{ role: 'system', text: 'Context compaction completed' }],
    },
  ])('maps documented $name items', ({ item, expected }) => {
    // Given: one documented Codex item and a deterministic entry factory.
    const createEntry = createTestEntry();

    // When: the production mapper receives the item.
    const result = extractItemTranscriptEntries(item, createEntry);

    // Then: it preserves the exact role/text and factory-owned metadata.
    expect(result).toEqual(
      expected.map((entry, index) => ({
        ...entry,
        id: index + 1,
        time: 123,
        modelName: 'test-model',
      })),
    );
    expect(createEntry.mock.calls).toEqual(expected.map(({ role, text }) => [role, text]));
  });

  it.each([
    { name: 'non-record values', item: null, expected: [] },
    { name: 'arrays', item: [], expected: [] },
    { name: 'missing type', item: {}, expected: [] },
    { name: 'unknown type', item: { type: 'unknownItem', text: 'ignored' }, expected: [] },
    {
      name: 'user messages without text',
      item: { type: 'userMessage', content: [{ type: 'image', path: '/tmp/image.png' }] },
      expected: [],
    },
    { name: 'empty agent messages', item: { type: 'agentMessage', text: '' }, expected: [] },
    { name: 'empty plans', item: { type: 'plan', text: '' }, expected: [] },
    { name: 'empty command executions', item: { type: 'commandExecution' }, expected: [] },
    {
      name: 'empty file changes',
      item: { type: 'fileChange', changes: [] },
      expected: [{ role: 'system', text: 'File changes' }],
    },
    { name: 'empty reasoning', item: { type: 'reasoning', summary: 42 }, expected: [] },
    {
      name: 'non-string review fallback',
      item: { type: 'enteredReviewMode', review: 42 },
      expected: [{ role: 'system', text: 'Entered review mode: current changes' }],
    },
    {
      name: 'empty exited review mode',
      item: { type: 'exitedReviewMode' },
      expected: [],
    },
    { name: 'empty web searches', item: { type: 'webSearch', action: {} }, expected: [] },
    { name: 'empty image views', item: { type: 'imageView' }, expected: [] },
    { name: 'empty MCP tool calls', item: { type: 'mcpToolCall' }, expected: [] },
    { name: 'empty dynamic tool calls', item: { type: 'dynamicToolCall' }, expected: [] },
    { name: 'empty collaboration tool calls', item: { type: 'collabToolCall' }, expected: [] },
  ])('keeps $name on the documented fallback', ({ item, expected }) => {
    // Given: malformed, incomplete, or unknown wire input.
    const createEntry = createTestEntry();

    // When: the production mapper receives the malformed item.
    const result = extractItemTranscriptEntries(item, createEntry);

    // Then: only the documented fallback survives.
    expect(result.map(({ role, text }) => ({ role, text }))).toEqual(expected);
  });

  it('keeps documented field filtering and ordering', () => {
    // Given: multiple text parts and fields the transcript mapper does not render.
    const createEntry = createTestEntry();
    const item = {
      type: 'userMessage',
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', path: '/tmp/image.png' },
        { type: 'text', text: 'second' },
      ],
      ignored: 'field',
    };

    // When: the production mapper receives the item.
    const result = extractItemTranscriptEntries(item, createEntry);

    // Then: text parts remain ordered and non-text fields remain ignored.
    expect(result.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'first\nsecond' },
    ]);
  });
});
