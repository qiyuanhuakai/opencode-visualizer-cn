import { computed, shallowRef, watch, type Ref } from 'vue';
import type { CodexCanonicalHistoryEntry } from '../backends/codex/normalize';
import type { FileDiff, MessageInfo, ToolPart } from '../types/sse';

type TurnDiff = { threadId: string; turnId: string; diff: string };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function filePatch(file: string, patch: string): FileDiff {
  return { file, patch, additions: 0, deletions: 0 };
}
function parseTurnDiff(text: string): FileDiff[] {
  return text.trim().split(/(?=^diff --git )/m).filter(chunk => chunk.trim()).map((chunk, index) => {
    const match = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    return filePatch(match?.[2] || match?.[1] || `changes-${index + 1}.diff`, chunk.trim());
  });
}
function toolDiffs(part: ToolPart): FileDiff[] {
  if (!['edit', 'multiedit'].includes(part.tool) || part.state.status !== 'completed') return [];
  const { metadata, input } = part.state;
  const results: unknown[] = Array.isArray(metadata.results)
    ? metadata.results : [{ path: input.filePath, filediff: metadata.filediff }];
  return results.flatMap(result => {
    if (!record(result) || !record(result.filediff)) return [];
    const patch = result.filediff.patch;
    if (typeof patch !== 'string' || !/^(?:@@|diff --git |--- )/m.test(patch)) return [];
    return [filePatch(typeof result.path === 'string' ? result.path : 'changes.diff', patch)];
  });
}
function turnKey(info: MessageInfo): string | null {
  const separator = info.id.indexOf(':user:');
  return info.role === 'user' && separator >= 0 ? info.id.slice(0, separator) : null;
}

export function useCodexMessageDiffs(params: {
  readonly history: Ref<CodexCanonicalHistoryEntry[]>;
  readonly queue: Ref<CodexCanonicalHistoryEntry[]>;
  readonly diffState: Ref<TurnDiff | null>;
  readonly selectedSessionId: Ref<string>;
}) {
  const notifications = shallowRef(new Map<string, TurnDiff>());
  watch(params.selectedSessionId, () => { notifications.value = new Map(); }, { flush: 'sync' });
  watch(params.diffState, state => {
    if (!state || state.threadId !== params.selectedSessionId.value) return;
    const next = new Map(notifications.value);
    if (state.diff.trim()) next.set(state.turnId, state);
    else next.delete(state.turnId);
    notifications.value = next;
  }, { deep: true, flush: 'sync', immediate: true });

  function pruneRemovedTurns(history: CodexCanonicalHistoryEntry[], previous: CodexCanonicalHistoryEntry[]) {
    const retained = new Set(history.map(entry => turnKey(entry.info)));
    const next = new Map(notifications.value);
    for (const entry of previous) {
      const key = turnKey(entry.info);
      if (key && !retained.has(key)) next.delete(key);
    }
    notifications.value = next;
  }

  const diffsByUser = computed(() => {
    const entries = new Map([...params.history.value, ...params.queue.value]
      .filter(entry => entry.info.sessionID === params.selectedSessionId.value)
      .map(entry => [entry.info.id, entry]));
    const result = new Map<string, FileDiff[]>();
    const usersByTurn = new Map<string, string[]>();
    for (const { info } of entries.values()) {
      const turn = turnKey(info);
      if (turn) usersByTurn.set(turn, [...(usersByTurn.get(turn) ?? []), info.id]);
    }
    for (const { info, parts } of entries.values()) {
      if (info.role !== 'assistant' || !entries.has(info.parentID)) continue;
      const diffs = parts.flatMap(part => part.type === 'tool' ? toolDiffs(part) : []);
      if (diffs.length) result.set(info.parentID, [...(result.get(info.parentID) ?? []), ...diffs]);
    }
    for (const [turn, state] of notifications.value) {
      const users = usersByTurn.get(turn) ?? [];
      const last = users.at(-1);
      if (last && users.length === 1) {
        result.set(last, parseTurnDiff(state.diff));
      }
    }
    return result;
  });

  function enrich(info: MessageInfo): MessageInfo {
    const diffs = diffsByUser.value.get(info.id);
    return info.role === 'user' && info.sessionID === params.selectedSessionId.value && diffs?.length
      ? { ...info, summary: { ...info.summary, diffs } } : info;
  }
  return { enrich, pruneRemovedTurns };
}
