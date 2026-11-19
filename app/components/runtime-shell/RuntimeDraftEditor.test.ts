import { createApp, h, nextTick, shallowRef } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RuntimeDraftEditor from './RuntimeDraftEditor.vue';
import type { DraftHeader } from '../../runtime/draftStore';
import type { createQualifiedComposerDrafts } from '../../runtime/qualifiedComposerDrafts';

vi.mock('../../locales/runtimeUi', () => ({ useRuntimeUi: () => ({ rt: (text: string) => text }) }));
const header: DraftHeader = { context: 'draft', clientOrigin: 'test', revision: 1, parts: [{ name: 'body', kind: 'body', bytes: 8, chunks: 1, sha256: '0'.repeat(64) }] };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function settle() { for (let index = 0; index < 8; index++) await nextTick(); }
describe('segmented draft storage recovery', () => {
  it('keeps edits made after a quota failure dirty after retrying the previous save', async () => {
    let pending = false;
    const saved = { ...header, revision: 2 };
    const storage: ReturnType<typeof createQualifiedComposerDrafts> = {
      read: async () => null, open: async () => header, write: async () => {},
      readPreferences: async () => ({ agent: '', model: '', variant: '' }), writePreferences: async () => {},
      initializeThread: async () => header,
      readBodySegment: async () => 'original',
      saveBodySegment: vi.fn(async () => { pending = true; throw new DOMException('quota', 'QuotaExceededError'); }),
      retry: vi.fn(async () => { pending = false; return saved; }),
      exportPart: async () => {}, usage: () => ({ residentBytes: 0, reservedBytes: 0, entries: 0 }),
      get recoveryPending() { return pending; },
    };
    const currentHeader = shallowRef(header);
    const editor = shallowRef<InstanceType<typeof RuntimeDraftEditor> | null>(null);
    const root = document.createElement('div'); document.body.appendChild(root);
    const app = createApp({ render: () => h(RuntimeDraftEditor, { ref: editor, context: 'draft', header: currentHeader.value, storage, onSaved: (next: DraftHeader) => { currentHeader.value = next; } }) });
    app.mount(root); cleanups.push(() => { app.unmount(); root.remove(); });
    await settle();
    const button = (text: string): HTMLButtonElement => {
      const result = [...root.querySelectorAll('button')].find(entry => entry.textContent === text);
      if (!result) throw new Error(`Missing ${text}`);
      return result;
    };
    const textarea = root.querySelector('textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Missing draft input');
    const input = async (value: string) => { textarea.value = value; textarea.dispatchEvent(new Event('input', { bubbles: true })); await settle(); };
    await input('saved-before-quota');
    button('Save segment').click(); await settle();
    expect(button('Save segment').disabled).toBe(true);
    expect(await editor.value?.flush()).toBe(false);
    expect(textarea.value).toBe('saved-before-quota');
    await input('edited-after-quota');
    button('Retry storage').click(); await settle();
    expect(textarea.value).toBe('edited-after-quota');
    expect(button('Save segment').disabled).toBe(false);
    expect(storage.saveBodySegment).toHaveBeenCalledOnce();
    expect(storage.retry).toHaveBeenCalledOnce();
  });
});
