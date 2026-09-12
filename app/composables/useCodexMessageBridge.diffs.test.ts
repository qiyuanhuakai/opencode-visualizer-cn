import { effectScope, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCodexTurnsToHistory } from '../backends/codex/normalize';
import { useCodexMessageBridge } from './useCodexMessageBridge';
import { useMessages } from './useMessages';

type BridgeParams = Parameters<typeof useCodexMessageBridge>[0];
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); useMessages().reset(); });
function fixture() {
  const msg = useMessages();
  msg.reset();
  const params: BridgeParams = {
    activeBackendKind: ref('codex'), selectedSessionId: ref('thread-1'), codexPendingSessionLock: ref(''),
    history: ref([]), msg, syncRealtimeToolWindows: () => {}, updateReasoningExpiry: () => {},
    codexApi: {
      realtimeHistoryQueue: ref([]), realtimeMessageAliases: ref({}), realtimeStreamingPart: ref(null),
      realtimeReasoningPart: ref(null), realtimeToolParts: ref([]), tokenUsage: ref(null), diffState: ref(null),
    },
  };
  const scope = effectScope();
  scopes.push(scope);
  const bridge = scope.run(() => useCodexMessageBridge(params));
  return { ...params, msg, bridge };
}
function history(turns: string[], patches = false) {
  return normalizeCodexTurnsToHistory({ sessionId: 'thread-1', turns: turns.map(id => ({ id, items: [
    { id: `wire-${id}`, clientId: `client-${id}`, type: 'userMessage', content: [{ type: 'text', text: id }] },
    ...(patches ? [{ id: `edit-${id}`, type: 'fileChange', status: 'completed', changes: [
      { path: `${id}.ts`, diff: `@@ -1 +1 @@\n-old\n+${id}` },
      { path: `${id}.css`, diff: `@@ -1 +1 @@\n-old\n+${id}` },
    ] }] : []),
  ] })) });
}
const patch = (turnId: string) => ({ threadId: 'thread-1', turnId, diff: `diff --git a/${turnId}.ts b/${turnId}.ts\n@@ -1 +1 @@\n-old\n+${turnId}` });
const userId = (turn: string) => `${turn}:user:client-${turn}`;

