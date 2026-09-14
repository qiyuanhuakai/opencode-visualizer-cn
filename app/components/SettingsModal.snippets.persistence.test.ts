import { nextTick } from 'vue';
// allow: SIZE_OK — persistence acknowledgement and rollback cases stay in one requested suite.
import { describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import {
  registerSnippetSettingsLifecycle,
  mountSnippetSettings,
  inputValue,
  changeValue,
} from './SettingsModal.snippets.shared';

registerSnippetSettingsLifecycle();

describe('SettingsModal snippets persistence', () => {
  it('rolls back ordinary snippet changes when persistence fails', async () => {
    // Given: settings are open and the storage backend will reject each next write independently.
    const { host, settings } = await mountSnippetSettings();
    const setItem = vi.spyOn(localStorage, 'setItem');
    const rejectNextWrite = () => {
      setItem.mockImplementationOnce(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      });
    };

    // When: an edit, row toggle, removal, and global toggle each fail at the storage boundary.
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    rejectNextWrite();
    changeValue(host.querySelector('[data-snippet-field="name"]')!, 'Unsaved name');
    await nextTick();
    expect(settings.textTransformers.value[0]?.name).toBe('Review changes');
    expect(host.querySelector<HTMLInputElement>('[data-snippet-field="name"]')?.value).toBe(
      'Unsaved name',
    );
    expect(host.querySelector('.transformer-detail')?.textContent).toContain(
      en.settings.textTransformers.saveError,
    );
    changeValue(host.querySelector('[data-snippet-field="name"]')!, 'Unsaved name');
    await nextTick();
    expect(settings.textTransformers.value[0]?.name).toBe('Unsaved name');
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    rejectNextWrite();
    host.querySelector<HTMLButtonElement>('.transformer-enable')!.click();
    await nextTick();
    expect(settings.textTransformers.value[0]?.enabled).toBe(true);

    rejectNextWrite();
    host.querySelector<HTMLButtonElement>('.transformer-remove')!.click();
    await nextTick();
    expect(settings.textTransformers.value).toHaveLength(2);

    const globalToggle = host.querySelector<HTMLInputElement>('.toggle-input')!;
    expect(globalToggle.checked).toBe(false);
    rejectNextWrite();
    globalToggle.click();
    await nextTick();

    // Then: no failed value becomes authoritative and the live region reports the save failure.
    expect(settings.textTransformersEnabled.value).toBe(false);
    expect(host.querySelector<HTMLInputElement>('.toggle-input')?.checked).toBe(false);
    expect(host.querySelector('.transformer-import-status')?.textContent?.toLowerCase()).toContain(
      'save',
    );
    setItem.mockRestore();
  });

  it('clears a stale global-toggle save error after an acknowledged retry', async () => {
    // Given: the Snippets page is open and the next global-toggle persistence attempt will fail.
    const { host, settings } = await mountSnippetSettings();
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const globalToggle = host.querySelector<HTMLInputElement>('.toggle-input')!;

    // When: the user retries the same toggle after the failure is removed.
    globalToggle.click();
    await nextTick();
    expect(host.querySelector('.transformer-import-status')?.textContent).toContain(
      en.settings.textTransformers.saveError,
    );
    setItem.mockRestore();
    host.querySelector<HTMLInputElement>('.toggle-input')!.click();
    await nextTick();

    // Then: the acknowledged setting is enabled and only the stale save error is cleared.
    expect(settings.textTransformersEnabled.value).toBe(true);
    expect(host.querySelector('.transformer-import-status')?.textContent).not.toContain(
      en.settings.textTransformers.saveError,
    );
  });

  it('clears a same-task global-toggle save error after an acknowledged retry', async () => {
    // Given: the next global-toggle persistence attempt fails but the following attempt succeeds.
    const { host, settings } = await mountSnippetSettings();
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    // When: the user retries immediately in the same task before Vue flushes the error watchers.
    settings.textTransformersEnabled.value = true;
    settings.textTransformersEnabled.value = true;
    await nextTick();

    // Then: the successful setting and status both win without coalescing away the clear transition.
    expect(settings.textTransformersEnabled.value).toBe(true);
    expect(host.querySelector('.transformer-import-status')?.textContent).not.toContain(
      en.settings.textTransformers.saveError,
    );
    setItem.mockRestore();
  });

  it('clears a row-toggle save error after that row mutation is acknowledged', async () => {
    // Given: the next row-level enable mutation is rejected by storage.
    const { host, settings } = await mountSnippetSettings();
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const rowToggle = host.querySelector<HTMLButtonElement>('.transformer-enable')!;
    rowToggle.click();
    await nextTick();
    expect(settings.textTransformers.value[0]?.enabled).toBe(true);
    expect(host.querySelector('.transformer-import-status')?.textContent).toContain(
      en.settings.textTransformers.saveError,
    );

    // When: the user retries the same row mutation after storage recovers.
    setItem.mockRestore();
    host.querySelector<HTMLButtonElement>('.transformer-enable')!.click();
    await nextTick();

    // Then: the acknowledged row state wins and its stale persistence error is cleared.
    expect(settings.textTransformers.value[0]?.enabled).toBe(false);
    expect(host.querySelector('.transformer-import-status')?.textContent).not.toContain(
      en.settings.textTransformers.saveError,
    );
  });

  it('clears a row save error when retry finds the requested native value already committed', async () => {
    // Given: storage commits a row toggle but its first acknowledgement reports failure.
    const { host, settings } = await mountSnippetSettings();
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const setItem = vi
      .spyOn(localStorage, 'setItem')
      .mockImplementationOnce((key: string, value: string) => {
        originalSetItem(key, value);
        throw new DOMException('Legacy mirror unavailable', 'QuotaExceededError');
      });
    const rowToggle = host.querySelector<HTMLButtonElement>('.transformer-enable')!;
    rowToggle.click();
    await nextTick();
    expect(settings.textTransformers.value[0]?.enabled).toBe(true);
    expect(host.querySelector('.transformer-import-status')?.textContent).toContain(
      en.settings.textTransformers.saveError,
    );

    // When: the user retries the same row mutation already present in canonical storage.
    rowToggle.click();
    await nextTick();

    // Then: the row converges to the committed value and only its stale save error clears.
    expect(settings.textTransformers.value[0]?.enabled).toBe(false);
    expect(host.querySelector('.transformer-import-status')?.textContent).not.toContain(
      en.settings.textTransformers.saveError,
    );
    setItem.mockRestore();
  });

  it('keeps a rejected Electron Back commit inside the retryable detail view', async () => {
    // Given: Electron owns the migrated library and rejects subsequent synchronous writes.
    const electronStore: Record<string, string> = {};
    let rejectWrites = false;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        persistentStorage: {
          getItem: (key: string) => electronStore[key] ?? null,
          setItem: (key: string, value: string) => {
            if (rejectWrites) return false;
            electronStore[key] = value;
            return true;
          },
          removeItem: (key: string) => {
            if (rejectWrites) return false;
            delete electronStore[key];
            return true;
          },
          migrate: (entries: Record<string, string>) => {
            Object.assign(electronStore, entries);
            return true;
          },
        },
      },
    });
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    const bodyInput = host.querySelector<HTMLTextAreaElement>('[data-snippet-field="body"]')!;
    inputValue(bodyInput, 'Electron retry draft');
    rejectWrites = true;

    // When: blur and Back both cross the rejected native persistence boundary.
    bodyInput.dispatchEvent(new Event('change', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: canonical state is restored while detail retains the draft and reports the retry.
    expect(settings.textTransformers.value[0]?.body).toBe('Review the selected changes.');
    expect(
      JSON.parse(electronStore['opencode.settings.textTransformers.v1'] ?? '[]')[0]?.body,
    ).toBe('Review the selected changes.');
    expect(host.querySelector('.transformer-detail')).not.toBeNull();
    expect(host.querySelectorAll('.transformer-row')).toHaveLength(0);
    expect(host.querySelector<HTMLTextAreaElement>('[data-snippet-field="body"]')?.value).toBe(
      'Electron retry draft',
    );
    expect(host.querySelector('.transformer-detail')?.textContent).toContain(
      en.settings.textTransformers.saveError,
    );
  });

  it('edits metadata-rich multiline snippets and filters them by tag', async () => {
    // Given: the snippet library renders metadata-rich entries as compact completion-style rows.
    const { host, settings, reopenSnippets } = await mountSnippetSettings();
    const cards = host.querySelectorAll('.transformer-row');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('Review changes');
    expect(cards[0]?.textContent).toContain('::review');
    expect(cards[0]?.textContent).toContain('Checks correctness');
    expect(cards[0]?.textContent).toContain('Review the selected changes.');
    expect(cards[0]?.querySelector('[data-snippet-field="name"]')).toBeNull();
    expect(cards[0]?.querySelector('.transformer-enable')).not.toBeNull();
    expect(cards[0]?.querySelector('.transformer-remove')).not.toBeNull();
    expect(cards[0]?.querySelector('.transformer-edit')).not.toBeNull();

    // When: the row toggle disables the snippet and the edit control opens the detail view.
    cards[0]?.querySelector<HTMLButtonElement>('.transformer-enable')?.click();
    await nextTick();
    cards[0]?.querySelector<HTMLButtonElement>('.transformer-edit')?.click();
    await nextTick();
    const detail = host.querySelector('.transformer-detail');
    expect(detail).not.toBeNull();
    expect(host.querySelectorAll('.transformer-row')).toHaveLength(0);
    expect(detail?.querySelector('.transformer-enable')).toBeNull();
    expect(detail?.querySelector('.transformer-remove')).toBeNull();
    inputValue(detail!.querySelector('[data-snippet-field="name"]')!, 'Strict review');
    inputValue(detail!.querySelector('[data-snippet-field="description"]')!, 'Find regressions');
    inputValue(detail!.querySelector('[data-snippet-field="tags"]')!, 'Review, Security');
    inputValue(detail!.querySelector('[data-snippet-field="body"]')!, 'Line one\nLine two');
    await nextTick();

    // Then: edits remain local until leaving the detail view.
    expect(settings.textTransformers.value[0]).toMatchObject({
      name: 'Review changes',
      description: 'Checks correctness',
      tags: ['Review', 'Quality'],
      body: 'Review the selected changes.',
    });
    expect(detail?.querySelector<HTMLInputElement>('[data-snippet-field="name"]')?.value).toBe(
      'Strict review',
    );
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: the valid batch is persisted, multiline content is retained, and filtering works.
    expect(settings.textTransformers.value[0]).toMatchObject({
      name: 'Strict review',
      description: 'Find regressions',
      tags: ['Review', 'Security'],
      body: 'Line one\nLine two',
      enabled: false,
    });
    const reviewFilter = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.transformer-tag-filter'),
    ).find((button) => button.textContent?.trim() === 'Review');
    expect(reviewFilter).toBeDefined();
    reviewFilter!.click();
    await nextTick();
    expect(host.querySelectorAll('.transformer-row')).toHaveLength(1);
    expect(host.querySelector('.transformer-row')?.textContent).toContain('Strict review');

    // When: editing changes only the active tag's display casing.
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    inputValue(host.querySelector('[data-snippet-field="tags"]')!, '');
    await nextTick();
    inputValue(host.querySelector('[data-snippet-field="tags"]')!, 'review, Security');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: the canonical active value follows the displayed tag and remains visibly selected.
    expect(host.querySelector('.transformer-tag-filter.is-active')?.textContent?.trim()).toBe(
      'review',
    );

    await reopenSnippets();
    expect(host.querySelector('.transformer-tag-filter.is-active')?.textContent?.trim()).toBe(
      'All',
    );
    expect(host.querySelectorAll('.transformer-row')).toHaveLength(2);
    Array.from(host.querySelectorAll<HTMLButtonElement>('.transformer-tag-filter'))
      .find((button) => button.textContent?.trim() === 'review')
      ?.click();
    await nextTick();

    // When: editing removes the active tag from its final matching snippet.
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    inputValue(host.querySelector('[data-snippet-field="tags"]')!, 'Security');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: the stale filter clears and the full library remains reachable.
    expect(host.querySelectorAll('.transformer-row')).toHaveLength(2);
    expect(host.querySelector('.transformer-tag-filter.is-active')?.textContent?.trim()).toBe(
      'All',
    );
  });
});
