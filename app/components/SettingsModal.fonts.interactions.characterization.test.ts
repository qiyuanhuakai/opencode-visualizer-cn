import { h, nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import {
  click,
  mountModal,
  openFontsPage,
  pageRows,
  registerSettingsModalLifecycle,
  sections,
} from './SettingsModal.fonts.shared';

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { class: 'iconify', 'data-icon': props.icon }),
}));

registerSettingsModalLifecycle();

describe('SettingsModal fonts page interactions characterization', () => {
  it('toggles each discovery panel independently with locked timing', async () => {
    // Given: the settings modal is opened on the fonts page.
    const { host } = await mountModal();
    const rows = await openFontsPage(host);
    const terminalToggle = sections(rows[0])[3].querySelector('button.font-discovery-toggle')!;
    const appToggle = sections(rows[1])[7].querySelector('button.font-discovery-toggle')!;

    // When: the terminal discovery toggle is clicked once.
    await click(terminalToggle);

    // Then: only the terminal panel opens after a single tick, with the unsupported hint in jsdom.
    expect(terminalToggle.getAttribute('aria-expanded')).toBe('true');
    const terminalPanel = sections(rows[0])[3].querySelector('.font-discovery-panel');
    expect(terminalPanel).not.toBeNull();
    expect(terminalPanel!.querySelector('.font-system-hint')!.textContent).toBe(
      en.settings.systemFonts.unsupported,
    );
    expect(terminalToggle.querySelector('svg.iconify')!.getAttribute('data-icon')).toBe(
      'lucide:chevron-up',
    );
    expect(appToggle.getAttribute('aria-expanded')).toBe('false');
    expect(sections(rows[1])[7].querySelector('.font-discovery-panel')).toBeNull();

    // When: the app discovery toggle is clicked while the terminal panel is open.
    await click(appToggle);

    // Then: the app panel opens independently.
    expect(appToggle.getAttribute('aria-expanded')).toBe('true');
    expect(sections(rows[1])[7].querySelector('.font-discovery-panel')).not.toBeNull();
    expect(terminalToggle.getAttribute('aria-expanded')).toBe('true');

    // When: the terminal toggle is clicked again.
    await click(terminalToggle);

    // Then: only the terminal panel closes and its chevron flips back.
    expect(terminalToggle.getAttribute('aria-expanded')).toBe('false');
    expect(sections(rows[0])[3].querySelector('.font-discovery-panel')).toBeNull();
    expect(terminalToggle.querySelector('svg.iconify')!.getAttribute('data-icon')).toBe(
      'lucide:chevron-down',
    );
    expect(appToggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('emits model updates from preset chips with locked active state', async () => {
    // Given: the settings modal is opened on the fonts page with default stacks selected.
    const { host, settings } = await mountModal();
    const rows = await openFontsPage(host);
    const terminalChips = Array.from(
      sections(rows[0])[1].querySelectorAll('button.font-preset-chip'),
    );
    expect(terminalChips[0].getAttribute('aria-pressed')).toBe('true');
    expect(terminalChips[0].getAttribute('class')).toContain('is-active');

    // When: the second terminal preset chip is clicked.
    await click(terminalChips[1]);

    // Then: the terminal font model updates to the FiraCode Nerd preset after one tick.
    expect(settings.terminalFontFamily.value).toBe(
      "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font Mono Med', monospace",
    );
    const updatedTerminalChips = Array.from(
      sections(pageRows(host)[0])[1].querySelectorAll('button.font-preset-chip'),
    );
    expect(updatedTerminalChips[0].getAttribute('aria-pressed')).toBe('false');
    expect(updatedTerminalChips[1].getAttribute('aria-pressed')).toBe('true');
    expect(updatedTerminalChips[1].getAttribute('class')).toContain('is-active');

    // When: the second app preset chip is clicked.
    const appChips = Array.from(sections(pageRows(host)[1])[5].querySelectorAll('button'));
    await click(appChips[1]);

    // Then: the app monospace model updates to the SF Mono preset.
    expect(settings.appMonospaceFontFamily.value).toBe(
      "'SF Mono', 'SFMono-Regular', ui-monospace, 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace",
    );
  });

  it('trims textarea input into the bound model', async () => {
    // Given: the settings modal is opened on the fonts page.
    const { host, settings } = await mountModal();
    const rows = await openFontsPage(host);

    // When: whitespace-padded text is entered into the terminal textarea.
    const terminalTextarea = sections(rows[0])[2].querySelector('textarea') as HTMLTextAreaElement;
    terminalTextarea.value = "  'Foo Bar', monospace  ";
    terminalTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    // Then: the bound terminal model receives the trimmed value.
    expect(settings.terminalFontFamily.value).toBe("'Foo Bar', monospace");

    // When: whitespace-padded text is entered into the app textarea.
    const appTextarea = sections(rows[1])[6].querySelector('textarea') as HTMLTextAreaElement;
    appTextarea.value = '  ui-monospace  ';
    appTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    // Then: the bound app model receives the trimmed value.
    expect(settings.appMonospaceFontFamily.value).toBe('ui-monospace');
  });
});
