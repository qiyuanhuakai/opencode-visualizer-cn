import { h, nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import ja from '../locales/ja';
import { mountModal, pageRows, registerSettingsModalLifecycle } from './SettingsModal.fonts.shared';

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { 'data-icon': props.icon }),
}));

registerSettingsModalLifecycle();

function rowByLabel(host: HTMLElement, label: string) {
  const row = pageRows(host).find(
    (candidate) => candidate.querySelector('.setting-label')?.textContent === label,
  );
  expect(row, `setting row ${label}`).toBeDefined();
  return row!;
}

async function navigate(host: HTMLElement, label: string) {
  const control = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.getAttribute('aria-label') === label,
  );
  expect(control, `navigation control ${label}`).toBeDefined();
  control!.click();
  await nextTick();
}

describe('SettingsModal navigation, state, and accessibility', () => {
  it.each([
    [en.settings.editor.label, en.settings.editor.pageTitle],
    [en.settings.textTransformers.label, en.settings.textTransformers.pageTitle],
    [en.settings.fontSettings.label, en.settings.fontsPageTitle],
    [en.settings.experimentalFeatures.label, en.settings.experimentalFeatures.pageTitle],
    [en.settings.theme.label, en.settings.themePageTitle],
  ])('opens %s from its named settings control', async (label, pageTitle) => {
    const { host } = await mountModal();

    await navigate(host, label);

    expect(host.querySelector('.modal-title')?.textContent).toBe(pageTitle);
  });

  it('links the transformer enabled control to its visible label and description', async () => {
    const { host } = await mountModal();
    await navigate(host, en.settings.textTransformers.label);

    const row = rowByLabel(host, en.settings.textTransformers.enabledLabel);
    const label = row.querySelector<HTMLElement>('.setting-label');
    const description = row.querySelector<HTMLElement>('.setting-description');
    const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(label?.id).toBeTruthy();
    expect(description?.id).toBeTruthy();
    expect(input?.getAttribute('aria-labelledby')).toBe(label?.id);
    expect(input?.getAttribute('aria-describedby')).toBe(description?.id);
  });

  it('disables and clears dock-always-open when minimize buttons are turned off', async () => {
    const { host, settings } = await mountModal();
    const minimize = rowByLabel(host, en.settings.showMinimizeButtons.label).querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    minimize.checked = false;
    minimize.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();

    const dock = rowByLabel(host, en.settings.dockAlwaysOpen.label).querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(dock.disabled).toBe(true);
    expect(dock.checked).toBe(false);
    expect(settings.dockAlwaysOpen.value).toBe(false);
  });

  it('clamps the named open-in-editor size setting on blur', async () => {
    const { host, settings } = await mountModal();
    const input = rowByLabel(host, en.settings.openInEditorMaxSizeMb.label).querySelector(
      'input[type="number"]',
    ) as HTMLInputElement;
    input.value = '999';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await nextTick();

    expect(input.value).toBe('100');
    expect(settings.openInEditorMaxSizeMb.value).toBe(100);
  });

  it('changes visible settings labels when Japanese is selected', async () => {
    const { host } = await mountModal();
    const language = host.querySelector<HTMLSelectElement>('select.language-select');
    expect(language).not.toBeNull();
    language!.value = 'ja';
    language!.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();

    expect(rowByLabel(host, ja.settings.language.label)).toBeDefined();
  });
});
