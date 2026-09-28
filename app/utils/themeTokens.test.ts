import { describe, expect, it } from 'vitest';

import { AURORA_TIDE_PRESET } from './regionTheme';
import {
  buildRegionCompatibilityCss,
  createSemanticTokenSnapshot,
  isThemeStorageV2,
  migrateLegacyRegionThemeStorage,
  normalizeThemeStorage,
  regionThemeToStorage,
  regionThemeToSemanticOverrides,
  resolveSyntaxTheme,
  resolveThemeStoragePreset,
  semanticTokenCssVariable,
  storageToRegionTheme,
} from './themeTokens';

describe('theme token bridge', () => {
  it('selects a light syntax palette for rgb text in imported themes', () => {
    const storage = regionThemeToStorage(AURORA_TIDE_PRESET)!;
    storage.regions!.outputPanel.text = 'rgb(38 48 56)';
    expect(resolveSyntaxTheme(storage)).toBe('github-light');
  });

  it('maps legacy region theme presets into semantic token overrides', () => {
    const overrides = regionThemeToSemanticOverrides(AURORA_TIDE_PRESET);
    expect(overrides['surface-panel']).toBe('#142a35');
    expect(overrides['surface-page']).toContain('linear-gradient');
    expect(overrides['text-primary']).toBe('#e8f6f3');
    expect(overrides['accent-primary']).toBe('#5de1c0');
    expect(overrides['surface-overlay']).toBe('color-mix(in srgb, #315861 55%, transparent)');
    expect(overrides['dropdown-bg']).toBe('#1a3540');
    expect(overrides['chip-bg-neutral']).toBe('#24424d');
    expect(overrides['icon-action-bg']).toBe('#1d3c48');
    expect(overrides['dock-tray-bg']).toBe('#193541');
    expect(overrides['form-control-bg']).toBe('#1a3540');
    expect(overrides['tab-bg']).toBe('#24424d');
    expect(overrides['badge-bg']).toBe('#24424d');
    expect(overrides['card-bg']).toBe('linear-gradient(140deg, #1c3943, #202f43)');
    expect(overrides['toggle-active-track']).toBe('#5de1c0');
    expect(overrides['list-row-bg']).toBe('#24424d');
    expect(overrides['empty-state-text']).toBe('#afc6cb');
    expect(overrides['action-button-bg']).toBe('#24424d');
    expect(overrides['search-bg']).toBe('#142a35');
    expect(overrides['floating-surface-base']).toBe('#192f3d');
    expect(overrides['floating-text']).toBe('#e8f6f3');
    expect(overrides['floating-default-accent']).toBe('#5de1c0');
    expect(overrides['floating-shell-background-color']).toBe('#192f3d');
    expect(overrides['floating-shell-opacity']).toBe('1');
    expect(overrides['floating-background-image']).toContain('linear-gradient');
  });

  it('migrates legacy region theme storage into versioned token storage', () => {
    const migrated = migrateLegacyRegionThemeStorage(AURORA_TIDE_PRESET);
    expect(isThemeStorageV2(migrated)).toBe(true);
    expect(migrated?.version).toBe(2);
    expect(resolveThemeStoragePreset(migrated)).toBe('aurora-tide');
    expect(migrated?.overrides['surface-panel']).toBe('#142a35');
    expect(migrated?.regions?.sidePanel?.bg).toContain('linear-gradient');
    expect(migrated?.regions?.outputPanel?.bg).toContain('linear-gradient');
  });

  it('reconstructs a region theme shape from token storage for compatibility', () => {
    const migrated = migrateLegacyRegionThemeStorage(AURORA_TIDE_PRESET);
    const regionTheme = storageToRegionTheme(migrated);
    expect(regionTheme?.regions.topPanel.bg).toBe('#142a35');
    expect(regionTheme?.regions.sidePanel.bg).toContain('linear-gradient');
    expect(regionTheme?.regions.outputPanel.bg).toContain('linear-gradient');
    expect(regionTheme?.regions.pageBackground.bg).toContain('linear-gradient');
    expect(regionTheme?.regions.modalPanel.accent).toBe('#5de1c0');
  });

  it('builds preset-aware compatibility css with semantic roots for preset switching', () => {
    const css = buildRegionCompatibilityCss();
    expect(css).toContain(`:root[data-region-theme="aurora-tide"] {`);
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
      ...AURORA_TIDE_PRESET,
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
      ...AURORA_TIDE_PRESET,
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
      ...AURORA_TIDE_PRESET,
      floating: {
        ...AURORA_TIDE_PRESET.floating,
        default: {
          ...AURORA_TIDE_PRESET.floating?.default,
          backgroundColor: '#112244',
          text: '#e0d0c0',
        },
        shell: {
          ...AURORA_TIDE_PRESET.floating?.shell,
          backgroundColor: '#224466',
          text: '#f0e0d0',
          opacity: '0.95',
        },
        reasoning: { backgroundColor: '#334455', text: '#f1e2d3' },
        subagent: { backgroundColor: '#445566', textMuted: '#d0c0b0' },
        tool: { backgroundColor: '#556677', textSoft: '#c0b0a0' },
        media: undefined,
      },
    });

    expect(overrides['floating-shell-background-color']).toBe('#224466');
    expect(overrides['floating-default-background-color']).toBe('#112244');
    expect(overrides['floating-default-text']).toBe('#e0d0c0');
    expect(overrides['floating-shell-text']).toBe('#f0e0d0');
    expect(overrides['floating-shell-opacity']).toBe('0.95');
    expect(overrides['floating-reasoning-background-color']).toBe('#334455');
    expect(overrides['floating-reasoning-text']).toBe('#f1e2d3');
    expect(overrides['floating-subagent-background-color']).toBe('#445566');
    expect(overrides['floating-subagent-text-muted']).toBe('#d0c0b0');
    expect(overrides['floating-tool-background-color']).toBe('#556677');
    expect(overrides['floating-tool-text-soft']).toBe('#c0b0a0');
    expect(overrides['floating-media-background-color']).toBe('#112244');
  });

  it('retains optional floating syntax colors through stored theme normalization', () => {
    const stored = regionThemeToStorage({
      ...AURORA_TIDE_PRESET,
      floating: {
        ...AURORA_TIDE_PRESET.floating,
        syntaxText: '#35263a',
        file: { backgroundColor: '#dec8d3', text: '#40283a', syntaxText: '#234567' },
      },
    });
    const normalized = normalizeThemeStorage(JSON.parse(JSON.stringify(stored)));
    expect(normalized?.floating?.syntaxText).toBe('#35263a');
    expect(normalized?.floating?.file).toMatchObject({
      backgroundColor: '#dec8d3',
      text: '#40283a',
      syntaxText: '#234567',
    });
  });
});
