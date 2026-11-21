import { nextTick } from 'vue';
import { expect, it, vi } from 'vitest';
import type { DraftHeader } from './runtime/draftStore';
import { mountRuntimeApp } from './test/runtimeAppHarness';

it('retries migration through the real App using the same failed archive owner and closes it on unmount', async () => {
  // The App, migration pipeline and Bridge are real; local storage is controlled
  // so a checkpoint can fail before admission without relying on browser quota.
  const headers = new Map<string, DraftHeader>(), checkpoints = new Map<string, unknown>();
  const parts = new Map<string, Uint8Array[]>();
  const writers: number[] = [], closed = new Set<number>(), retried = new Set<number>();
  let firstFailure = true, opens = 0;
  const fixture = await mountRuntimeApp([], { draftStore: async () => {
    const id = opens++;
    let paused = false, pending: { key: string; value: unknown } | undefined;
    return {
      get paused() { return paused; },
      async retry() { retried.add(id); paused = false; if (pending) { checkpoints.set(pending.key, pending.value); pending = undefined; } },
      close() { closed.add(id); },
      async readCheckpoint(key: string) { return checkpoints.get(key); },
      async readCheckpoints(keys: readonly string[]) { return keys.map(key => checkpoints.get(key)); },
      async checkpoint(key: string, value: unknown) {
        if (paused) throw new Error('archive still paused');
        if (key === 'migration-active') writers.push(id);
        if (key === 'migration-active' && firstFailure) {
          firstFailure = false; paused = true; pending = { key, value };
          throw new DOMException('migration quota test', 'QuotaExceededError');
        }
        checkpoints.set(key, value);
      },
      async writeChunk(identity: { context: string }, part: { index: number; bytes: Uint8Array }) {
        const values = parts.get(identity.context) ?? []; values[part.index] = part.bytes.slice(); parts.set(identity.context, values);
      },
      async commit(header: DraftHeader) { headers.set(header.context, header); },
      async header(identity: { context: string }) { return headers.get(identity.context); },
      async page({ after, limit = 100 }: { after?: string; limit?: number }) {
        const values = [...headers.values()].sort((a, b) => a.context.localeCompare(b.context)).filter(header => !after || header.context > after);
        const page = values.slice(0, limit); return { headers: page, next: values.length > limit ? page.at(-1)!.context : null };
      },
      async *readPart(header: DraftHeader) { yield* parts.get(header.context) ?? []; },
    };
  } });
  const previousIdb = Object.getOwnPropertyDescriptor(window, 'indexedDB');
  try {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: { databases: async () => [] } });
    await fixture.connect();
    fixture.element.querySelector<HTMLButtonElement>('button[title="Settings"]')!.click(); await nextTick();
    const menu = [...fixture.element.querySelectorAll<HTMLElement>('dialog[open][aria-labelledby="settings-modal-title"] .setting-link-row')].find(entry => entry.textContent?.includes('Migrate workspace data'));
    expect(menu).toBeDefined(); menu!.click();
    await vi.waitFor(() => expect(fixture.element.querySelector('[data-testid="migration-start"]')).not.toBeNull());
    const start = fixture.element.querySelector<HTMLButtonElement>('[data-testid="migration-start"]')!;
    start.click(); start.click();
    await vi.waitFor(() => expect(fixture.element.querySelector('[data-testid="migration-error"]')?.textContent).toContain('Local storage is full'));
    expect(fixture.element.querySelector('[data-testid="migration-error"]')?.textContent).not.toContain('migration quota test');
    expect(writers).toHaveLength(1);
    const failedOwner = writers[0]!;
    fixture.element.querySelector<HTMLButtonElement>('[data-testid="migration-retry"]')!.click();
    await vi.waitFor(() => expect(fixture.element.querySelector('[data-testid="migration-result"]')?.textContent).toContain('Local backup only'), { timeout: 10000 });
    expect(new Set(writers)).toEqual(new Set([failedOwner]));
    expect(retried.has(failedOwner)).toBe(true);
    await fixture.unmount();
    await vi.waitFor(() => expect(closed.has(failedOwner)).toBe(true));
  } finally {
    await fixture.unmount();
    if (previousIdb) Object.defineProperty(window, 'indexedDB', previousIdb); else Reflect.deleteProperty(window, 'indexedDB');
  }
}, 30000);
