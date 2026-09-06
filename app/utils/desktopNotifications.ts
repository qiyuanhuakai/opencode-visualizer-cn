import type { DesktopApi, DesktopNotification } from '../types/desktop';

export function createDesktopNotificationRouter(options: {
  readonly api: Pick<DesktopApi, 'notify' | 'onNotificationClick'>;
  readonly getIdentity: () => string;
  readonly onSelect: (notification: DesktopNotification) => void;
}) {
  const pending = new Map<string, { identity: string; notification: DesktopNotification }>();
  let disposed = false;
  const unsubscribe = options.api.onNotificationClick((notification) => {
    const original = pending.get(notification.id);
    pending.delete(notification.id);
    if (original?.identity === options.getIdentity()) options.onSelect(original.notification);
  });
  return {
    async send(notification: DesktopNotification) {
      const identity = options.getIdentity();
      const bytes = new TextEncoder().encode(JSON.stringify([identity, notification.id]));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      if (disposed) return;
      const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      pending.set(id, { identity, notification });
      if (pending.size > 128) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      try {
        await options.api.notify({ ...notification, id, body: notification.body.slice(0, 2048) });
      } catch (error) {
        pending.delete(id);
        throw error;
      }
    },
    dispose() { disposed = true; unsubscribe(); pending.clear(); },
  };
}
