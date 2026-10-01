import { createApp, defineComponent, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '../types/sse';
import { useFloatingWindows } from './useFloatingWindows';
import { useReasoningWindows } from './useReasoningWindows';
import { useSubagentWindows } from './useSubagentWindows';
import { assistantInfo, createFakeSessionScope } from './streamingWindow.test-helpers';

vi.mock('../i18n/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const cleanups: Array<() => void> = [];
const surface = defineComponent(() => () => null);

function mount(kind: 'reasoning' | 'text') {
  const fake = createFakeSessionScope();
  const suppressed = ref(false);
  let windows: ReturnType<typeof useFloatingWindows> | undefined;
  const app = createApp({ setup() {
    windows = useFloatingWindows();
    const common = { fw: windows, scope: fake.scope, selectedSessionId: ref('main'), theme: () => 'light', suppressAutoWindows: suppressed };
    if (kind === 'reasoning') useReasoningWindows({ ...common, reasoningComponent: surface,
      reasoningCloseDelayMs: 100, t: key => key });
    else useSubagentWindows({ ...common, subagentComponent: surface, closeDelayMs: 100 });
    return () => null;
  } });
  const root = document.createElement('div');
  app.mount(root);
  cleanups.push(() => app.unmount());
  if (!windows) throw new Error('manager missing');
  const key = `${kind === 'reasoning' ? 'reasoning' : 'subagent'}:child`;
  return { ...fake, windows, key, suppressed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); });

for (const kind of ['reasoning', 'text'] as const) describe(`${kind} terminal replay`, () => {
  const part = (messageID = 'message', end?: number): MessagePart => ({
    id: `${messageID}:part`, sessionID: 'child', messageID, type: kind, text: 'output',
    time: { start: 1, end },
  });

  it('retains the original close deadline after a duplicate nonterminal part', async () => {
    const { emit, windows, key } = mount(kind);
    emit('message.part.updated', { part: part() });
    emit('message.updated', { info: assistantInfo('child', 'message', 2) });
    await vi.advanceTimersByTimeAsync(50);
    emit('message.part.updated', { part: part() });
    await vi.advanceTimersByTimeAsync(51);
    expect(windows.has(key)).toBe(false);
  });

  it('does not restart the close deadline for duplicate terminal parts', async () => {
    const { emit, windows, key } = mount(kind);
    emit('message.part.updated', { part: part('message', 2) });
    await vi.advanceTimersByTimeAsync(50);
    emit('message.part.updated', { part: part('message', 2) });
    await vi.advanceTimersByTimeAsync(51);
    expect(windows.has(key)).toBe(false);
  });

  it('does not let a previous message completion close the newer live message', async () => {
    const { emit, windows, key } = mount(kind);
    emit('message.part.updated', { part: part('old') });
    emit('message.part.updated', { part: part('new') });
    emit('message.updated', { info: assistantInfo('child', 'old', 2) });
    await vi.advanceTimersByTimeAsync(101);
    expect(windows.has(key)).toBe(true);
  });

  it('does not let a previous terminal part close the newer live message', async () => {
    const { emit, windows, key } = mount(kind);
    emit('message.part.updated', { part: part('old') });
    emit('message.part.updated', { part: part('new') });
    emit('message.part.updated', { part: part('old', 2) });
    await vi.advanceTimersByTimeAsync(101);
    expect(windows.has(key)).toBe(true);
  });

  for (const terminal of ['part', 'message'] as const) it(`does not reopen after ${terminal} completion expires and stale updates continue`, async () => {
    const { emit, windows, key } = mount(kind);
    emit('message.part.updated', { part: part('old', terminal === 'part' ? 2 : undefined) });
    if (terminal === 'message') emit('message.updated', { info: assistantInfo('child', 'old', 2) });
    await vi.advanceTimersByTimeAsync(101);
    expect(windows.has(key)).toBe(false);
    for (let i = 0; i < 6; i++) {
      emit('message.part.updated', { part: part('old') });
      await vi.advanceTimersByTimeAsync(50);
      expect(windows.has(key)).toBe(false);
    }
    emit('message.part.updated', { part: part('new') });
    expect(windows.has(key)).toBe(true);
    emit('message.part.updated', { part: part('old', 2) });
    await vi.advanceTimersByTimeAsync(101);
    expect(windows.has(key)).toBe(true);
    expect(windows.get(key)?.props?.entries).toEqual([
      expect.objectContaining({ id: 'new:part', completed: false }),
    ]);
  });

  it('retains completion identity across suppression while admitting the next message', () => {
    const { emit, windows, key, suppressed } = mount(kind);
    emit('message.part.updated', { part: part('old', 2) });
    suppressed.value = true;
    suppressed.value = false;
    emit('message.part.updated', { part: part('old') });
    expect(windows.has(key)).toBe(false);
    emit('message.part.updated', { part: part('new') });
    expect(windows.has(key)).toBe(true);
  });

  it('closes when direct backend callbacks provide terminal message info without part.time.end', async () => {
    const fake = createFakeSessionScope();
    const { windows, key } = mount(kind);
    // Backend callback delivery bypasses scope events; the message is supplied alongside the part.
    let handle: ((part: MessagePart, info: ReturnType<typeof assistantInfo>) => void) | undefined;
    const app = createApp({ setup() {
      const common = { fw: windows, scope: fake.scope, selectedSessionId: ref('main'), theme: () => 'light' };
      handle = kind === 'reasoning'
        ? useReasoningWindows({ ...common, reasoningComponent: surface, reasoningCloseDelayMs: 100, t: key => key }).handlePart
        : useSubagentWindows({ ...common, subagentComponent: surface, closeDelayMs: 100 }).handlePart;
      return () => null;
    } });
    app.mount(document.createElement('div'));
    cleanups.push(() => app.unmount());
    handle?.(part(), assistantInfo('child', 'message', 2));
    await vi.advanceTimersByTimeAsync(101);
    expect(windows.has(key)).toBe(false);
  });
});
