import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  registerSnippetSettingsLifecycle,
  mountSnippetSettings,
  initialSnippets,
  changeValue,
} from './SettingsModal.snippets.shared';

registerSnippetSettingsLifecycle();

describe('SettingsModal snippets dialog', () => {
  it('labels the dialog and preserves native Escape dismissal', async () => {
    // Given: the settings dialog is open on the Snippets page.
    const { host } = await mountSnippetSettings();
    const dialog = host.querySelector('dialog');
    const title = host.querySelector('.modal-title');
    expect(dialog).not.toBeNull();
    expect(title).not.toBeNull();

    // When: assistive technology resolves the dialog name and the browser dispatches cancel.
    const cancel = new Event('cancel', { cancelable: true });
    const shouldContinue = dialog!.dispatchEvent(cancel);

    // Then: the visible title labels the dialog and Vue does not prevent native Escape closing.
    expect(title!.id).not.toBe('');
    expect(dialog!.getAttribute('aria-labelledby')).toBe(title!.id);
    expect(shouldContinue).toBe(true);
    expect(cancel.defaultPrevented).toBe(false);
  });

  it('moves focus into Add/Edit and restores the edited row on Back', async () => {
    // Given: keyboard focus starts on an existing Snippet edit action.
    const { host } = await mountSnippetSettings();
    const existingEdit = host.querySelector<HTMLButtonElement>('.transformer-edit');
    expect(existingEdit).not.toBeNull();
    existingEdit!.focus();

    // When: the existing Snippet opens and then returns to the library.
    existingEdit!.click();
    await nextTick();
    expect(document.activeElement).toBe(
      host.querySelector<HTMLInputElement>('[data-snippet-field="trigger"]'),
    );
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: focus returns to the same row's edit action.
    expect(document.activeElement).toBe(
      host.querySelector<HTMLButtonElement>('[data-snippet-id="snippet-review"]'),
    );

    // When: Add creates a new draft.
    host.querySelector<HTMLButtonElement>('.transformer-add')!.click();
    await nextTick();

    // Then: focus moves directly to its first editable field.
    expect(document.activeElement).toBe(
      host.querySelector<HTMLInputElement>('[data-snippet-field="trigger"]'),
    );
  });

  it('reveals a filtered Snippet on its original page before restoring Back focus', async () => {
    // Given: the edited Snippet is beyond the first page and shares the active tag with another row.
    const fillers = Array.from({ length: 51 }, (_, index) => ({
      ...initialSnippets[0],
      id: `snippet-filler-${index}`,
      trigger: `::filler-${index}`,
      name: `Filler ${index}`,
      tags: ['Other'],
    }));
    const { host } = await mountSnippetSettings([
      { ...initialSnippets[0], id: 'snippet-peer', trigger: '::peer', tags: ['Shared'] },
      ...fillers,
      { ...initialSnippets[0], id: 'snippet-target', trigger: '::target', tags: ['Shared'] },
    ]);
    Array.from(host.querySelectorAll<HTMLButtonElement>('.transformer-tag-filter'))
      .find((button) => button.textContent?.trim() === 'Shared')!
      .click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('[data-snippet-id="snippet-target"]')!.click();
    await nextTick();

    // When: the target leaves the active filter and Back commits the edit.
    changeValue(host.querySelector<HTMLInputElement>('[data-snippet-field="tags"]')!, 'Other');
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();
    await nextTick();
    await nextTick();

    // Then: filters are cleared, the target page is selected, and its rendered edit action owns focus.
    expect(host.querySelector('.transformer-tag-filter.is-active')?.textContent?.trim()).toBe(
      'All',
    );
    expect(document.activeElement).toBe(
      host.querySelector<HTMLButtonElement>('[data-snippet-id="snippet-target"]'),
    );
  });

  it('reveals a filtered invalid draft before restoring Back focus', async () => {
    // Given: a filtered target moves off-filter and its trigger makes the draft invalid.
    const { host } = await mountSnippetSettings([
      { ...initialSnippets[0], id: 'snippet-peer', trigger: '::peer', tags: ['Shared'] },
      { ...initialSnippets[0], id: 'snippet-target', trigger: '::target', tags: ['Shared'] },
    ]);
    Array.from(host.querySelectorAll<HTMLButtonElement>('.transformer-tag-filter'))
      .find((button) => button.textContent?.trim() === 'Shared')!
      .click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('[data-snippet-id="snippet-target"]')!.click();
    await nextTick();
    changeValue(host.querySelector<HTMLInputElement>('[data-snippet-field="tags"]')!, 'Other');
    changeValue(
      host.querySelector<HTMLInputElement>('[data-snippet-field="trigger"]')!,
      'bad trigger',
    );

    // When: Back rejects the invalid commit and returns to the library.
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();
    await nextTick();
    await nextTick();

    // Then: the retained draft is revealed and its rendered edit action owns focus.
    expect(host.querySelector('.transformer-tag-filter.is-active')?.textContent?.trim()).toBe(
      'All',
    );
    expect(document.activeElement).toBe(
      host.querySelector<HTMLButtonElement>('[data-snippet-id="snippet-target"]'),
    );
  });
});
