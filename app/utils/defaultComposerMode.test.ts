import { describe, expect, it } from 'vitest';
import { defaultComposerMode } from './defaultComposerMode';

describe('defaultComposerMode', () => {
  it('prefers default when Codex returns Plan first', () => {
    expect(defaultComposerMode('codex', [{ id: 'plan' }, { id: 'default' }])).toBe('default');
  });
  it('uses default while Codex modes are not loaded', () => {
    expect(defaultComposerMode('codex', [])).toBe('default');
  });
  it('keeps the build preference for OpenCode', () => {
    expect(defaultComposerMode('opencode', [{ id: 'plan' }, { id: 'build' }])).toBe('build');
  });
});
