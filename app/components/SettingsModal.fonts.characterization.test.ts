import { h } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import {
  canonical,
  mountModal,
  openFontsPage,
  registerSettingsModalLifecycle,
  sections,
} from './SettingsModal.fonts.shared';

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { class: 'iconify', 'data-icon': props.icon }),
}));

registerSettingsModalLifecycle();

describe('SettingsModal fonts page characterization', () => {
  it('locks the canonical rendered DOM of both font rows', async () => {
    // Given: the settings modal is opened on the fonts page.
    const { host } = await mountModal();

    // When: the fonts page rows are collected with discovery panels closed.
    const rows = await openFontsPage(host);

    // Then: the canonical DOM of the terminal and app font rows matches the locked structure.
    expect({
      terminal: canonical(rows[0]),
      app: canonical(rows[1]),
    }).toMatchSnapshot();
  });

  it('locks the section order, ids, and aria wiring of both font rows', async () => {
    // Given: the settings modal is opened on the fonts page.
    const { host } = await mountModal();
    const rows = await openFontsPage(host);

    // Then: the terminal row renders its four sections in the locked order.
    const terminalSections = sections(rows[0]);
    expect(terminalSections).toHaveLength(4);

    const terminalSizeInput = terminalSections[0].querySelector('input.number-input');
    expect(terminalSizeInput).not.toBeNull();
    expect(terminalSizeInput!.id).toBe('settings-terminal-font-size');
    expect(terminalSections[0].querySelector('label')!.getAttribute('for')).toBe(
      'settings-terminal-font-size',
    );

    const terminalPresetRow = terminalSections[1].querySelector('.font-preset-row');
    expect(terminalPresetRow).not.toBeNull();
    expect(terminalPresetRow!.getAttribute('role')).toBe('group');
    expect(terminalPresetRow!.getAttribute('aria-labelledby')).toBe(
      'settings-terminal-font-presets',
    );
    expect(terminalSections[1].querySelector('.font-setting-section-label')!.id).toBe(
      'settings-terminal-font-presets',
    );
    expect(terminalPresetRow!.querySelectorAll('button.font-preset-chip')).toHaveLength(5);

    const terminalInputLabel = terminalSections[2].querySelector('label');
    expect(terminalInputLabel!.id).toBe('settings-terminal-font-input-label');
    expect(terminalInputLabel!.getAttribute('for')).toBe('settings-terminal-font-input');
    const terminalTextarea = terminalSections[2].querySelector('textarea.font-stack-input');
    expect(terminalTextarea).not.toBeNull();
    expect(terminalTextarea!.id).toBe('settings-terminal-font-input');
    expect(terminalTextarea!.getAttribute('aria-describedby')).toBe(
      'settings-terminal-font-presets',
    );
    const terminalStatusList = terminalSections[2].querySelector('.font-stack-status-list');
    expect(terminalStatusList).not.toBeNull();
    expect(terminalStatusList!.getAttribute('role')).toBe('status');
    expect(terminalStatusList!.getAttribute('aria-live')).toBe('polite');

    const terminalToggle = terminalSections[3].querySelector('button.font-discovery-toggle');
    expect(terminalToggle).not.toBeNull();
    expect(terminalToggle!.getAttribute('aria-expanded')).toBe('false');
    expect(terminalSections[3].querySelector('.font-discovery-panel')).toBeNull();

    // And: the app row renders its eight sections in the locked order.
    const appSections = sections(rows[1]);
    expect(appSections).toHaveLength(8);

    const appSizeIds = [
      'settings-app-font-size',
      'settings-message-font-size',
      'settings-sidebar-font-size',
      'settings-ui-font-size',
    ];
    appSections.slice(0, 4).forEach((section, index) => {
      const input = section.querySelector('input.number-input');
      expect(input).not.toBeNull();
      expect(input!.id).toBe(appSizeIds[index]);
      expect(section.querySelector('label')!.getAttribute('for')).toBe(appSizeIds[index]);
    });

    const editorSuboption = appSections[4];
    expect(editorSuboption.getAttribute('class')).toBe(
      'font-setting-section font-setting-suboption',
    );
    const editorControl = editorSuboption.querySelector('.editor-number-control');
    expect(editorControl).not.toBeNull();
    const editorInput = editorControl!.querySelector('input.number-input');
    expect(editorInput).not.toBeNull();
    expect(editorInput!.id).toBe('');
    expect(editorInput!.getAttribute('placeholder')).toBe(en.settings.editor.fontSize.inherited);
    expect(editorControl!.querySelector('button.font-system-button')!.textContent).toBe(
      en.settings.editor.fontSize.inheritAction,
    );

    const appPresetRow = appSections[5].querySelector('.font-preset-row');
    expect(appPresetRow).not.toBeNull();
    expect(appPresetRow!.getAttribute('aria-labelledby')).toBe('settings-app-font-presets');
    expect(appSections[5].querySelector('.font-setting-section-label')!.id).toBe(
      'settings-app-font-presets',
    );
    expect(appPresetRow!.querySelectorAll('button.font-preset-chip')).toHaveLength(5);

    const appInputLabel = appSections[6].querySelector('label');
    expect(appInputLabel!.id).toBe('settings-app-font-input-label');
    expect(appInputLabel!.getAttribute('for')).toBe('settings-app-font-input');
    const appTextarea = appSections[6].querySelector('textarea.font-stack-input');
    expect(appTextarea).not.toBeNull();
    expect(appTextarea!.id).toBe('settings-app-font-input');
    expect(appTextarea!.getAttribute('aria-describedby')).toBe('settings-app-font-presets');

    const appToggle = appSections[7].querySelector('button.font-discovery-toggle');
    expect(appToggle).not.toBeNull();
    expect(appToggle!.getAttribute('aria-expanded')).toBe('false');
  });
});
