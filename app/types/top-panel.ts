export type TopPanelSession = {
  id: string;
  title?: string;
  slug?: string;
  status: 'busy' | 'idle' | 'retry' | 'unknown';
  timeCreated?: number;
  timeUpdated?: number;
  archivedAt?: number;
  pinnedAt?: number;
  isPinned?: boolean;
  isImplicitlyPinned?: boolean;
};

export type TopPanelSandbox = {
  key?: string;
  directory: string;
  pinDirectory?: string;
  branch?: string;
  kind?: 'global' | 'sandbox' | 'folder' | 'branch';
  sessions: TopPanelSession[];
  latestUpdated?: number;
  oldestCreated?: number;
  pinnedAt?: number;
  isPinned?: boolean;
  isImplicitlyPinned?: boolean;
};

export type TopPanelWorktree = {
  key?: string;
  directory: string;
  label: string;
  name?: string;
  projectId?: string;
  projectColor?: string;
  kind?: 'global' | 'sandbox';
  sandboxes: TopPanelSandbox[];
  latestUpdated?: number;
  pinnedAt?: number;
  isPinned?: boolean;
};

export type TopPanelNotificationSession = {
  projectId: string;
  sessionId: string;
  count: number;
};

export type TopPanelBatchSessionTarget = {
  sessionId: string;
  projectId?: string;
  directory: string;
};

export type TopPanelBatchSessionActionPayload = {
  action: 'pin' | 'unpin' | 'archive' | 'unarchive' | 'delete';
  sessions: TopPanelBatchSessionTarget[];
};
