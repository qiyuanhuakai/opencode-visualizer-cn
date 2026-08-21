type OpencodeReadPriority = 'normal' | 'bootstrap';

type OpencodeReadTaskOptions = {
  signal?: AbortSignal;
  generation?: number;
  cancelOnAbort?: boolean;
  priority?: OpencodeReadPriority;
};

export class OpencodeReadAbortedError extends Error {
  readonly name = 'OpencodeReadAbortedError';

  constructor() {
    super('OpenCode read was aborted before it could run.');
  }
}

class OpencodeReadCapacityError extends Error {
  readonly name = 'OpencodeReadCapacityError';

  constructor() {
    super('OpenCode read queue capacity reached.');
  }
}

const OPENCODE_READ_CONCURRENCY = 12;
const MAX_PENDING_OPENCODE_READ_RESOLVERS = 256;

type OpencodeReadAcquireResult =
  | { acquired: true }
  | { acquired: false; reason: 'aborted' | 'capacity' };

type PendingOpencodeReadResolver = {
  resolve: (result: OpencodeReadAcquireResult) => void;
  priority: OpencodeReadPriority;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type ReadRunnerDependencies<State> = {
  isCurrent: (state: State) => boolean;
  getGeneration: (state: State) => number;
  configure: (state: State) => void;
};

function cleanupPendingOpencodeReadResolver(pending: PendingOpencodeReadResolver): void {
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort);
  }
}

function createSlotAcquirer() {
  let activeTasks = 0;
  const pendingResolvers: PendingOpencodeReadResolver[] = [];

  async function acquire(
    signal?: AbortSignal,
    priority: OpencodeReadPriority = 'normal',
  ): Promise<OpencodeReadAcquireResult> {
    if (signal?.aborted) return { acquired: false, reason: 'aborted' };
    if (activeTasks < OPENCODE_READ_CONCURRENCY) {
      activeTasks += 1;
      return { acquired: true };
    }
    if (pendingResolvers.length >= MAX_PENDING_OPENCODE_READ_RESOLVERS) {
      if (priority === 'normal') return { acquired: false, reason: 'capacity' };

      let displacedIndex = pendingResolvers.length - 1;
      while (displacedIndex >= 0 && pendingResolvers[displacedIndex]?.priority !== 'normal') {
        displacedIndex -= 1;
      }
      if (displacedIndex < 0) return { acquired: false, reason: 'capacity' };

      const displaced = pendingResolvers.splice(displacedIndex, 1)[0];
      if (displaced) {
        cleanupPendingOpencodeReadResolver(displaced);
        displaced.resolve({ acquired: false, reason: 'capacity' });
      }
    }

    return new Promise<OpencodeReadAcquireResult>((resolve) => {
      const pending: PendingOpencodeReadResolver = { resolve, priority, signal };
      const onAbort = () => {
        const index = pendingResolvers.indexOf(pending);
        if (index < 0) return;
        pendingResolvers.splice(index, 1);
        cleanupPendingOpencodeReadResolver(pending);
        resolve({ acquired: false, reason: 'aborted' });
      };
      pending.onAbort = onAbort;
      const firstNormalIndex = pendingResolvers.findIndex((queued) => queued.priority === 'normal');
      if (priority === 'bootstrap' && firstNormalIndex >= 0) {
        pendingResolvers.splice(firstNormalIndex, 0, pending);
      } else {
        pendingResolvers.push(pending);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  function release(): void {
    activeTasks = Math.max(0, activeTasks - 1);
    while (pendingResolvers.length > 0) {
      const next = pendingResolvers.shift();
      if (!next) return;
      if (next.signal?.aborted) {
        cleanupPendingOpencodeReadResolver(next);
        next.resolve({ acquired: false, reason: 'aborted' });
        continue;
      }
      cleanupPendingOpencodeReadResolver(next);
      activeTasks += 1;
      next.resolve({ acquired: true });
      return;
    }
  }

  return { acquire, release };
}

function runOpencodeTaskWithCancellation<T>(
  task: () => Promise<T>,
  signal: AbortSignal | undefined,
  onTaskSettled: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let taskSettled = false;
    const releaseTask = () => {
      if (taskSettled) return;
      taskSettled = true;
      onTaskSettled();
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OpencodeReadAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      releaseTask();
      return;
    }

    let pending: Promise<T>;
    try {
      pending = task();
    } catch (error) {
      releaseTask();
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        releaseTask();
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        releaseTask();
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function createOpencodeReadRunner<State>(dependencies: ReadRunnerDependencies<State>) {
  const slots = createSlotAcquirer();

  function assertActive(state: State, options: OpencodeReadTaskOptions): void {
    if (
      options.signal?.aborted ||
      !dependencies.isCurrent(state) ||
      (options.generation !== undefined && dependencies.getGeneration(state) !== options.generation)
    ) {
      throw new OpencodeReadAbortedError();
    }
  }

  return async function runOpencodeReadTask<T>(
    state: State,
    task: () => Promise<T>,
    options: OpencodeReadTaskOptions = {},
  ): Promise<T> {
    assertActive(state, options);
    const acquired = await slots.acquire(options.signal, options.priority);
    if (!acquired.acquired) {
      if (acquired.reason === 'aborted') throw new OpencodeReadAbortedError();
      throw new OpencodeReadCapacityError();
    }
    let releaseInFinally = true;
    try {
      assertActive(state, options);
      dependencies.configure(state);
      assertActive(state, options);
      if (options.cancelOnAbort) {
        const pending = runOpencodeTaskWithCancellation(task, options.signal, slots.release);
        releaseInFinally = false;
        return await pending;
      }
      return await task();
    } finally {
      if (releaseInFinally) slots.release();
    }
  };
}
