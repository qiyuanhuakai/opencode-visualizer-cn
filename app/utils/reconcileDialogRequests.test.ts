import { describe, expect, it } from 'vitest';
import { ref, type Ref } from 'vue';
import { reconcileDialogRequests } from './reconcileDialogRequests';

interface FakeRequest {
  id: string;
  label: string;
}

interface FakeEntry {
  id: string;
  label: string;
}

function makeRef(initial: string[] = []): Ref<Set<string>> {
  return ref(new Set(initial));
}

function makeOptions(ids: Ref<Set<string>>) {
  const calls: string[] = [];
  const upsert = (entry: FakeEntry) => {
    calls.push(`upsert:${entry.id}`);
  };
  const remove = (id: string) => {
    calls.push(`remove:${id}`);
  };
  return {
    calls,
    options: {
      encodeId: (request: FakeRequest) => request.id,
      normalize: (request: FakeRequest): FakeEntry => ({ id: request.id, label: request.label }),
      upsert,
      remove,
      ids,
    },
  };
}

describe('reconcileDialogRequests', () => {
  it('removes stale entries whose ids are no longer in the request list', () => {
    const ids = makeRef(['a', 'b', 'c']);
    const { calls, options } = makeOptions(ids);

    reconcileDialogRequests(
      [
        { id: 'a', label: 'A' },
        { id: 'c', label: 'C' },
      ],
      options,
    );

    expect(calls).toContain('remove:b');
    expect(calls).not.toContain('remove:a');
    expect(calls).not.toContain('remove:c');
  });

  it('upserts an entry for every current request', () => {
    const ids = makeRef();
    const { calls, options } = makeOptions(ids);

    reconcileDialogRequests(
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      options,
    );

    expect(calls).toEqual(['upsert:a', 'upsert:b']);
  });

  it('replaces the tracked id set with exactly the current request ids', () => {
    const ids = makeRef(['a', 'b']);
    const { options } = makeOptions(ids);

    reconcileDialogRequests(
      [
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      options,
    );

    expect([...ids.value].sort()).toEqual(['b', 'c']);
  });

  it('removes stale entries before upserting current requests', () => {
    const ids = makeRef(['a', 'b']);
    const { calls, options } = makeOptions(ids);

    reconcileDialogRequests([{ id: 'b', label: 'B' }], options);

    const removeIndex = calls.indexOf('remove:a');
    const upsertIndex = calls.indexOf('upsert:b');
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(upsertIndex).toBeGreaterThan(removeIndex);
  });

  it('removes every tracked entry and empties the set when requests are empty', () => {
    const ids = makeRef(['a', 'b']);
    const { calls, options } = makeOptions(ids);

    reconcileDialogRequests([], options);

    expect(calls).toEqual(['remove:a', 'remove:b']);
    expect(ids.value.size).toBe(0);
  });

  it('is a no-op for removals and keeps the set when requests are unchanged', () => {
    const ids = makeRef(['a']);
    const { calls, options } = makeOptions(ids);

    reconcileDialogRequests([{ id: 'a', label: 'A' }], options);

    expect(calls).toEqual(['upsert:a']);
    expect([...ids.value]).toEqual(['a']);
  });
});
