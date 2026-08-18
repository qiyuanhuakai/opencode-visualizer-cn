import type { ThemedToken } from 'shiki';
import type { StreamSessionManager } from './streamSession';

/**
 * Params captured at stream open. Superset of what the final single-shot-style
 * code render needs (lang/theme/gutter/range) plus copy-button labels so the
 * converged final HTML matches the equivalent single-shot request byte-for-byte.
 */
export type StreamOpenParams = {
  lang: string;
  theme: string;
  gutterMode?: 'none' | 'single' | 'double';
  gutterLines?: string[];
  grepPattern?: string;
  lineOffset?: number;
  lineLimit?: number;
  copyButtonLabel?: string;
  copiedLabel?: string;
  copyCodeAriaLabel?: string;
  copyMarkdownAriaLabel?: string;
};

/** Additive streaming protocol. Single-shot RenderRequest never sets `stream`. */
export type StreamWorkerRequest =
  | { stream: true; op: 'open'; id: string; streamId: string; params: StreamOpenParams }
  | { stream: true; op: 'chunk'; id: string; streamId: string; chunk: string }
  | { stream: true; op: 'close'; id: string; streamId: string }
  | { stream: true; op: 'cancel'; id: string; streamId: string };

export type StreamTokenBatch = {
  recall: number;
  stable: ThemedToken[];
  unstable: ThemedToken[];
};

export type StreamWorkerResponse =
  | ({ kind: 'tokens'; id: string; streamId: string } & StreamTokenBatch)
  | { kind: 'final'; id: string; streamId: string; html: string }
  | { kind: 'error'; id: string; streamId: string; error: string };

/** Renders the converged final HTML from the full accumulated code. */
export type StreamFinalRenderer = (code: string, params: StreamOpenParams) => Promise<string>;

export function isStreamWorkerRequest(value: unknown): value is StreamWorkerRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'stream' in value &&
    value.stream === true
  );
}

type StreamState = {
  params: StreamOpenParams;
  code: string;
};

/** Test-only introspection into the handler's internal bookkeeping sizes. */
export type StreamDebugState = {
  states: number;
  chains: number;
  cancelled: number;
};

export type StreamMessageHandler = {
  (request: StreamWorkerRequest): Promise<void>;
  _debugState: () => StreamDebugState;
};

/**
 * Creates a worker-side message handler for the streaming protocol, bound to a
 * StreamSessionManager and a dependency-injected final renderer. Pure module:
 * no self/postMessage access, so it is importable in isolation from tests.
 *
 * Per-streamId ops are serialized on a promise chain so token batches are
 * emitted in chunk order. On close, the manager's flushed trailing stable
 * tokens are emitted as one last 'tokens' message (recall 0, empty unstable)
 * before the 'final' message — but only when the flush is non-empty. Cancel is
 * processed synchronously and suppresses every later message for the streamId,
 * including results of in-flight ops and (silently) any further chunk/close.
 */
export function createStreamMessageHandler(deps: {
  manager: StreamSessionManager;
  renderFinal: StreamFinalRenderer;
  post: (message: StreamWorkerResponse) => void;
}): StreamMessageHandler {
  const { manager, renderFinal, post } = deps;
  const states = new Map<string, StreamState>();
  const chains = new Map<string, Promise<void>>();
  const cancelled = new Set<string>();

  // Bookkeeping prune: once a stream's op chain settles and stays the tail
  // for one macrotask (no further ops arrived), its chain entry — and any
  // cancelled tombstone, whose suppression duty ends with the queued work —
  // are deleted so the long-lived worker does not accumulate dead entries.
  // The macrotask delay keeps the tombstone alive for ops already awaiting
  // the settling tail (cancel-then-queued-chunk must stay silent).
  function schedulePrune(streamId: string, tail: Promise<void>) {
    const prune = () => {
      setTimeout(() => {
        if (chains.get(streamId) === tail) {
          chains.delete(streamId);
          cancelled.delete(streamId);
        }
      }, 0);
    };
    void tail.then(prune, prune);
  }

  function postError(id: string, streamId: string, error: string) {
    post({ kind: 'error', id, streamId, error });
  }

  async function runOpen(request: Extract<StreamWorkerRequest, { op: 'open' }>) {
    const result = await manager.open(
      request.streamId,
      request.params.lang,
      request.params.theme,
    );
    if (cancelled.has(request.streamId)) {
      manager.cancel(request.streamId);
      return;
    }
    if (!result.ok) {
      postError(request.id, request.streamId, result.error);
      return;
    }
    states.set(request.streamId, {
      params: request.params,
      code: result.reused ? (states.get(request.streamId)?.code ?? '') : '',
    });
  }

  async function runChunk(request: Extract<StreamWorkerRequest, { op: 'chunk' }>) {
    const state = states.get(request.streamId);
    if (!state) {
      if (!cancelled.has(request.streamId)) {
        postError(request.id, request.streamId, `no stream session for id: ${request.streamId}`);
      }
      return;
    }
    state.code += request.chunk;
    const result = await manager.enqueue(request.streamId, request.chunk);
    if (states.get(request.streamId) !== state) return;
    if (!result.ok) {
      postError(request.id, request.streamId, result.error);
      return;
    }
    post({
      kind: 'tokens',
      id: request.id,
      streamId: request.streamId,
      recall: result.recall,
      stable: result.stable,
      unstable: result.unstable,
    });
  }

  async function runClose(request: Extract<StreamWorkerRequest, { op: 'close' }>) {
    const state = states.get(request.streamId);
    if (!state) {
      if (!cancelled.has(request.streamId)) {
        postError(request.id, request.streamId, `no stream session for id: ${request.streamId}`);
      }
      return;
    }
    const result = manager.close(request.streamId);
    if (!result.ok) {
      postError(request.id, request.streamId, result.error);
      return;
    }
    if (result.stable.length > 0) {
      post({
        kind: 'tokens',
        id: request.id,
        streamId: request.streamId,
        recall: 0,
        stable: result.stable,
        unstable: [],
      });
    }
    const html = await renderFinal(state.code, state.params);
    if (states.get(request.streamId) !== state) return;
    post({ kind: 'final', id: request.id, streamId: request.streamId, html });
    states.delete(request.streamId);
  }

  function runOp(request: StreamWorkerRequest): Promise<void> {
    switch (request.op) {
      case 'open':
        return runOpen(request);
      case 'chunk':
        return runChunk(request);
      case 'close':
        return runClose(request);
      case 'cancel':
        return Promise.resolve();
    }
  }

  function handle(request: StreamWorkerRequest): Promise<void> {
    if (request.op === 'cancel') {
      // Synchronous: no new messages for this streamId after this point.
      const tail = chains.get(request.streamId);
      if (tail) {
        cancelled.add(request.streamId);
        schedulePrune(request.streamId, tail);
      } else {
        cancelled.delete(request.streamId);
      }
      states.delete(request.streamId);
      manager.cancel(request.streamId);
      return Promise.resolve();
    }
    if (request.op === 'open') {
      // Re-open after a cancel revives the id; cleared synchronously so a
      // cancel arriving after this call still suppresses this open.
      cancelled.delete(request.streamId);
    }
    const previous = chains.get(request.streamId) ?? Promise.resolve();
    const next = previous
      .then(() => runOp(request))
      .catch((error: unknown) => {
        postError(request.id, request.streamId, error instanceof Error ? error.message : String(error));
      });
    chains.set(request.streamId, next);
    schedulePrune(request.streamId, next);
    return next;
  }

  handle._debugState = () => ({
    states: states.size,
    chains: chains.size,
    cancelled: cancelled.size,
  });

  return handle;
}
