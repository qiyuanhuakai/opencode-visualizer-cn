import { requireValue } from '../../shared/runtime/capabilities.js';
import type { HistoryChunk, HistoryChunkParams, HistoryFence, HistoryOpenResult, HistoryPage, HistoryPageParams } from '../../shared/runtime/historyPage.js';
import type { RuntimeParams, RuntimeResults } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeClient } from './client';
import type { SelectionCapture } from './selectionScope';

export type HistoryOperation<T> = Readonly<{ result: Promise<T>; drained: Promise<void> }>;
type HistoryMethod = 'runtime.history.open' | 'runtime.history.page' | 'runtime.history.chunk' | 'runtime.history.read' | 'runtime.history.close';

export function createHistorySource(client: RuntimeClient) {
  return {
    open(capture: SelectionCapture) {
      requireValue(capture.isCurrent(), 'history.selection', 'cancelled');
      const historyId = crypto.randomUUID();
      const { session } = capture.selection;
      const scope = capture.clientScope;
      let closed = false;
      let opening: HistoryOpenResult | undefined;
      let closing: Promise<void> | undefined;
      const pending = new Set<Promise<void>>();
      const current = () => !closed && capture.isCurrent() && scope.isCurrent();
      function request<M extends HistoryMethod>(method: M, params: RuntimeParams[M], control = false): HistoryOperation<RuntimeResults[M]> {
        const drain = Promise.withResolvers<void>();
        const result = client.request(session.environmentId, method, params, {
          selectionCurrent: control ? scope.isCurrent : current,
          onDrained: drain.resolve,
        });
        const terminal = result.then(() => undefined, () => undefined).then(() => drain.promise);
        pending.add(terminal);
        void terminal.then(() => { pending.delete(terminal); });
        return { result, drained: terminal };
      }
      function fence(value: Readonly<{ historyId: string; fence: HistoryFence }>) {
        requireValue(current(), 'history.selection', 'cancelled');
        requireValue(opening !== undefined && value.historyId === historyId && value.fence.id === opening.fence.id
          && value.fence.sourceGeneration === opening.fence.sourceGeneration, 'history.fence', 'replay_required');
      }
      function qualified(value: HistoryOpenResult | HistoryPage) {
        requireValue(value.historyId === historyId && value.session.environmentId === session.environmentId
          && value.session.harnessInstanceId === session.harnessInstanceId && value.session.nativeSessionId === session.nativeSessionId,
        'history.identity', 'reconcile_required');
      }
      const initial = request('runtime.history.open', { historyId, session });
      const ready: HistoryOperation<HistoryOpenResult> = { drained: initial.drained, result: initial.result.then(value => {
        requireValue(current(), 'history.selection', 'cancelled'); qualified(value); opening = value; return value;
      }) };
      // The owner may be closed before anyone awaits ready; preserve rejection for its consumer.
      void ready.result.then(undefined, () => undefined);
      function page(params: Omit<HistoryPageParams, 'historyId'>): HistoryOperation<HistoryPage> {
        requireValue(opening !== undefined && current(), 'history.ready', 'cancelled');
        const operation = request('runtime.history.page', { ...params, historyId });
        return { drained: operation.drained, result: operation.result.then(value => { fence(value); qualified(value); return value; }) };
      }
      function chunk(params: Omit<HistoryChunkParams, 'historyId'>): HistoryOperation<HistoryChunk> {
        requireValue(opening !== undefined && current(), 'history.ready', 'cancelled');
        const operation = request('runtime.history.chunk', { ...params, historyId });
        return { drained: operation.drained, result: operation.result.then(value => {
          fence(value);
          requireValue(value.pageId === params.pageId && value.descriptorId === params.descriptorId && value.offset === params.offset, 'history.chunk_identity', 'reconcile_required');
          return value;
        }) };
      }
      return {
        ready, page, chunk,
        poll(after: number) {
          requireValue(opening !== undefined && current(), 'history.ready', 'cancelled');
          const operation = request('runtime.history.read', { historyId, after });
          return { drained: operation.drained, result: operation.result.then(value => {
            fence(value); requireValue(value.through >= after, 'history.sequence', 'replay_required'); return value;
          }) };
        },
        close(): Promise<void> {
          if (closing) return closing;
          closed = true;
          closing = (async () => {
            try {
              if (scope.isCurrent()) {
                const operation = request('runtime.history.close', { historyId }, true);
                try { await operation.result; } finally { await operation.drained; }
              }
            } finally { await Promise.all(pending); }
          })();
          void closing.then(undefined, () => { closing = undefined; });
          return closing;
        },
      };
    },
  };
}
export type HistorySource = ReturnType<typeof createHistorySource>;
export type HistoryOwner = ReturnType<HistorySource['open']>;
