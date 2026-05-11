import { describe, expect, it } from 'vitest';

import type { ToolPart } from '../types/sse';
import { shouldSkipAutoOpenWebTool } from './codexToolWindows';

function createWebToolPart(overrides?: Partial<ToolPart>): ToolPart {
  return {
    id: 'web-1',
    callID: 'web-1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    tool: 'websearch',
    state: {
      status: 'running',
      input: {},
      metadata: {},
      time: { start: 1 },
    },
    ...overrides,
  };
}

describe('shouldSkipAutoOpenWebTool', () => {
  it('skips auto-open for empty running websearch tools', () => {
    expect(shouldSkipAutoOpenWebTool(createWebToolPart())).toBe(true);
  });

  it('does not skip history-opened websearch tools even if content is empty', () => {
    expect(shouldSkipAutoOpenWebTool(createWebToolPart(), true)).toBe(false);
  });

  it('does not skip completed websearch tools with query or output', () => {
    const completed = createWebToolPart({
      state: {
        status: 'completed',
        input: { query: 'vite docs' },
        output: 'Query: vite docs',
        title: 'Codex web search',
        metadata: { source: 'codex' },
        time: { start: 1, end: 2 },
      },
    });
    expect(shouldSkipAutoOpenWebTool(completed)).toBe(false);
  });
});
