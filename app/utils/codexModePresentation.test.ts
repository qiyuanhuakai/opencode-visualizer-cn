import { describe, expect, it } from 'vitest';
import { codexModeColor, codexModeOptions } from './codexModePresentation';
import { opencodeTheme, resolveTheme } from './theme';

describe('Codex collaboration presentation', () => {
  it('uses server labels and localized descriptions in the shared agent dropdown', () => {
    expect(codexModeOptions([
      { mode: 'default', name: 'Default' }, { mode: 'plan', name: 'Plan' },
    ], 'zh-CN')).toEqual([
      { id: 'default', label: 'Default', description: '直接执行任务，需要时向你提问。' },
      { id: 'plan', label: 'Plan', description: '先讨论方案并制定计划，再进入实施。' },
    ]);
  });

  it('keeps a usable default and describes unknown server modes', () => {
    expect(codexModeOptions([], 'en')[0]).toMatchObject({ id: 'default', label: 'Default' });
    expect(codexModeOptions([{ mode: 'review', name: 'Review' }], 'unavailable')[0])
      .toMatchObject({ id: 'review', label: 'Review', description: 'Handle the task using this server-provided collaboration mode.' });
  });

  it('resolves stable, distinct mode colors from the OpenCode palette in both themes', () => {
    for (const variant of ['dark', 'light'] as const) {
      const theme = resolveTheme(opencodeTheme, variant);
      expect(codexModeColor('default', theme)).toBe(theme.success);
      expect(codexModeColor('plan', theme)).toBe(theme.accent);
      expect(codexModeColor('plan', theme)).not.toBe(codexModeColor('default', theme));
    }
  });
});
