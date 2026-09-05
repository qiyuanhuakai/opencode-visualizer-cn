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

function encodeUtf8(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

function createJsonFile(name: string, value: unknown): File {
  return new File([JSON.stringify(value)], name, { type: 'application/json' });
}

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
  Reflect.deleteProperty(window, 'electronAPI');
  fileExport.downloadJsonFile.mockReset();
  fileExport.downloadTextFile.mockReset();
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
});

describe('SettingsModal snippets', () => {
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

  it('surfaces rejected startup storage without replacing its recovery data', async () => {
    // Given: startup storage exceeds the complete library contract.
    const excessive = Array.from({ length: 1_001 }, (_, index) => ({
      id: `startup-ui-${index}`,
      trigger: `startup-ui-${index}`,
      name: `Startup UI ${index}`,
      body: 'Body',
      enabled: true,
      tags: [],
    }));
    const raw = JSON.stringify(excessive);

    // When: the Snippets settings page opens.
    const { host, settings } = await mountSnippetSettings(excessive);

    // Then: invalid rows stay out of runtime, raw recovery survives, and the error is visible.
    expect(settings.textTransformers.value).toEqual([]);
    expect(localStorage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
    expect(host.querySelector('.transformer-import-status')?.textContent).toContain(
      en.settings.textTransformers.saveError,
    );
  });

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
    expect(settings.textTransformers.value[0]).toMatchObject({
      trigger: '/legacy',
      enabled: false,
    });
    expect(
      JSON.parse(localStorage.getItem('opencode.settings.textTransformers.v1')!)[0],
    ).toMatchObject({ trigger: '/legacy', enabled: false });
    const enableButton = host.querySelector<HTMLButtonElement>('.transformer-enable')!;
    expect(enableButton.disabled).toBe(true);
    expect(enableButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('bounds an oversized trigger paste before rendering validation', async () => {
    // Given: a persisted snippet is open in the detail editor.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    const triggerInput = host.querySelector<HTMLInputElement>('[data-snippet-field="trigger"]')!;

    // When: the user pastes a trigger much larger than the public schema permits.
    inputValue(triggerInput, 'x'.repeat(50_000));
    await nextTick();

    // Then: the editable DOM is bounded and no uncommitted value enters runtime state.
    expect(triggerInput.value).toHaveLength(256);
    expect(settings.textTransformers.value[0]?.trigger).toBe('::review');
  });

  it('bounds every free-text draft before reactive assignment', async () => {
    // Given: the detail editor is open and receives programmatic values beyond every schema limit.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    const nameInput = host.querySelector<HTMLInputElement>('[data-snippet-field="name"]')!;
    const descriptionInput = host.querySelector<HTMLInputElement>(
      '[data-snippet-field="description"]',
    )!;
    const bodyInput = host.querySelector<HTMLTextAreaElement>('[data-snippet-field="body"]')!;

    // When: input events bypass native maxlength enforcement and Back commits the draft.
    inputValue(nameInput, 'n'.repeat(612));
    inputValue(descriptionInput, 'd'.repeat(4_196));
    inputValue(bodyInput, 'b'.repeat(1024 * 1024 + 100));
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: DOM, runtime, and persistence retain only the maximum legal values.
    expect(nameInput.maxLength).toBe(512);
    expect(descriptionInput.maxLength).toBe(4_096);
    expect(bodyInput.maxLength).toBe(1024 * 1024);
    expect(settings.textTransformers.value[0]?.name).toHaveLength(512);
    expect(settings.textTransformers.value[0]?.description).toHaveLength(4_096);
    expect(settings.textTransformers.value[0]?.body).toHaveLength(1024 * 1024);
    const persisted = JSON.parse(
      localStorage.getItem('opencode.settings.textTransformers.v1') ?? '[]',
    )[0];
    expect(persisted.name).toHaveLength(512);
    expect(persisted.description).toHaveLength(4_096);
    expect(persisted.body).toHaveLength(1024 * 1024);
  });

  it('keeps field and tag truncation boundaries Unicode well-formed', async () => {
    // Given: a detail editor receives emoji whose surrogate pairs cross two independent limits.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    const nameInput = host.querySelector<HTMLInputElement>('[data-snippet-field="name"]')!;
    const tagInput = host.querySelector<HTMLInputElement>('[data-snippet-field="tags"]')!;

    // When: input processing truncates the field and each parsed tag before Back commits them.
    inputValue(nameInput, `${'n'.repeat(511)}😀suffix`);
    inputValue(tagInput, `${'t'.repeat(255)}😀suffix`);
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: no persisted boundary ends with an unpaired surrogate.
    expect(settings.textTransformers.value[0]?.name).toBe('n'.repeat(511));
    expect(settings.textTransformers.value[0]?.name.isWellFormed()).toBe(true);
    expect(settings.textTransformers.value[0]?.tags).toEqual(['t'.repeat(255)]);
    expect(settings.textTransformers.value[0]?.tags[0]?.isWellFormed()).toBe(true);
  });

  it.each([
    ['trigger', '::review'],
    ['name', 'Review changes'],
    ['description', 'Checks correctness'],
    ['body', 'Review the selected changes.'],
  ] as const)(
    'rejects a lone high surrogate in the %s field without altering it',
    async (field, original) => {
      // Given: one editable field receives malformed UTF-16 below its length limit.
      const { host, settings } = await mountSnippetSettings();
      host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
      await nextTick();
      const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-snippet-field="${field}"]`,
      )!;

      // When: Back attempts to commit that malformed draft through shared validation.
      inputValue(input, `valid\ud83d`);
      host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
      await nextTick();

      // Then: validation sees the unaltered malformed value and preserves canonical settings.
      expect(settings.textTransformers.value[0]?.[field]).toBe(original);
    },
  );

  it('rejects a lone high surrogate tag without silently deleting it', async () => {
    // Given: the tag editor receives malformed UTF-16 below the per-tag limit.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    const tagInput = host.querySelector<HTMLInputElement>('[data-snippet-field="tags"]')!;

    // When: Back attempts to commit the malformed tag draft.
    inputValue(tagInput, `valid\ud83d`);
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: canonical tags remain unchanged rather than accepting a shortened value.
    expect(settings.textTransformers.value[0]?.tags).toEqual(['Review', 'Quality']);
  });

  it('bounds a large tag draft before splitting it into collection state', async () => {
    // Given: a detail editor receives more maximum-sized tags than the schema accepts.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    const tagInput = host.querySelector<HTMLInputElement>('[data-snippet-field="tags"]')!;
    const oversizedTags = Array.from({ length: 300 }, (_, index) =>
      `${index}`.padEnd(256, 'x'),
    ).join(',');

    // When: the complete oversized value is pasted at once.
    inputValue(tagInput, oversizedTags);
    await nextTick();

    // Then: the raw draft is bounded before split allocation and persisted state remains isolated.
    expect(tagInput.value.length).toBeLessThanOrEqual(66_046);
    expect(tagInput.maxLength).toBe(66_046);
    expect(settings.textTransformers.value[0]?.tags).toEqual(['Review', 'Quality']);
  });

  it('bounds many short unique tags before returning to the snippet list', async () => {
    // Given: a detail editor receives the maximum raw draft length as short unique tags.
    const { host, settings } = await mountSnippetSettings();
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    const tagInput = host.querySelector<HTMLInputElement>('[data-snippet-field="tags"]')!;
    const manyTags = Array.from({ length: 40_000 }, (_, index) => index.toString(36)).join(',');
    const boundedDraft = manyTags.slice(0, tagInput.maxLength);
    const splitSpy = vi.spyOn(String.prototype, 'split');

    // When: the raw value crosses the input boundary and the user returns to the list.
    inputValue(tagInput, manyTags);
    const eagerlySplitWholeDraft = splitSpy.mock.contexts.some(
      (context, index) =>
        String(context) === boundedDraft && String(splitSpy.mock.calls[index]?.[0]) === ',',
    );
    splitSpy.mockRestore();
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: parsing stops without splitting the whole draft and the compact row summarizes overflow tags.
    expect(eagerlySplitWholeDraft).toBe(false);
    expect(settings.textTransformers.value[0]?.tags).toHaveLength(256);
    expect(host.querySelectorAll('.transformer-tag-filter').length).toBeLessThanOrEqual(258);
    const renderedTags = Array.from(
      host.querySelector('.transformer-row')?.querySelectorAll('.snippet-completion-tag') ?? [],
    );
    expect(renderedTags).toHaveLength(5);
    expect(renderedTags[4]?.textContent?.trim()).toBe('+252');
  });

  it('round-trips the maximum valid tag collection through the detail input', async () => {
    // Given: one valid snippet contains 256 unique tags of 256 characters each.
    const tags = Array.from({ length: 256 }, (_, index) =>
      `${index.toString(36)}-`.padEnd(256, 'x'),
    );
    const snippet = { ...initialSnippets[0], tags };
    const { host, settings } = await mountSnippetSettings([snippet]);
    host.querySelector<HTMLButtonElement>('.transformer-edit')!.click();
    await nextTick();
    const tagInput = host.querySelector<HTMLInputElement>('[data-snippet-field="tags"]')!;

    // When: the unchanged canonical tag text crosses the input and Back commit boundaries.
    inputValue(tagInput, tagInput.value);
    host.querySelector<HTMLButtonElement>('.modal-back-button')!.click();
    await nextTick();

    // Then: every maximum-length tag survives without truncating the final entry.
    expect(tagInput.maxLength).toBe(66_046);
    expect(settings.textTransformers.value[0]?.tags).toEqual(tags);
    expect(
      JSON.parse(localStorage.getItem('opencode.settings.textTransformers.v1') ?? '[]')[0]?.tags,
    ).toEqual(tags);
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
