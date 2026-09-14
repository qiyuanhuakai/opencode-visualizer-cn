import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import {
  registerSnippetSettingsLifecycle,
  mountSnippetSettings,
  encodeUtf8,
  createJsonFile,
  getFileExport,
  inputValue,
} from './SettingsModal.snippets.shared';

const fileExport = getFileExport();

registerSnippetSettingsLifecycle();

describe('SettingsModal snippets imports', () => {
  it('adds, exports, and imports versioned snippet data from the settings surface', async () => {
    // Given: the snippet library toolbar is visible.
    const { host, settings } = await mountSnippetSettings();
    const addButton = host.querySelector<HTMLButtonElement>('.transformer-add')!;
    const exportButton = host.querySelector<HTMLButtonElement>('.transformer-export')!;
    const importInput = host.querySelector<HTMLInputElement>('.transformer-import-input')!;
    expect(addButton).not.toBeNull();
    expect(exportButton).not.toBeNull();
    expect(importInput).not.toBeNull();

    // When: one draft is added.
    addButton.click();
    await nextTick();

    // Then: a complete snippet draft exists and opens directly in its secondary detail view.
    expect(settings.textTransformers.value).toHaveLength(2);
    expect(host.querySelector('.transformer-detail')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-snippet-field="trigger"]')?.value).toBe('');

    // When: the user returns to the library and tries to export the invalid draft.
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('.transformer-export')!.click();
    await nextTick();

    // Then: no invalid backup is downloaded and a useful status is shown.
    expect(fileExport.downloadJsonFile).not.toHaveBeenCalled();
    expect(fileExport.downloadTextFile).not.toHaveBeenCalled();
    expect(host.querySelector('.transformer-import-status')?.textContent).toContain('invalid');

    // When: the draft receives a valid trigger and is exported again.
    const editButtons = host.querySelectorAll<HTMLButtonElement>('.transformer-edit');
    editButtons[editButtons.length - 1]!.click();
    await nextTick();
    inputValue(host.querySelector('[data-snippet-field="trigger"]')!, 'draft');
    inputValue(host.querySelector('[data-snippet-field="name"]')!, 'Draft');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('.transformer-export')!.click();

    // Then: the emitted payload can pass the same versioned import boundary.
    expect(fileExport.downloadTextFile).toHaveBeenCalledTimes(1);
    const exported = fileExport.downloadTextFile.mock.calls[0]?.[0];
    const { parseTextTransformerImport } = await import('../utils/snippets');
    expect(typeof exported === 'string' && exported.endsWith('\n')).toBe(false);
    expect(parseTextTransformerImport(String(exported))).toMatchObject({ ok: true });

    // When: a valid versioned file is selected for import.
    const importedSnippet = {
      id: 'snippet-imported',
      trigger: ';imported',
      name: 'Imported',
      body: 'Imported body',
      enabled: true,
      tags: ['Imported'],
    };
    const file = createJsonFile('snippets.json', { version: 1, snippets: [importedSnippet] });
    Object.defineProperty(importInput, 'files', { configurable: true, value: [file] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Then: imported entries merge without deleting local snippets and success is announced.
    await vi.waitFor(() => {
      expect(settings.textTransformers.value.some((item) => item.id === 'snippet-imported')).toBe(
        true,
      );
    });
    expect(host.querySelector('.transformer-import-status')?.textContent).toContain('Imported');

    // When: a file larger than the public import limit is selected.
    const readOversizedFile = vi.fn().mockResolvedValue(encodeUtf8('{}'));
    const oversizedFile = new File([], 'oversized.json', { type: 'application/json' });
    Object.defineProperties(oversizedFile, {
      size: { configurable: true, value: 5 * 1024 * 1024 + 1 },
      arrayBuffer: { configurable: true, value: readOversizedFile },
    });
    Object.defineProperty(importInput, 'files', { configurable: true, value: [oversizedFile] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(host.querySelector('.transformer-import-status')?.textContent).toContain('invalid'),
    );

    // Then: the file is rejected before its contents are allocated or parsed.
    expect(readOversizedFile).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 import bytes without changing the library', async () => {
    // Given: a JSON-shaped import contains an invalid UTF-8 byte inside a snippet name.
    const { host, settings } = await mountSnippetSettings();
    const prefix = new TextEncoder().encode(
      '{"version":1,"snippets":[{"id":"invalid-utf8","trigger":"invalid-utf8","name":"',
    );
    const suffix = new TextEncoder().encode('","body":"body","enabled":true,"tags":[]}]}');
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix);
    bytes[prefix.length] = 0x80;
    bytes.set(suffix, prefix.length + 1);
    const file = new File([bytes], 'invalid-utf8.json', { type: 'application/json' });
    const importInput = host.querySelector<HTMLInputElement>('.transformer-import-input')!;

    // When: the malformed bytes cross the file import boundary.
    Object.defineProperty(importInput, 'files', { configurable: true, value: [file] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Then: no replacement-character value is imported or persisted.
    await vi.waitFor(() =>
      expect(host.querySelector('.transformer-import-status')?.textContent).toBe(
        en.settings.textTransformers.importErrors.invalidJson,
      ),
    );
    expect(settings.textTransformers.value.some(({ id }) => id === 'invalid-utf8')).toBe(false);
  });

  it('keeps the newest file selection authoritative when imports resolve out of order', async () => {
    // Given: two valid imports collide and the first file read remains pending.
    const { host, settings } = await mountSnippetSettings();
    const importInput = host.querySelector<HTMLInputElement>('.transformer-import-input')!;
    let resolveOlder!: (value: ArrayBuffer) => void;
    const olderFile = new File([], 'older.json', { type: 'application/json' });
    Object.defineProperty(olderFile, 'arrayBuffer', {
      value: () => new Promise<ArrayBuffer>((resolve) => (resolveOlder = resolve)),
    });
    const newerFile = createJsonFile('newer.json', {
      version: 1,
      snippets: [
        {
          id: 'snippet-race',
          trigger: 'race',
          name: 'Newer',
          body: 'Newer body',
          enabled: true,
          tags: [],
        },
      ],
    });

    // When: the newer import completes before the older file read.
    Object.defineProperty(importInput, 'files', { configurable: true, value: [olderFile] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));
    Object.defineProperty(importInput, 'files', { configurable: true, value: [newerFile] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(settings.textTransformers.value.some((entry) => entry.body === 'Newer body')).toBe(
        true,
      ),
    );
    resolveOlder(
      encodeUtf8(
        JSON.stringify({
          version: 1,
          snippets: [
            {
              id: 'snippet-race',
              trigger: 'race',
              name: 'Older',
              body: 'Older body',
              enabled: true,
              tags: [],
            },
          ],
        }),
      ),
    );
    await nextTick();

    // Then: the stale read cannot overwrite the later user selection.
    expect(settings.textTransformers.value.find((entry) => entry.id === 'snippet-race')?.body).toBe(
      'Newer body',
    );
  });

  it('does not import over an unfinished local draft', async () => {
    // Given: the local list contains a newly added snippet with an invalid empty trigger.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-add')!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();
    expect(settings.textTransformers.value).toHaveLength(2);
    expect(host.querySelectorAll('.transformer-row')).toHaveLength(3);
    const importInput = host.querySelector<HTMLInputElement>('.transformer-import-input')!;
    const file = createJsonFile('valid.json', {
      version: 1,
      snippets: [
        {
          id: 'snippet-import-blocked',
          trigger: 'imported',
          name: 'Imported',
          body: 'Imported body',
          enabled: true,
          tags: [],
        },
      ],
    });

    // When: a valid import is selected before the draft is completed.
    Object.defineProperty(importInput, 'files', { configurable: true, value: [file] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(host.querySelector('.transformer-import-status')?.textContent).toContain('invalid'),
    );

    // Then: neither the draft nor any persisted local snippet is discarded for the import.
    expect(settings.textTransformers.value.some(({ id }) => id === 'snippet-import-blocked')).toBe(
      false,
    );
    expect(host.querySelectorAll('.transformer-row')).toHaveLength(3);
  });
});
