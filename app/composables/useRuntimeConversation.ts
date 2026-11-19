import { shallowRef, readonly } from 'vue';
import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import type { HarnessKind } from '../../shared/runtime/harnessContract.js';
import type { RuntimeClient } from '../runtime/client';
import type { SelectionCapture } from '../runtime/selectionScope';
import { createHistorySource } from '../runtime/historySource';
import { createHistoryCache } from '../runtime/historyCache';
import { createMemoryBudget } from '../runtime/entityCache';
import { createNativeHistoryProjection } from '../runtime/nativeHistory';

export function useRuntimeConversation(options: { publish(entries: unknown[]): void }) {
  const loading = shallowRef(false);
  const error = shallowRef('');
  const hasMore = shallowRef(false);
  let revision = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let selectedKind: HarnessKind | undefined;
  const historyBudget = createMemoryBudget({ maxBytes: 16 * 1024 * 1024, maxEntries: 1024 });

  function stopPolling() {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function schedulePoll(current: number) {
    stopPolling();
    if (!cache?.canPoll) return;
    pollTimer = setTimeout(() => { void poll(current); }, 1000);
  }

  async function poll(current: number) {
    const owner = cache;
    const selected = capture;
    if (!owner || !selected || !selectedKind || current !== revision || !selected.isCurrent()) return;
    try {
      if (!loading.value) {
        const change = await owner.poll();
        if (current !== revision || !selected.isCurrent()) return;
        if (change.changed || change.status === 'replay_required') {
          await owner.select(selected);
          if (current !== revision || !selected.isCurrent()) return;
          cursor = undefined;
          entries.clear();
          project = createNativeHistoryProjection(selectedKind, selected.selection.session.nativeSessionId);
          await loadMore();
        }
      }
    } catch (cause) {
      if (current === revision && selected.isCurrent() && !(cause instanceof ProtocolError && cause.code === 'timeout' && cause.message === 'timeout: history.read')) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (current === revision && selected.isCurrent()) schedulePoll(current);
    }
  }
  let cache: ReturnType<typeof createHistoryCache> | undefined;
  let retiring: ReturnType<typeof createHistoryCache> | undefined;
  let retirement: Promise<void> | undefined;
  function retireHistory(): Promise<void> {
    if (!retiring) { retiring = cache; cache = undefined; }
    if (!retiring) return Promise.resolve();
    if (!retirement) {
      const owner = retiring;
      retirement = owner.dispose().then(() => { if (retiring === owner) retiring = undefined; }).finally(() => { retirement = undefined; });
    }
    return retirement;
  }
  let capture: SelectionCapture | undefined;
  let cursor: string | undefined;
  let project: ReturnType<typeof createNativeHistoryProjection> | undefined;
  const entries = new Map<string, unknown>();
  let pageLoad: { owner: NonNullable<typeof cache>; revision: number; promise: Promise<void> } | undefined;

  function loadMore(): Promise<void> {
    const owner = cache, current = revision;
    if (!owner) return Promise.resolve();
    if (pageLoad?.owner === owner && pageLoad.revision === current) return pageLoad.promise;
    // Install the shared owner before invoking any producer callbacks. A later
    // selection may start its own page while this obsolete operation drains.
    const promise: Promise<void> = Promise.resolve().then(() => {
      if (owner !== cache || current !== revision) return;
      return readPage();
    }).finally(() => { if (pageLoad?.promise === promise) pageLoad = undefined; });
    pageLoad = { owner, revision: current, promise };
    return promise;
  }

  async function readPage() {
    const owner = cache;
    const selected = capture;
    const normalize = project;
    const current = revision;
    if (!owner || !selected || !normalize || !selected.isCurrent()) return;
    loading.value = true;
    try {
      const page = await owner.page(cursor);
      try {
        for (const item of page.value.items) {
          let value: unknown;
          if (item.kind === 'inline') value = item.value;
          else {
            requireValue(item.descriptor.totalBytes <= 4 * 1024 * 1024, 'history.render_record_budget', 'source_unavailable');
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let text = '';
            for await (const chunk of owner.export(page.value.pageId, item.descriptor)) text += decoder.decode(chunk.bytes, { stream: true });
            text += decoder.decode();
            value = JSON.parse(text);
          }
          if (current !== revision || !selected.isCurrent()) return;
          const projected = normalize(value);
          if (selectedKind === 'codex') entries.clear();
          for (const entry of projected) {
            requireValue(entry !== null && typeof entry === 'object' && 'info' in entry, 'history.entry');
            const info = entry.info;
            requireValue(info !== null && typeof info === 'object' && 'id' in info && typeof info.id === 'string', 'history.entry_id');
            entries.set(info.id, entry);
          }
        }
        while (entries.size > 200) {
          const first = entries.keys().next();
          if (first.done) break;
          entries.delete(first.value);
        }
        error.value = '';
        options.publish([...entries.values()]);
        cursor = page.value.cursor ?? undefined;
        hasMore.value = page.value.cursor !== null;
      } finally { page.release(); }
    } catch (cause) {
      if (current !== revision || !selected.isCurrent()) return;
      error.value = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally { if (current === revision) loading.value = false; }
  }
  async function select(client: RuntimeClient, selected: SelectionCapture, kind: HarnessKind, prepare?: () => Promise<void>) {
    const current = ++revision;
    stopPolling();
    selectedKind = kind;
    capture = selected;
    cursor = undefined;
    project = undefined;
    entries.clear();
    options.publish([]);
    error.value = '';
    hasMore.value = false;
    loading.value = true;
    try {
    await retireHistory();
    if (current !== revision || !selected.isCurrent()) return;
    const owner = createHistoryCache(createHistorySource(client), historyBudget);
    cache = owner;
    project = createNativeHistoryProjection(kind, selected.selection.session.nativeSessionId);
    await owner.select(selected);
    if (current !== revision || !selected.isCurrent()) return;
    if (owner.status.status === 'error') {
      const cause = new ProtocolError(owner.status.error ?? 'source_unavailable', 'history.open');
      throw cause;
    }
    await prepare?.();
    if (current !== revision || !selected.isCurrent()) return;
    await loadMore();
    if (current === revision && selected.isCurrent()) schedulePoll(current);
    } catch (cause) {
      if (current !== revision || !selected.isCurrent()) return;
      error.value = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally { if (current === revision) loading.value = false; }
  }
  async function dispose() {
    revision++;
    stopPolling();
    loading.value = false;
    error.value = '';
    hasMore.value = false;
    capture = undefined;
    project = undefined;
    selectedKind = undefined;
    entries.clear();
    await retireHistory();
  }
  async function unavailable(message: string) {
    const current = revision + 1;
    await dispose();
    if (current !== revision) return;
    options.publish([]);
    error.value = message;
  }
  return { select, loadMore, dispose, unavailable, loading: readonly(loading), error: readonly(error), hasMore: readonly(hasMore) };
}