describe('Codex card diff restoration', () => {
  it('restores diffs after explicit raw history reload even when publication signatures are unchanged', async () => {
    const p = fixture();
    p.history.value = history(['first'], true);
    await nextTick();
    p.msg.reset();
    p.msg.loadHistory(p.history.value);
    p.bridge?.reapplyCodexSharedBackfill();
    await nextTick();
    expect(p.msg.getDiffs(userId('first'))?.map(diff => diff.file)).toEqual(['first.ts', 'first.css']);
  });
  it('keeps edits separate between two user cards inside one Codex turn', async () => {
    // Given
    const p = fixture();
    // When
    p.history.value = normalizeCodexTurnsToHistory({ sessionId: 'thread-1', turns: [{ id: 'shared', items: [
      { id: 'a', type: 'userMessage', content: [{ type: 'text', text: 'first' }] },
      { id: 'edit-a', type: 'fileChange', status: 'completed', changes: [{ path: 'a.ts', diff: '@@ -1 +1 @@\n-a\n+b' }] },
      { id: 'b', type: 'userMessage', content: [{ type: 'text', text: 'second' }] },
      { id: 'edit-b', type: 'fileChange', status: 'completed', changes: [{ path: 'b.ts', diff: '@@ -1 +1 @@\n-c\n+d' }] },
    ] }] });
    p.codexApi.diffState.value = patch('shared');
    await nextTick();
    // Then
    expect(p.msg.getDiffs('shared:user:a')?.map(diff => diff.file)).toEqual(['a.ts']);
    expect(p.msg.getDiffs('shared:user:b')?.map(diff => diff.file)).toEqual(['b.ts']);
  });

  it('does not attach an ambiguous whole-turn notification to one of several user cards', async () => {
    // Given
    const p = fixture();
    p.history.value = normalizeCodexTurnsToHistory({ sessionId: 'thread-1', turns: [{ id: 'shared', items: [
      { id: 'a', type: 'userMessage', content: [{ type: 'text', text: 'first' }] },
      { id: 'b', type: 'userMessage', content: [{ type: 'text', text: 'second' }] },
    ] }] });
    await nextTick();
    // When
    p.codexApi.diffState.value = patch('shared');
    await nextTick();
    // Then
    expect(p.msg.getDiffs('shared:user:a') ?? []).toEqual([]);
    expect(p.msg.getDiffs('shared:user:b') ?? []).toEqual([]);
  });

  it('does not republish removed realtime cards when rollback reloads history', async () => {
    // Given
    const p = fixture();
    p.history.value = history(['first', 'second']);
    p.codexApi.realtimeHistoryQueue.value = history(['first', 'second']);
    p.codexApi.diffState.value = patch('second');
    await nextTick();
    // When
    p.msg.reset();
    p.history.value = history(['first']);
    await nextTick();
    // Then
    expect(p.msg.roots.value.map(root => root.id)).toEqual([userId('first')]);
  });

  it('leaves OpenCode messages unchanged when Codex history and diffs arrive', async () => {
    // Given
    const p = fixture();
    p.activeBackendKind.value = 'opencode';
    p.msg.loadHistory(history(['opencode']));
    // When
    p.history.value = history(['first'], true);
    p.codexApi.diffState.value = patch('first');
    await nextTick();
    // Then
    expect(p.msg.roots.value.map(root => root.id)).toEqual([userId('opencode')]);
  });

  it('attaches a turn notification to its realtime client user before history reload', async () => {
    // Given
    const p = fixture();
    p.codexApi.realtimeHistoryQueue.value = history(['first', 'second']);
    await nextTick();
    // When
    p.codexApi.diffState.value = patch('first');
    await nextTick();
    // Then
    expect(p.msg.getDiffs(userId('first'))?.map(diff => diff.file)).toEqual(['first.ts']);
    expect(p.msg.getDiffs(userId('second')) ?? []).toEqual([]);
  });

  it('restores each historical multiedit on its owning user without a live notification', async () => {
    // Given
    const p = fixture();
    // When
    p.history.value = history(['first', 'second'], true);
    await nextTick();
    // Then
    expect(p.msg.getDiffs(userId('first'))?.map(diff => diff.file)).toEqual(['first.ts', 'first.css']);
    expect(p.msg.getDiffs(userId('second'))?.map(diff => diff.file)).toEqual(['second.ts', 'second.css']);
  });

  it('preserves earlier notifications when the latest turn and loaded history change', async () => {
    // Given
    const p = fixture();
    p.history.value = history(['first', 'second']);
    p.codexApi.diffState.value = patch('first');
    await nextTick();
    p.codexApi.diffState.value = patch('second');
    await nextTick();
    // When
    p.history.value = history(['first', 'second']);
    await nextTick();
    // Then
    expect(p.msg.getDiffs(userId('first'))?.map(diff => diff.file)).toEqual(['first.ts']);
    expect(p.msg.getDiffs(userId('second'))?.map(diff => diff.file)).toEqual(['second.ts']);
  });

  it('ignores a notification from a different session even if the turn ID matches', async () => {
    // Given
    const p = fixture();
    p.history.value = history(['first']);
    await nextTick();
    // When
    p.codexApi.diffState.value = { ...patch('first'), threadId: 'other' };
    await nextTick();
    // Then
    expect(p.msg.getDiffs(userId('first')) ?? []).toEqual([]);
  });

  it('forgets removed turn notifications after rollback replaces history', async () => {
    // Given
    const p = fixture();
    p.history.value = history(['first', 'second']);
    p.codexApi.diffState.value = patch('second');
    await nextTick();
    p.history.value = history(['first']);
    await nextTick();
    // When
    p.history.value = history(['first', 'second']);
    await nextTick();
    // Then
    expect(p.msg.getDiffs(userId('second')) ?? []).toEqual([]);
  });
});
