import { nextTick } from 'vue';
// allow: SIZE_OK — conflict recovery and explicit overwrite cases stay in one requested suite.
import { describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import {
  registerSnippetSettingsLifecycle,
  mountSnippetSettings,
  initialSnippets,
  createJsonFile,
  getFileExport,
  inputValue,
  changeValue,
} from './SettingsModal.snippets.shared';

const fileExport = getFileExport();

registerSnippetSettingsLifecycle();

describe('SettingsModal snippets conflicts', () => {
  it('isolates invalid detail drafts and rejects stale commits after an external row update', async () => {
    // Given: the first persisted snippet is open and another valid trigger already exists.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();

    // When: the local trigger becomes a duplicate and another window updates the persisted row.
    inputValue(host.querySelector('[data-snippet-field="trigger"]')!, 'write');
    await nextTick();
    expect(settings.textTransformers.value[0]?.trigger).toBe('::review');
    const external = [{ ...initialSnippets[0], name: 'External review' }, initialSnippets[1]];
    localStorage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(external));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'opencode.settings.textTransformers.v1',
        newValue: JSON.stringify(external),
      }),
    );
    await nextTick();

    // Then: runtime state accepts the external update while the unsaved draft remains local.
    expect(settings.textTransformers.value[0]?.name).toBe('External review');
    expect(host.querySelector<HTMLInputElement>('[data-snippet-field="trigger"]')?.value).toBe(
      'write',
    );

    // When: the draft becomes valid but is committed against its stale base revision.
    changeValue(host.querySelector('[data-snippet-field="trigger"]')!, 'review-new');
    await nextTick();

    // Then: the first commit is rejected without overwriting the external row or losing the draft.
    expect(settings.textTransformers.value[0]).toMatchObject({
      name: 'External review',
      trigger: '::review',
    });
    expect(host.querySelector<HTMLInputElement>('[data-snippet-field="trigger"]')?.value).toBe(
      'review-new',
    );
    expect(host.querySelector('.transformer-detail')?.textContent).toContain(
      en.settings.textTransformers.conflictError,
    );

    // When: leaving the detail view would otherwise perform a second implicit commit.
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: the conflict remains latched and the external row cannot be overwritten implicitly.
    expect(host.querySelector('.transformer-detail')).not.toBeNull();
    expect(settings.textTransformers.value[0]).toMatchObject({
      name: 'External review',
      trigger: '::review',
    });
    expect(
      JSON.parse(localStorage.getItem('opencode.settings.textTransformers.v1') ?? '[]')[0],
    ).toMatchObject({ name: 'External review', trigger: '::review' });

    // When: the user explicitly reloads the externally saved row.
    host.querySelector<HTMLButtonElement>('.transformer-conflict-reload')!.click();
    await nextTick();

    // Then: the conflict clears and the detail fields show the authoritative external values.
    expect(host.querySelector<HTMLInputElement>('[data-snippet-field="name"]')?.value).toBe(
      'External review',
    );
    expect(host.querySelector<HTMLInputElement>('[data-snippet-field="trigger"]')?.value).toBe(
      '::review',
    );
    expect(host.querySelector('.transformer-conflict-reload')).toBeNull();
  });

  it('persists a stale draft only after explicit conflict overwrite', async () => {
    // Given: a local detail edit races with an external update of the same row.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    inputValue(host.querySelector('[data-snippet-field="name"]')!, 'Local overwrite');
    const external = [{ ...initialSnippets[0], name: 'External again' }, initialSnippets[1]];
    localStorage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(external));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'opencode.settings.textTransformers.v1',
        newValue: JSON.stringify(external),
      }),
    );

    // When: the stale change is submitted and then explicitly overwritten.
    changeValue(host.querySelector('[data-snippet-field="name"]')!, 'Local overwrite');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.transformer-conflict-overwrite')!.click();
    await nextTick();

    // Then: only the explicit overwrite replaces the external row and persists the draft.
    expect(settings.textTransformers.value[0]?.name).toBe('Local overwrite');
    expect(
      JSON.parse(localStorage.getItem('opencode.settings.textTransformers.v1') ?? '[]')[0],
    ).toMatchObject({ name: 'Local overwrite' });
  });

  it('requires explicit overwrite after external storage publishes rejected recovery data', async () => {
    // Given: a local detail edit is open when another window publishes malformed raw storage.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    inputValue(host.querySelector('[data-snippet-field="name"]')!, 'Local recovery overwrite');
    localStorage.setItem('opencode.settings.textTransformers.v1', 'not-json');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'opencode.settings.textTransformers.v1',
        newValue: 'not-json',
      }),
    );
    await nextTick();

    // When: an ordinary change and Back both attempt to commit the still-valid local draft.
    changeValue(host.querySelector('[data-snippet-field="name"]')!, 'Local recovery overwrite');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: recovery data and the local draft remain intact behind the conflict latch.
    expect(localStorage.getItem('opencode.settings.textTransformers.v1')).toBe('not-json');
    expect(host.querySelector('.transformer-detail')).not.toBeNull();
    expect(host.querySelector('.transformer-detail')?.textContent).toContain(
      en.settings.textTransformers.conflictError,
    );
    expect(host.querySelector<HTMLInputElement>('[data-snippet-field="name"]')?.value).toBe(
      'Local recovery overwrite',
    );

    // When: the user explicitly chooses Overwrite.
    host.querySelector<HTMLButtonElement>('.transformer-conflict-overwrite')!.click();
    await nextTick();

    // Then: the valid draft deliberately replaces recovery data and clears the conflict.
    expect(settings.textTransformers.value[0]?.name).toBe('Local recovery overwrite');
    expect(
      JSON.parse(localStorage.getItem('opencode.settings.textTransformers.v1') ?? '[]')[0],
    ).toMatchObject({ name: 'Local recovery overwrite' });
    expect(host.querySelector('.transformer-conflict-overwrite')).toBeNull();
  });

  it('keeps a failed explicit overwrite latched against a later close retry', async () => {
    // Given: a local edit conflicts with an external row and the next persistence write will fail.
    const { host, settings, reopenSnippets } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    inputValue(host.querySelector('[data-snippet-field="name"]')!, 'Local retry candidate');
    const external = [{ ...initialSnippets[0], name: 'External winner' }, initialSnippets[1]];
    localStorage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(external));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'opencode.settings.textTransformers.v1',
        newValue: JSON.stringify(external),
      }),
    );
    await nextTick();
    changeValue(host.querySelector('[data-snippet-field="name"]')!, 'Local retry candidate');
    await nextTick();
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    // When: explicit Overwrite fails and Settings is then closed and reopened.
    host.querySelector<HTMLButtonElement>('.transformer-conflict-overwrite')!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('.modal-close-button')!.click();
    await nextTick();
    await reopenSnippets();

    // Then: Close cannot retry implicitly; the external row, draft, and conflict all remain.
    expect(settings.textTransformers.value[0]?.name).toBe('External winner');
    expect(
      JSON.parse(localStorage.getItem('opencode.settings.textTransformers.v1') ?? '[]')[0]?.name,
    ).toBe('External winner');
    expect(host.querySelector<HTMLInputElement>('[data-snippet-field="name"]')?.value).toBe(
      'Local retry candidate',
    );
    expect(host.querySelector('.transformer-conflict-overwrite')).not.toBeNull();
  });

  it('finalizes clean drafts on close and reopens unresolved drafts directly', async () => {
    // Given: a persisted row is opened without edits.
    const { host, reopenSnippets } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();

    // When: Settings closes and reopens on the Snippets page.
    await reopenSnippets();
    host.querySelector<HTMLButtonElement>('.transformer-export')!.click();

    // Then: the clean draft was finalized and no longer blocks export.
    expect(fileExport.downloadTextFile).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.transformer-detail')).toBeNull();

    // When: a new invalid draft exists while Settings closes and reopens.
    host.querySelector<HTMLButtonElement>('.transformer-add')!.click();
    await nextTick();
    await reopenSnippets();

    // Then: the unresolved draft reopens directly instead of becoming a phantom list row.
    expect(host.querySelector('.transformer-detail')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-snippet-field="trigger"]')?.value).toBe('');
  });

  it('reports an import error when persistence rejects the merged library', async () => {
    // Given: storage rejects the next otherwise valid imported value.
    const { host, settings } = await mountSnippetSettings();
    const importInput = host.querySelector<HTMLInputElement>('.transformer-import-input')!;
    const before = settings.textTransformers.value;
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const file = createJsonFile('quota.json', {
      version: 1,
      snippets: [
        {
          id: 'snippet-quota',
          trigger: 'quota',
          name: 'Quota',
          body: 'Quota body',
          enabled: true,
          tags: [],
        },
      ],
    });

    // When: the settings import tries to persist the merged data.
    Object.defineProperty(importInput, 'files', { configurable: true, value: [file] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(host.querySelector('.transformer-import-status')?.textContent).toContain('invalid'),
    );

    // Then: success is not reported and the previous library remains authoritative.
    expect(settings.textTransformers.value).toEqual(before);
    setItem.mockRestore();
  });

  it('rejects imports while malformed external recovery data is pending', async () => {
    // Given: valid runtime state has rejected malformed external raw storage.
    const { host, settings } = await mountSnippetSettings();
    localStorage.setItem('opencode.settings.textTransformers.v1', 'not-json');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'opencode.settings.textTransformers.v1',
        newValue: 'not-json',
      }),
    );
    await nextTick();
    const importInput = host.querySelector<HTMLInputElement>('.transformer-import-input')!;
    const file = createJsonFile('recovery-import.json', {
      version: 1,
      snippets: [
        {
          id: 'snippet-recovery-import',
          trigger: 'recovery-import',
          name: 'Recovery import',
          body: 'Recovery import body',
          enabled: true,
          tags: [],
        },
      ],
    });

    // When: the user selects a valid import without explicitly resolving recovery data.
    Object.defineProperty(importInput, 'files', { configurable: true, value: [file] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(host.querySelector('.transformer-import-status')?.textContent).toContain('invalid'),
    );

    // Then: raw recovery and runtime remain unchanged and no success state is reported.
    expect(localStorage.getItem('opencode.settings.textTransformers.v1')).toBe('not-json');
    expect(settings.textTransformers.value).toEqual(initialSnippets);
    expect(host.querySelector('.transformer-import-status')?.textContent).not.toContain('Imported');
  });

  it('rejects an import whose merged library exceeds the complete backup budget', async () => {
    // Given: local and imported collections are independently valid but exceed five MiB together.
    const body = 'x'.repeat(850_000);
    const current = Array.from({ length: 3 }, (_, index) => ({
      ...initialSnippets[0],
      id: `current-large-${index}`,
      trigger: `current-large-${index}`,
      body,
    }));
    const imported = Array.from({ length: 3 }, (_, index) => ({
      ...initialSnippets[0],
      id: `imported-large-${index}`,
      trigger: `imported-large-${index}`,
      body: 'y'.repeat(900_000),
    }));
    const { host, settings } = await mountSnippetSettings(current);
    const importInput = host.querySelector<HTMLInputElement>('.transformer-import-input')!;
    const file = createJsonFile('oversized-merge.json', { version: 1, snippets: imported });

    // When: the valid file is selected for merge.
    Object.defineProperty(importInput, 'files', { configurable: true, value: [file] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Then: the aggregate boundary rejects it without mutating the local collection.
    await vi.waitFor(() =>
      expect(host.querySelector('.transformer-import-status')?.textContent).toContain('invalid'),
    );
    expect(settings.textTransformers.value).toEqual(current);
  });

  it('paginates bounded previews instead of mounting the complete library and bodies', async () => {
    // Given: the settings library contains 120 snippets with bodies longer than the preview budget.
    const snippets = Array.from({ length: 120 }, (_, index) => ({
      ...initialSnippets[0],
      id: `snippet-page-${index}`,
      trigger: `page-${index}`,
      name: `Snippet ${index}`,
      body: `Body ${index}-${'x'.repeat(500)}-tail-${index}`,
    }));
    const { host } = await mountSnippetSettings(snippets);

    // When: the first settings page is rendered.
    const firstPageRows = host.querySelectorAll('.transformer-row');

    // Then: only 50 bounded previews are mounted and the remaining pages stay reachable.
    expect(firstPageRows).toHaveLength(50);
    const firstPreview =
      firstPageRows[0]?.querySelector('.snippet-completion-preview')?.textContent ?? '';
    expect(firstPreview.length).toBeLessThanOrEqual(240);
    expect(firstPreview).not.toContain('-tail-0');
    expect(host.querySelector('.transformer-pagination-status')?.textContent).toContain('1');
    host.querySelector<HTMLButtonElement>('.transformer-page-next')!.click();
    await nextTick();
    const secondPageRows = host.querySelectorAll('.transformer-row');
    expect(secondPageRows).toHaveLength(50);
    expect(secondPageRows[0]?.textContent).toContain('Snippet 50');
  });

  it.each(['__proto__', 'constructor', 'toString', '__v_raw', '__v_isReactive'])(
    'edits an imported Snippet whose id is %s',
    async (id) => {
      // Given: a valid imported Snippet uses an ID inherited by ordinary object prototypes.
      const snippet = {
        ...initialSnippets[0],
        id,
        trigger: `prototype-${id.length}`,
        name: `Prototype ${id}`,
      };
      const { host, settings } = await mountSnippetSettings([snippet]);

      // When: the user opens the row, changes its name, and commits with Back.
      host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
      await nextTick();
      changeValue(host.querySelector('[data-snippet-field="name"]')!, `Edited ${id}`);
      changeValue(host.querySelector('[data-snippet-field="tags"]')!, 'Vue, Reserved');
      await nextTick();
      host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
      await nextTick();

      // Then: that exact ID remains editable and persists without prototype interference.
      expect(settings.textTransformers.value).toEqual([
        { ...snippet, name: `Edited ${id}`, tags: ['Vue', 'Reserved'] },
      ]);
    },
  );
});
