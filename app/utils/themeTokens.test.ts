import { describe, expect, it } from 'vitest';

import { OCEAN_PRESET } from './regionTheme';
import {
  buildRegionCompatibilityCss,
  createSemanticTokenSnapshot,
  isThemeStorageV2,
  migrateLegacyRegionThemeStorage,
  regionThemeToStorage,
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
    expect(overrides['dropdown-bg']).toBe('#0b1f33');
    expect(overrides['chip-bg-neutral']).toBe('#1b3a4b');
    expect(overrides['icon-action-bg']).toBe('#12324a');
    expect(overrides['dock-tray-bg']).toBe('#97b1c8');
    expect(overrides['form-control-bg']).toBe('#12324a');
    expect(overrides['tab-bg']).toBe('#1b3a4b');
    expect(overrides['badge-bg']).toBe('#1b3a4b');
    expect(overrides['card-bg']).toBe('#1b3a4b');
    expect(overrides['toggle-active-track']).toBe('#76e4f7');
    expect(overrides['list-row-bg']).toBe('#1b3a4b');
    expect(overrides['empty-state-text']).toBe('#7aa2c0');
    expect(overrides['action-button-bg']).toBe('#1b3a4b');
    expect(overrides['search-bg']).toBe('#0b1f33');
    expect(overrides['floating-surface-base']).toBe('#09192a');
    expect(overrides['floating-text']).toBe('#edf7ff');
    expect(overrides['floating-default-accent']).toBe('#76e4f7');
    expect(overrides['floating-shell-background-color']).toBe('#0b1f33');
    expect(overrides['floating-shell-opacity']).toBe('0.95');
    expect(overrides['floating-background-image']).toContain('linear-gradient');
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
    expect(snapshot['dropdown-bg']).toBe('rgba(2, 6, 23, 0.98)');
    expect(snapshot['chip-bg-neutral']).toBe('rgba(15, 23, 42, 0.75)');
    expect(snapshot['icon-action-bg']).toBe('#111a2c');
    expect(snapshot['dock-chip-text']).toBe('#e2e8f0');
    expect(snapshot['form-button-primary-bg']).toBe('#1e40af');
    expect(snapshot['tab-bg']).toBe('rgba(11, 19, 32, 0.92)');
    expect(snapshot['badge-bg']).toBe('rgba(15, 23, 42, 0.75)');
    expect(snapshot['card-bg']).toBe('rgba(11, 19, 32, 0.92)');
    expect(snapshot['toggle-track']).toBe('#334155');
    expect(snapshot['list-row-bg']).toBe('rgba(11, 19, 32, 0.92)');
    expect(snapshot['empty-state-text']).toBe('#94a3b8');
    expect(snapshot['action-button-bg']).toBe('rgba(11, 19, 32, 0.92)');
    expect(snapshot['search-bg']).toBe('rgba(11, 19, 32, 0.92)');
    expect(snapshot['floating-surface-base']).toBe('#1a1d24');
    expect(snapshot['floating-surface-muted']).toBe('#242832');
    expect(snapshot['floating-surface-subtle']).toBe('#1e222a');
    expect(snapshot['floating-surface-strong']).toBe('#323a48');
    expect(snapshot['floating-fill-faint']).toBe('#ffffff');
    expect(snapshot['floating-shell-background-color']).toBe('#1a1d24');
    expect(snapshot['floating-tool-accent']).toBe('#64748b');
    expect(snapshot['floating-dialog-accent']).toBe('#f59e0b');
    expect(snapshot['floating-opacity']).toBe('1');
    expect(snapshot['floating-titlebar-opacity']).toBe('1');
    expect(snapshot['floating-background-image']).toBe('none');
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

  it('preserves floating default overrides through storage conversion', () => {
    const storage = regionThemeToStorage({
      ...OCEAN_PRESET,
      floating: {
        default: {
          accent: '#7dd3fc',
          opacity: '0.88',
          titlebarOpacity: '0.92',
          backgroundImage: 'linear-gradient(135deg, rgba(8, 17, 31, 0.2), rgba(17, 36, 59, 0.32))',
        },
      },
    });
    expect(storage?.overrides['floating-default-accent']).toBe('#7dd3fc');
    expect(storage?.overrides['floating-opacity']).toBe('0.88');
    expect(storage?.overrides['floating-titlebar-opacity']).toBe('0.92');
    expect(storage?.overrides['floating-background-image']).toContain('linear-gradient');
    expect(storage?.floating?.default?.accent).toBe('#7dd3fc');
  });

  it('strips alpha from floating layer colors and keeps titlebar opacity independent', () => {
    const overrides = regionThemeToSemanticOverrides({
      ...OCEAN_PRESET,
      floating: {
        surfaceBase: 'rgba(9, 25, 42, 0.35)',
        surfaceMuted: 'rgba(15, 40, 66, 0.45)',
        surfaceSubtle: '#112233cc',
        surfaceStrong: '#445566aa',
        fillFaint: 'rgba(118, 228, 247, 0.12)',
        opacity: '0.46',
        default: {
          opacity: '0.72',
        },
      },
    });

    expect(overrides['floating-surface-base']).toBe('rgb(9, 25, 42)');
    expect(overrides['floating-surface-muted']).toBe('rgb(15, 40, 66)');
    expect(overrides['floating-surface-subtle']).toBe('#112233');
    expect(overrides['floating-surface-strong']).toBe('#445566');
    expect(overrides['floating-fill-faint']).toBe('rgb(118, 228, 247)');
    expect(overrides['floating-opacity']).toBe('0.72');
    expect(overrides['floating-titlebar-opacity']).toBe('1');
  });

  it('supports type-level floating background colors', () => {
    const overrides = regionThemeToSemanticOverrides({
      ...OCEAN_PRESET,
      floating: {
        ...OCEAN_PRESET.floating,
        default: {
          ...OCEAN_PRESET.floating?.default,
          backgroundColor: '#112244',
        },
        shell: {
          ...OCEAN_PRESET.floating?.shell,
          backgroundColor: '#224466',
          opacity: '0.95',
        },
      },
    });

    expect(overrides['floating-shell-background-color']).toBe('#224466');
    expect(overrides['floating-shell-opacity']).toBe('0.95');
    expect(overrides['floating-tool-background-color']).toBe('#112244');
  });
});
