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
  return { api, off, onSelect, router, click: (notification: DesktopNotification) => click(notification), changeBackend: () => { identity = 'acp:other'; } };
}
const notification = { id: 'completion-1', title: 'Task completed', body: 'Session', projectId: 'codex', sessionId: 'thread-1' };

describe('desktop notification routing', () => {
  it('delivers a live completion and selects its original session on click', async () => {
    const { router, api, click, onSelect } = setup();
    await router.send(notification);
    click(notification);
    expect(api.notify).toHaveBeenCalledWith(notification);
    expect(onSelect).toHaveBeenCalledWith(notification);
  });
  it('ignores notification clicks after backend identity changes', async () => {
    const { router, click, onSelect, changeBackend } = setup();
    await router.send(notification);
    changeBackend();
    click(notification);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('releases its listener when disposed', () => {
    const { router, off } = setup();
    router.dispose();
    expect(off).toHaveBeenCalledOnce();
  });
});
