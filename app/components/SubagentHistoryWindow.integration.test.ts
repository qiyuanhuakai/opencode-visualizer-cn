import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('subagent history window integration', () => {
  it('forwards tool and reasoning clicks to the shared history detail handlers', () => {
    const appSource = source('app/App.vue');
    const openWindowBlock =
      appSource.match(/component: SubagentHistoryContent,[\s\S]*?title:/u)?.[0] ?? '';

    expect(openWindowBlock).toContain(
      'onToolClick: (part: ToolPart) => handleOpenHistoryTool({ part })',
    );
    expect(openWindowBlock).toContain(
      'onReasoningClick: (part: ReasoningPart) => handleOpenHistoryReasoning({ part })',
    );
  });

  it('uses floating theme tokens instead of fixed sky colors', () => {
    const componentSource = source('app/components/SubagentHistoryContent.vue');

    expect(componentSource).not.toContain('#0ea5e9');
    expect(componentSource).not.toContain('#7dd3fc');
    expect(componentSource).toContain('var(--floating-surface-outline');
    expect(componentSource).toContain('var(--floating-surface-title-text');
  });

  it('keeps history rows on semantic theme colors instead of fixed decorative palettes', () => {
    const historyContentSource = source('app/components/ThreadHistoryContent.vue');
    const fixedDecorativeColors = [
      '#0ea5e9',
      '#7dd3fc',
      '#8b5cf6',
      '#34d399',
      '#67e8f9',
      '#d8b4fe',
      '#6ee7b7',
      '#4ade80',
      '#f87171',
      '#fbbf24',
    ];

    for (const color of fixedDecorativeColors) {
      expect(historyContentSource).not.toContain(color);
    }
    expect(historyContentSource).toContain('--theme-floating-reasoning-accent');
    expect(historyContentSource).toContain('--theme-floating-subagent-accent');
    expect(historyContentSource).toContain('--theme-status-success');
  });

  it('themes the visible subagent launcher row with the subagent semantic accent', () => {
    const threadBlockSource = source('app/components/ThreadBlock.vue');

    expect(threadBlockSource).not.toContain('#0ea5e9');
    expect(threadBlockSource).not.toContain('#7dd3fc');
    expect(threadBlockSource).not.toContain('#bae6fd');
    expect(threadBlockSource).toContain('--theme-floating-subagent-accent');
  });
});
