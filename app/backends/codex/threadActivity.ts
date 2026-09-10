import { ref } from 'vue';
import { normalizeCodexStatus } from './codexAdapter';
import { StorageKeys, storageGetJSON, storageSetJSON } from '../../utils/storageKeys';

export function createCodexThreadActivity() {
  const participatedThreadIds = ref(new Set<string>());
  let storageKey = '';

  function setConnection(url: string) {
    const endpoint = new URL(url);
    const scope = `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`;
    const nextKey = `${StorageKeys.state.codexThreadActivity}.${encodeURIComponent(scope)}`;
    const changed = storageKey !== nextKey;
    storageKey = nextKey;
    const saved = storageGetJSON<unknown>(storageKey);
    participatedThreadIds.value = new Set(
      Array.isArray(saved)
        ? saved.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        : [],
    );
    return changed;
  }

  function markParticipated(threadId: string) {
    if (!storageKey || !threadId.trim() || participatedThreadIds.value.has(threadId)) return;
    participatedThreadIds.value = new Set([...participatedThreadIds.value, threadId]);
    storageSetJSON(storageKey, [...participatedThreadIds.value]);
  }

  function observe(threadId: string, status: unknown) {
    const normalized = normalizeCodexStatus(status);
    if (normalized === 'busy' || normalized === 'retry') markParticipated(threadId);
  }

  return { participatedThreadIds, setConnection, observe, markParticipated };
}
