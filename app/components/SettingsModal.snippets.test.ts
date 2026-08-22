import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';

const fileExport = vi.hoisted(() => ({ downloadJsonFile: vi.fn(), downloadTextFile: vi.fn() }));

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { 'data-icon': props.icon }),
}));
vi.mock('../utils/fileExport', () => fileExport);

const initialSnippets = [
  {
    id: 'snippet-review',
    trigger: '::review',
    name: 'Review changes',
    body: 'Review the selected changes.',
    description: 'Checks correctness',
    enabled: true,
    tags: ['Review', 'Quality'],
  },
  {
    id: 'snippet-write',
    trigger: 'write',
    name: 'Write draft',
    body: 'Write a concise draft.',
    enabled: false,
    tags: ['Writing'],
  },
] as const;

const mountedApps: Array<() => void> = [];

async function mountSnippetSettings(snippets: readonly object[] = initialSnippets) {
  localStorage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(snippets));
  const [{ default: SettingsModal }, { i18n }, { useSettings }] = await Promise.all([
    import('./SettingsModal.vue'),
    import('../i18n'),
    import('../composables/useSettings'),
  ]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const open = ref(true);
  const initialPage = ref<'transformers' | undefined>();
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(SettingsModal, {
            open: open.value,
            initialPage: initialPage.value,
            onClose: () => {
              open.value = false;
            },
          });
      },
    }),
  );
  app.use(i18n);
  app.mount(host);
  mountedApps.push(() => app.unmount());
  await nextTick();
  const link = Array.from(host.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(en.settings.textTransformers.label),
  );
  expect(link).toBeDefined();
  link!.click();
  await nextTick();
  return {
    host,
    settings: useSettings(),
    reopenSnippets: async () => {
      open.value = false;
      await nextTick();
      initialPage.value = 'transformers';
      open.value = true;
      await nextTick();
    },
  };
}

function inputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  inputValue(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  fileExport.downloadJsonFile.mockReset();
  fileExport.downloadTextFile.mockReset();
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
});

