import { describe, expect, it } from 'vitest';

import { OCEAN_PRESET } from './regionTheme';
import {
  buildRegionCompatibilityCss,
  createSemanticTokenSnapshot,
  isThemeStorageV2,
  migrateLegacyRegionThemeStorage,
  regionThemeToSemanticOverrides,
  resolveThemeStoragePreset,
  semanticTokenCssVariable,
  storageToRegionTheme,
} from './themeTokens';

describe('theme token bridge', () => {
  it('maps legacy region theme presets into semantic token overrides', () => {
    const overrides = regionThemeToSemanticOverrides(OCEAN_PRESET);
    expect(overrides['surface-panel']).toBe('#1a1a2e');
    expect(overrides['surface-page']).toBe('#b8c9d8');
    expect(overrides['text-primary']).toBe('#eaf6ff');
    expect(overrides['accent-primary']).toBe('#4cc9f0');
    expect(overrides['surface-overlay']).toBe('color-mix(in srgb, #006494 55%, transparent)');
  });

  it('migrates legacy region theme storage into versioned token storage', () => {
    const migrated = migrateLegacyRegionThemeStorage(OCEAN_PRESET);
    expect(isThemeStorageV2(migrated)).toBe(true);
    expect(migrated?.version).toBe(2);
    expect(resolveThemeStoragePreset(migrated)).toBe('ocean');
    expect(migrated?.overrides['surface-panel']).toBe('#1a1a2e');
    expect(migrated?.regions?.sidePanel?.bg).toBe('#102542');
    expect(migrated?.regions?.outputPanel?.bg).toBe('#13293d');
  });

  it('reconstructs a region theme shape from token storage for compatibility', () => {
    const migrated = migrateLegacyRegionThemeStorage(OCEAN_PRESET);
    const regionTheme = storageToRegionTheme(migrated);
    expect(regionTheme?.regions.topPanel.bg).toBe('#1a1a2e');
    expect(regionTheme?.regions.sidePanel.bg).toBe('#102542');
    expect(regionTheme?.regions.outputPanel.bg).toBe('#13293d');
    expect(regionTheme?.regions.pageBackground.bg).toBe('#b8c9d8');
    expect(regionTheme?.regions.modalPanel.accent).toBe('#76e4f7');
  });

  it('builds preset-aware compatibility css with semantic roots for preset switching', () => {
    const css = buildRegionCompatibilityCss();
    expect(css).toContain(`:root[data-region-theme="ocean"] {`);
    expect(css).toContain(`${semanticTokenCssVariable('surface-panel')}: rgba(15, 23, 42, 0.92);`);
    expect(css).not.toContain('.top-panel {');
  });

  it('creates a complete token snapshot from sparse overrides', () => {
    const snapshot = createSemanticTokenSnapshot({
      'surface-panel': '#123456',
    });
    expect(snapshot['surface-panel']).toBe('#123456');
    expect(snapshot['surface-page']).toBe('#818182');
    expect(snapshot['surface-page-elevated']).toBe('#909092');
    expect(snapshot['text-primary']).toBe('#e2e8f0');
  });

  it('includes git and tree semantic tokens in the default snapshot', () => {
    const snapshot = createSemanticTokenSnapshot();
    expect(snapshot['status-git-modified']).toBe('#e2c08d');
    expect(snapshot['status-git-added-strong']).toBe('#86efac');
    expect(snapshot['status-git-deleted']).toBe('#c74e39');
    expect(snapshot['status-git-renamed-strong']).toBe('#5ee0c8');
    expect(snapshot['status-git-pinned']).toBe('#fbbf24');
    expect(snapshot['status-git-archived']).toBe('#c4b5fd');
    expect(snapshot['status-git-attention']).toBe('#93c5fd');
    expect(snapshot['status-git-connector']).toBe('rgba(71, 85, 105, 0.46)');
  });
});
