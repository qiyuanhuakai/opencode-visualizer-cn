import { describe, expect, it } from 'vitest';

import { resolveFloatingWindowThemeType } from './floatingWindowTheme';

describe('floatingWindowTheme', () => {
  it('maps known key prefixes to floating theme types', () => {
    expect(resolveFloatingWindowThemeType('shell:123')).toBe('shell');
    expect(resolveFloatingWindowThemeType('reasoning:123')).toBe('reasoning');
    expect(resolveFloatingWindowThemeType('history-reasoning:123')).toBe('reasoning');
    expect(resolveFloatingWindowThemeType('subagent:123')).toBe('subagent');
    expect(resolveFloatingWindowThemeType('file-viewer:/tmp/a.ts')).toBe('file');
    expect(resolveFloatingWindowThemeType('git-diff:all')).toBe('diff');
    expect(resolveFloatingWindowThemeType('message-diff:1')).toBe('diff');
    expect(resolveFloatingWindowThemeType('commit-diff:abc')).toBe('diff');
    expect(resolveFloatingWindowThemeType('image-viewer:https://x')).toBe('media');
    expect(resolveFloatingWindowThemeType('permission:1')).toBe('dialog');
    expect(resolveFloatingWindowThemeType('question:1')).toBe('dialog');
    expect(resolveFloatingWindowThemeType('thread-history')).toBe('history');
    expect(resolveFloatingWindowThemeType('history-tool:1')).toBe('tool');
    expect(resolveFloatingWindowThemeType('debug:notification')).toBe('debug');
  });

  it('falls back to tool for custom-colored unknown entries and default otherwise', () => {
    expect(resolveFloatingWindowThemeType({ key: 'custom:1', color: '#123456' })).toBe('tool');
    expect(resolveFloatingWindowThemeType({ key: 'custom:1', color: '' })).toBe('default');
    expect(resolveFloatingWindowThemeType('custom:1')).toBe('default');
  });
});
