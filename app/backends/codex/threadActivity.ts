import { ref } from 'vue';
import { normalizeCodexStatus } from './codexAdapter';

export function createCodexThreadActivity() {
  const participatedThreadIds = ref(new Set<string>());
  let connectionScope = '';

  function setConnection(url: string) {
    const endpoint = new URL(url);
    const scope = `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`;
    const changed = connectionScope !== scope;
    connectionScope = scope;
    participatedThreadIds.value = new Set();
    return changed;
  }

  function markParticipated(threadId: string) {
    if (!connectionScope || !threadId.trim() || participatedThreadIds.value.has(threadId)) return;
    participatedThreadIds.value = new Set([...participatedThreadIds.value, threadId]);
  }

  function observe(threadId: string, status: unknown) {
    const normalized = normalizeCodexStatus(status);
    if (normalized === 'busy' || normalized === 'retry') markParticipated(threadId);
  }

  return { participatedThreadIds, setConnection, observe, markParticipated };
}
