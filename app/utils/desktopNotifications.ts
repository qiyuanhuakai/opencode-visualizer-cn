import type { DesktopApi, DesktopNotification } from '../types/desktop';

export function createDesktopNotificationRouter(options: {
  readonly api: Pick<DesktopApi, 'notify' | 'onNotificationClick'>;
  readonly getIdentity: () => string;
  readonly onSelect: (notification: DesktopNotification) => void;
}) {
  const pending = new Map<string, { identity: string; notification: DesktopNotification }>();
  const unsubscribe = options.api.onNotificationClick((notification) => {
    const original = pending.get(notification.id);
    pending.delete(notification.id);
    if (original?.identity === options.getIdentity()) options.onSelect(original.notification);
  });
  return {
    async send(notification: DesktopNotification) {
      const identity = options.getIdentity();
      const id = JSON.stringify([identity, notification.id]);
      pending.set(id, { identity, notification });
      if (pending.size > 128) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      try {
        await options.api.notify({ ...notification, id });
      } catch (error) {
        pending.delete(id);
        throw error;
      }
    },
    dispose() { unsubscribe(); pending.clear(); },
  };
}
