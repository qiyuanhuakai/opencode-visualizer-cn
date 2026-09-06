const FIELD_LIMITS = Object.freeze({
  id: 256,
  title: 160,
  body: 4096,
  projectId: 256,
  sessionId: 256,
});

export const COMPLETION_DEDUP_TTL_MS = 10 * 60 * 1_000;
export const COMPLETION_DEDUP_MAX_ENTRIES = 256;

export function validateDesktopNotification(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Desktop notification must be an object');
  }

  const notification = {};
  for (const [field, maximumLength] of Object.entries(FIELD_LIMITS)) {
    const value = payload[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
      throw new TypeError(`Desktop notification ${field} must be 1-${maximumLength} characters`);
    }
    notification[field] = value;
  }

  return Object.freeze(notification);
}

export function nativeNotificationsAreAvailable(platform, Notification) {
  if (platform === 'darwin') return false;
  try {
    return Notification.isSupported();
  } catch {
    return false;
  }
}
