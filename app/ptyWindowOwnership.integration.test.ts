import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountRuntimeApp } from './test/runtimeAppHarness';

const { dispose } = vi.hoisted(() => ({ dispose: vi.fn() }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    readonly options = {};
    readonly buffer = { active: { baseY: 0, cursorY: 0, viewportY: 0 } };
    readonly rows = 24;
    readonly cols = 80;
    open() {}
    focus() {}
    refresh() {}
    resize() {}
    write(_data: string | Uint8Array, callback?: () => void) { callback?.(); }
    onData() { return { dispose: () => {} }; }
    dispose = dispose;
  },
}));

beforeEach(() => dispose.mockClear());

async function shellFixture() {
  const fixture = await mountRuntimeApp([]);
  await fixture.connect();
  await fixture.select('Session A');
  const button = await vi.waitFor(() => {
    const candidate = fixture.element.querySelector<HTMLButtonElement>('.open-shell-button');
    expect(candidate?.disabled).toBe(false);
    return candidate!;
  });
  const requests = (method: string) => fixture.frames.flatMap(frame => {
    if (frame.direction !== 'send' || typeof frame.value !== 'object' || frame.value === null) return [];
    const value = frame.value as { method?: string; params?: { ptyId?: string; command?: string } };
    return value.method === method ? [value.params] : [];
  });
  const interactiveCreates = () => requests('runtime.pty.create').filter(params => !params?.command);
  const removals = (id: string) => requests('runtime.pty.remove').filter(params => params?.ptyId === id);
  const windows = () => fixture.element.querySelectorAll<HTMLElement>('[data-floating-key^="shell:"]');
  return { ...fixture, button, requests, interactiveCreates, removals, windows };
}

describe('App PTY window ownership through Bridge', () => {
  it('coalesces repeated shell clicks while opening and removes the owned PTY on explicit close', async () => {
    const fixture = await shellFixture();
    fixture.button.click();
    fixture.button.click();
    await vi.waitFor(() => expect(fixture.windows()).toHaveLength(1));
    expect(fixture.interactiveCreates()).toHaveLength(1);

    const window = fixture.windows()[0]!;
    const id = window.dataset.floatingKey!.slice('shell:'.length);
    window.querySelector<HTMLButtonElement>('[aria-label="Close window"]')!.click();
    await vi.waitFor(() => {
      expect(fixture.windows()).toHaveLength(0);
      expect(fixture.removals(id)).toEqual([{ ptyId: id }]);
    });
    expect(dispose).toHaveBeenCalled();
  }, 15000);

  it('disposes the renderer terminal without sending a request to remove the backend PTY', async () => {
    const fixture = await shellFixture();
    fixture.button.click();
    await vi.waitFor(() => expect(fixture.windows()).toHaveLength(1));
    await vi.waitFor(() => expect(fixture.requests('runtime.channel.open')).toHaveLength(1));
    const id = fixture.windows()[0]!.dataset.floatingKey!.slice('shell:'.length);
    fixture.unmountRenderer();
    expect(dispose).toHaveBeenCalled();
    expect(fixture.removals(id)).toEqual([]);
  }, 15000);
});
