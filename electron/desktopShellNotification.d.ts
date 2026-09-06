export declare const COMPLETION_DEDUP_TTL_MS: number;
export declare const COMPLETION_DEDUP_MAX_ENTRIES: number;

export interface ValidDesktopNotification {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly projectId: string;
  readonly sessionId: string;
}

export declare function validateDesktopNotification(payload: unknown): ValidDesktopNotification;

export declare function nativeNotificationsAreAvailable(
  platform: string,
  Notification: { isSupported(): boolean },
): boolean;
