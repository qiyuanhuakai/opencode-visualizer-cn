import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import {
  registerSnippetSettingsLifecycle,
  mountSnippetSettings,
  initialSnippets,
  inputValue,
  changeValue,
} from './SettingsModal.snippets.shared';

registerSnippetSettingsLifecycle();

describe('SettingsModal snippets bounds', () => {
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
});
