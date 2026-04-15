import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readComponentSource(name: string) {
  return readFileSync(resolve(__dirname, `${name}.vue`), 'utf8');
}

describe('modal backdrop theme bindings', () => {
  it('settings dialog backdrop uses overlay token instead of modal active region color', () => {
    const source = readComponentSource('SettingsModal');
    expect(source).toContain('.modal-backdrop::backdrop');
    expect(source).toContain('background: var(--theme-surface-overlay, rgba(2, 6, 23, 0.65));');
    expect(source).not.toContain('background: var(--region-modal-active-bg, rgba(2, 6, 23, 0.65));');
  });

  it('provider manager dialog backdrop uses overlay token instead of modal active region color', () => {
    const source = readComponentSource('ProviderManagerModal');
    expect(source).toContain('.provider-manager-backdrop::backdrop');
    expect(source).toContain('background: var(--theme-surface-overlay, rgba(2, 6, 23, 0.68));');
    expect(source).not.toContain('background: var(--region-modal-active-bg, rgba(2, 6, 23, 0.68));');
  });
});
