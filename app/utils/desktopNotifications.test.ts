import { describe, expect, it, vi } from 'vitest';
import { createDesktopNotificationRouter } from './desktopNotifications';
import type { DesktopNotification } from '../types/desktop';

function setup() {
  let identity = 'codex:local';
  let click: (notification: DesktopNotification) => void = () => {};
  const off = vi.fn();
  const api = { notify: vi.fn(async (_notification: DesktopNotification) => {}), onNotificationClick: (listener: typeof click) => { click = listener; return off; } };
  const onSelect = vi.fn();
  const router = createDesktopNotificationRouter({ api, getIdentity: () => identity, onSelect });
  const sent = (index: number) => {
    const value = api.notify.mock.calls[index]?.[0];
    if (!value) throw new Error('Expected a native notification');
    return value;
  };
  return { api, off, onSelect, router, sent, click: (notification: DesktopNotification) => click(notification), changeBackend: (next = 'acp:other') => { identity = next; } };
}
const notification = { id: 'completion-1', title: 'Task completed', body: 'Session', projectId: 'codex', sessionId: 'thread-1' };

describe('desktop notification routing', () => {
  it('delivers a live completion and selects its original session on click', async () => {
    const { router, api, click, onSelect, sent } = setup();
    await router.send(notification);
    click(sent(0));
    expect(api.notify).toHaveBeenCalledWith({ ...notification, id: expect.any(String) });
    expect(onSelect).toHaveBeenCalledWith(notification);
  });
  it('ignores notification clicks after backend identity changes', async () => {
    const { router, click, onSelect, changeBackend, sent } = setup();
    await router.send(notification);
    changeBackend();
    click(sent(0));
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('releases its listener when disposed', () => {
    const { router, off } = setup();
    router.dispose();
    expect(off).toHaveBeenCalledOnce();
  });
  it('keeps colliding completion IDs separate across backends', async () => {
    const { router, sent, click, onSelect, changeBackend } = setup();
    await router.send(notification);
    changeBackend();
    const other = { ...notification, projectId: 'acp', sessionId: 'other-session' };
    await router.send(other);
    expect(sent(0).id).not.toBe(sent(1).id);
    click(sent(0));
    expect(onSelect).not.toHaveBeenCalled();
    click(sent(1));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(other);
  });
  it('preserves original click ownership when returning to a backend', async () => {
    const { router, sent, click, onSelect, changeBackend } = setup();
    await router.send(notification);
    changeBackend();
    await router.send({ ...notification, body: 'Other backend' });
    changeBackend('codex:local');
    click(sent(0));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(notification);
  });
  it('keeps duplicate IDs stable within the same backend', async () => {
    const { router, sent } = setup();
    await router.send(notification);
    await router.send(notification);
    expect(sent(0).id).toBe(sent(1).id);
  });
});
