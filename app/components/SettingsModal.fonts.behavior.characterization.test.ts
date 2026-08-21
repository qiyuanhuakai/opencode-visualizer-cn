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

describe('SettingsModal fonts page behavior characterization', () => {
  it('updates the status list only after the debounce window', async () => {
    // Given: the settings modal is opened on the fonts page.
    const { host, settings } = await mountModal();
    const rows = await openFontsPage(host);
    const statusItems = () =>
      Array.from(sections(pageRows(host)[0])[2].querySelectorAll('.font-stack-status-item'));
    const initialCount = statusItems().length;
    expect(initialCount).toBeGreaterThan(0);

    // When: the terminal textarea is edited with fake timers active.
    vi.useFakeTimers();
    const terminalTextarea = sections(rows[0])[2].querySelector('textarea') as HTMLTextAreaElement;
    terminalTextarea.value = 'monospace';
    terminalTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    // Then: the model updates immediately but the status list still shows the old stack.
    expect(settings.terminalFontFamily.value).toBe('monospace');
    expect(statusItems()).toHaveLength(initialCount);

    // When: the debounce window elapses.
    vi.advanceTimersByTime(150);
    await nextTick();

    // Then: the status list re-renders for the new stack with the generic status.
    expect(statusItems()).toHaveLength(1);
    expect(statusItems()[0].getAttribute('class')).toContain('is-generic');
    expect(statusItems()[0].querySelector('.font-stack-status-name')!.textContent).toBe(
      'monospace',
    );
    expect(statusItems()[0].querySelector('.font-stack-status-value')!.textContent).toBe(
      en.settings.fontStatus.generic,
    );
  });

  it('clamps size inputs on blur and inherits the editor font size', async () => {
    // Given: the settings modal is opened on the fonts page.
    const { host, settings } = await mountModal();
    const rows = await openFontsPage(host);

    // When: an out-of-range value is entered into the terminal size input and blurred.
    const terminalSizeInput = sections(rows[0])[0].querySelector(
      'input.number-input',
    ) as HTMLInputElement;
    terminalSizeInput.value = '999';
    terminalSizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    terminalSizeInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await nextTick();

    // Then: the value is clamped to the configured maximum.
    expect(settings.terminalFontSizePx.value).toBe(settings.maxTerminalFontSizePx);
    expect(terminalSizeInput.value).toBe(String(settings.maxTerminalFontSizePx));

    // When: an out-of-range value is entered into the app sidebar size input and blurred.
    const sidebarSizeInput = sections(pageRows(host)[1])[2].querySelector(
      'input.number-input',
    ) as HTMLInputElement;
    sidebarSizeInput.value = '999';
    sidebarSizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    sidebarSizeInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await nextTick();

    // Then: the sidebar model is clamped to its configured maximum.
    expect(settings.sidebarFontSizePx.value).toBe(settings.maxSidebarFontSizePx);

    // When: a custom editor font size is entered and blurred.
    const editorInput = sections(pageRows(host)[1])[4].querySelector(
      'input.number-input',
    ) as HTMLInputElement;
    editorInput.value = '20';
    editorInput.dispatchEvent(new Event('input', { bubbles: true }));
    editorInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await nextTick();

    // Then: the editor font size model updates.
    expect(settings.editorFontSizePx.value).toBe(20);

    // When: the inherit button is clicked.
    const inheritButton = sections(pageRows(host)[1])[4].querySelector(
      'button.font-system-button',
    )!;
    await click(inheritButton);

    // Then: the editor font size model resets to inherit.
    expect(settings.editorFontSizePx.value).toBeNull();
  });

  it('prepends a discovered font into the bound stack from either row', async () => {
    // Given: the local font access API is stubbed before the modal mounts.
    vi.stubGlobal('queryLocalFonts', () =>
      Promise.resolve([
        { family: 'Test Font', fullName: 'Test Font', postscriptName: 'TestFont', style: '' },
      ]),
    );
    const { host, settings } = await mountModal();
    const rows = await openFontsPage(host);
    const previousStack = settings.terminalFontFamily.value;

    // When: the terminal discovery panel is opened and a scan is triggered.
    await click(sections(rows[0])[3].querySelector('button.font-discovery-toggle')!);
    const scanButton = sections(pageRows(host)[0])[3].querySelector(
      '.font-system-actions button.font-system-button',
    );
    expect(scanButton).not.toBeNull();
    (scanButton as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(
        sections(pageRows(host)[0])[3].querySelectorAll('.font-system-list .font-system-item'),
      ).toHaveLength(1);
    });

    // Then: the discovered font renders with the regular fallback meta text.
    const fontItem = sections(pageRows(host)[0])[3].querySelector('.font-system-item')!;
    expect(fontItem.querySelector('.font-system-family')!.textContent).toBe('Test Font');
    expect(fontItem.querySelector('.font-system-meta')!.textContent).toBe(
      en.settings.systemFonts.regular,
    );

    // When: the discovered font item is clicked.
    await click(fontItem);

    // Then: the family is prepended to the terminal stack.
    expect(settings.terminalFontFamily.value).toBe(`'Test Font', ${previousStack}`);

    // And: the app row shares the same discovered list and prepend behaviour.
    await click(sections(pageRows(host)[1])[7].querySelector('button.font-discovery-toggle')!);
    const appFontItem = sections(pageRows(host)[1])[7].querySelector('.font-system-item');
    expect(appFontItem).not.toBeNull();
    const previousAppStack = settings.appMonospaceFontFamily.value;
    await click(appFontItem!);
    expect(settings.appMonospaceFontFamily.value).toBe(`'Test Font', ${previousAppStack}`);
  });
});
