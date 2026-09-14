import { vi } from 'vitest';
import type { SseConnectionCallbacks } from '../utils/sseConnection';
import type { SsePacket } from '../types/sse';
import type { TabToWorkerMessage, WorkerToTabMessage } from '../types/sse-worker';

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
};

export type MutationSnapshotToken = {
  readonly id: symbol;
  readonly baseline: number;
  readonly sequence: number;
};

export type MutationSnapshotTracker = {
  readonly active: Set<MutationSnapshotToken>;
};

type WorkerPort = { readonly port: MessagePort; readonly messages: WorkerToTabMessage[] };

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export function project(directories: readonly string[], id = 'project') {
  const worktree = directories[0] ?? '/project';
  return { id, worktree, sandboxes: directories, time: { created: 1, updated: 1 } };
}

export function sessionInfo(id: string, title = id, parentID?: string, directory = '/a') {
  return {
    id,
    slug: id,
    projectID: 'project',
    directory,
    ...(parentID ? { parentID } : {}),
    title,
    version: '1',
    time: { created: 1, updated: 1 },
  };
}

export function sessionPacket(
  type: 'session.created' | 'session.updated' | 'session.deleted',
  info: ReturnType<typeof sessionInfo>,
): SsePacket {
  return { directory: info.directory, payload: { type, properties: { info } } };
}

export function sessionCreatedPacket(
  id: string,
  title = id,
  parentID?: string,
  directory = '/a',
): SsePacket {
  return {
    directory,
    payload: {
      type: 'session.created',
      properties: { info: sessionInfo(id, title, parentID, directory) },
    },
  };
}

export function projectUpdatedPacket(projectInfo: ReturnType<typeof project>): SsePacket {
  return {
    directory: projectInfo.worktree,
    payload: { type: 'project.updated', properties: projectInfo },
  };
}

export function permissionAskedPacket(id: string, sessionID: string, directory = '/a'): SsePacket {
  return {
    directory,
    payload: {
      type: 'permission.asked',
      properties: {
        id,
        sessionID,
        permission: 'edit',
        patterns: ['*'],
        metadata: {},
        always: [],
      },
    },
  };
}

export function questionAskedPacket(id: string, sessionID: string, directory = '/a'): SsePacket {
  return {
    directory,
    payload: {
      type: 'question.asked',
      properties: {
        id,
        sessionID,
        questions: [
          {
            question: 'Continue?',
            header: 'Continue',
            options: [{ label: 'Yes', description: 'Continue the task.' }],
          },
        ],
      },
    },
  };
}

export function messagesOf<T extends WorkerToTabMessage['type']>(
  messages: readonly WorkerToTabMessage[],
  type: T,
): Extract<WorkerToTabMessage, { type: T }>[] {
  return messages.filter(
    (message): message is Extract<WorkerToTabMessage, { type: T }> => message.type === type,
  );
}

export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function createSseWorkerTestHarness(callbacks: SseConnectionCallbacks[]) {
  const workerSelf: { onconnect: ((event: MessageEvent) => void) | null } = { onconnect: null };
  const openPorts: MessagePort[] = [];
  const connectedPorts: MessagePort[] = [];

  async function connectWorker(
    baseUrl = 'http://server',
    authorization?: string,
  ): Promise<WorkerPort> {
    await import('./sse-shared-worker');
    const connectionCount = callbacks.length;
    const channel = new MessageChannel();
    const messages: WorkerToTabMessage[] = [];
    channel.port2.onmessage = (event: MessageEvent<WorkerToTabMessage>) =>
      messages.push(event.data);
    channel.port2.start();
    openPorts.push(channel.port1, channel.port2);
    connectedPorts.push(channel.port1);
    const onconnect = workerSelf.onconnect;
    if (!onconnect) throw new Error('Expected SharedWorker onconnect handler');
    onconnect(new MessageEvent('connect', { ports: [channel.port1] }));
    channel.port1.onmessage?.(
      new MessageEvent<TabToWorkerMessage>('message', {
        data: { type: 'connect', baseUrl, authorization },
      }),
    );
    if (callbacks.length > connectionCount) {
      const currentCallbacks = callbacks.at(-1);
      if (!currentCallbacks) throw new Error('Expected SSE connection callbacks');
      currentCallbacks.onOpen(false);
    }
    return { port: channel.port1, messages };
  }

  function post(worker: WorkerPort, message: TabToWorkerMessage): void {
    worker.port.onmessage?.(new MessageEvent<TabToWorkerMessage>('message', { data: message }));
  }

  function latestCallbacks(): SseConnectionCallbacks {
    const currentCallbacks = callbacks.at(-1);
    if (!currentCallbacks) throw new Error('Expected SSE connection callbacks');
    return currentCallbacks;
  }

  return {
    connectWorker,
    post,
    latestCallbacks,
    reset() {
      workerSelf.onconnect = null;
      vi.stubGlobal('self', workerSelf);
    },
    cleanup() {
      connectedPorts.splice(0).forEach((port) => {
        port.onmessage?.(
          new MessageEvent<TabToWorkerMessage>('message', { data: { type: 'disconnect' } }),
        );
      });
      openPorts.splice(0).forEach((port) => port.close());
      vi.unstubAllGlobals();
    },
  };
}