describe('SettingsModal snippets', () => {
  it('keeps migrated reserved triggers visibly and operationally disabled', async () => {
    // Given: legacy storage contains a reserved command trigger that migration retains.
    const legacyReserved = {
      id: 'snippet-legacy-command',
      trigger: '/legacy',
      name: 'Legacy command',
      body: 'Legacy body',
      enabled: true,
      tags: [],
    };
    const { host, settings } = await mountSnippetSettings([legacyReserved]);
    const enableButton = host.querySelector<HTMLButtonElement>('.transformer-enable')!;
    expect(settings.textTransformers.value[0]?.enabled).toBe(false);

    // When: the user inspects and clicks the row enable control.
    enableButton.click();
    await nextTick();

    // Then: the control is unavailable and cannot create contradictory raw state.
    expect(enableButton.disabled).toBe(true);
    expect(enableButton.getAttribute('aria-pressed')).toBe('false');
    expect(settings.textTransformers.value[0]?.enabled).toBe(false);
  });

  it('disables an enabled snippet immediately when its trigger becomes reserved', async () => {
    // Given: an enabled valid snippet is open in the detail editor.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();

    // When: its trigger is edited into the built-in command namespace.
    changeValue(host.querySelector('[data-snippet-field="trigger"]')!, '/legacy');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: reactive state, persisted state, and the row control all agree that it is disabled.
    expect(settings.textTransformers.value[0]).toMatchObject({ trigger: '/legacy', enabled: false });
    expect(JSON.parse(localStorage.getItem('opencode.settings.textTransformers.v1')!)[0]).toMatchObject(
      { trigger: '/legacy', enabled: false },
    );
    const enableButton = host.querySelector<HTMLButtonElement>('.transformer-enable')!;
    expect(enableButton.disabled).toBe(true);
    expect(enableButton.getAttribute('aria-pressed')).toBe('false');
  });

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
    expect(host.querySelector('.transformer-tag-filter.is-active')?.textContent?.trim()).toBe('All');
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
    expect(host.querySelector('.transformer-tag-filter.is-active')?.textContent?.trim()).toBe('All');
  });

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
    const file = new File([], 'snippets.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', {
      value: async () => JSON.stringify({ version: 1, snippets: [importedSnippet] }),
    });
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
    const readOversizedFile = vi.fn().mockResolvedValue('{}');
    const oversizedFile = new File([], 'oversized.json', { type: 'application/json' });
    Object.defineProperties(oversizedFile, {
      size: { configurable: true, value: 5 * 1024 * 1024 + 1 },
      text: { configurable: true, value: readOversizedFile },
    });
    Object.defineProperty(importInput, 'files', { configurable: true, value: [oversizedFile] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(host.querySelector('.transformer-import-status')?.textContent).toContain('invalid'),
    );

    // Then: the file is rejected before its contents are allocated or parsed.
    expect(readOversizedFile).not.toHaveBeenCalled();
  });

  it('keeps the newest file selection authoritative when imports resolve out of order', async () => {
    // Given: two valid imports collide and the first file read remains pending.
    const { host, settings } = await mountSnippetSettings();
    const importInput = host.querySelector<HTMLInputElement>('.transformer-import-input')!;
    let resolveOlder!: (value: string) => void;
    const olderFile = new File([], 'older.json', { type: 'application/json' });
    Object.defineProperty(olderFile, 'text', {
      value: () => new Promise<string>((resolve) => (resolveOlder = resolve)),
    });
    const newerFile = new File([], 'newer.json', { type: 'application/json' });
    Object.defineProperty(newerFile, 'text', {
      value: async () =>
        JSON.stringify({
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
        }),
    });

    // When: the newer import completes before the older file read.
    Object.defineProperty(importInput, 'files', { configurable: true, value: [olderFile] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));
    Object.defineProperty(importInput, 'files', { configurable: true, value: [newerFile] });
    importInput.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(settings.textTransformers.value.some((entry) => entry.body === 'Newer body')).toBe(true),
    );
    resolveOlder(
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
    const file = new File([], 'valid.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', {
      value: async () =>
        JSON.stringify({
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
        }),
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
    expect(JSON.parse(localStorage.getItem('opencode.settings.textTransformers.v1') ?? '[]')[0]).toMatchObject(
      { name: 'External review', trigger: '::review' },
    );

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

    // When: another stale edit is explicitly resolved with Overwrite.
    inputValue(host.querySelector('[data-snippet-field="name"]')!, 'Local overwrite');
    const externalAgain = [{ ...external[0]!, name: 'External again' }, external[1]!];
    localStorage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(externalAgain));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'opencode.settings.textTransformers.v1',
        newValue: JSON.stringify(externalAgain),
      }),
    );
    changeValue(host.querySelector('[data-snippet-field="name"]')!, 'Local overwrite');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.transformer-conflict-overwrite')!.click();
    await nextTick();

    // Then: only the explicit overwrite replaces the external row and persists the draft.
    expect(settings.textTransformers.value[0]?.name).toBe('Local overwrite');
    expect(JSON.parse(localStorage.getItem('opencode.settings.textTransformers.v1') ?? '[]')[0]).toMatchObject(
      { name: 'Local overwrite' },
    );
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
    const file = new File([], 'quota.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', {
      value: async () =>
        JSON.stringify({
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
        }),
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
    const file = new File([], 'oversized-merge.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', {
      value: async () => JSON.stringify({ version: 1, snippets: imported }),
    });

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
    const firstPreview = firstPageRows[0]?.querySelector('.snippet-completion-preview')?.textContent ?? '';
    expect(firstPreview.length).toBeLessThanOrEqual(240);
    expect(firstPreview).not.toContain('-tail-0');
    expect(host.querySelector('.transformer-pagination-status')?.textContent).toContain('1');
    host.querySelector<HTMLButtonElement>('.transformer-page-next')!.click();
    await nextTick();
    const secondPageRows = host.querySelectorAll('.transformer-row');
    expect(secondPageRows).toHaveLength(50);
    expect(secondPageRows[0]?.textContent).toContain('Snippet 50');
  });
});
