import type { SsePacket } from './sse';
import type { ProjectState, WorkerNotificationEntry } from './worker-state';

/**
 * Per-directory session hydration state.
 * Tracks whether the sessions for a directory have been loaded by the worker.
 * Note: 'unloaded' | 'loading' | 'error' must never be interpreted as
 * "loaded with zero sessions" — only 'loaded' may mean loaded-empty.
 */
export type DirectorySessionHydration = {
  status: 'unloaded' | 'loading' | 'loaded' | 'error';
  error?: string;
};

export type TabToWorkerMessage =
  | {
      type: 'connect';
      baseUrl: string;
      authorization?: string;
      errorMessages?: {
        emptyBaseUrl?: string;
      };
    }
  | {
      type: 'disconnect';
    }
  | {
      type: 'selection.active';
      projectId: string;
      sessionId: string;
      directory?: string;
    }
  | {
      type: 'load-sessions';
      directory: string;
    }
  | {
      type: 'hydrate-referenced-subagents';
      requestId: string;
      rootSessionId: string;
      directory: string;
      sessionIds: string[];
    }
  | {
      type: 'sandbox.deleted';
      projectId: string;
      directory: string;
    };

export type WorkerToTabMessage =
  | {
      type: 'packet';
      packet: SsePacket;
    }
  | {
      type: 'connection.open';
    }
  | {
      type: 'connection.error';
      message: string;
      statusCode?: number;
    }
  | {
      type: 'connection.reconnected';
    }
  | {
      type: 'state.bootstrap';
      projects: Record<string, ProjectState>;
      notifications: Record<string, WorkerNotificationEntry>;
      sessionHydrationByDirectory?: Record<string, DirectorySessionHydration>;
    }
  | {
      type: 'state.project-updated';
      projectId: string;
      project: ProjectState;
    }
  | {
      type: 'state.project-removed';
      projectId: string;
    }
  | {
      type: 'state.notifications-updated';
      notifications: Record<string, WorkerNotificationEntry>;
    }
  | {
      type: 'state.directory-hydration-updated';
      directory: string;
      hydration: DirectorySessionHydration;
    }
  | {
      type: 'state.background-hydration-complete';
    }
  | {
      type: 'state.referenced-subagents-hydrated';
      requestId: string;
      rootSessionId: string;
      sessionIds: string[];
      cancelled: boolean;
    }
  | {
      type: 'notification.show';
      projectId: string;
      sessionId: string;
      kind: 'permission' | 'question' | 'idle';
    };
