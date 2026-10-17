import { encodeFrame, parseBinding } from '../../shared/runtime/protocol.js';
import { StoreError } from './storage/storeProtocol.js';
import { createReplayLog } from './replayLog.js';

export const INDEX_COLLECTIONS = Object.freeze(['harnesses', 'workspaces', 'session_summaries', 'interactions', 'operations']);

export function createRuntimeSnapshots({ store }) {
  const replay = createReplayLog({ store });
  return {
    async connect(bindingInput, isCurrent) {
      const binding = parseBinding(bindingInput);
      const inspection = await store.ready;
      if (binding.target !== inspection.environment) throw new StoreError('unauthorized', 'snapshot_target');
      if (binding.epoch !== inspection.epoch) throw new StoreError('replay_required', 'snapshot_epoch');
      if (typeof isCurrent !== 'function') throw new StoreError('invalid_request', 'snapshot_connection');
      const tokens = new Map();
      let active = true;
      function current() {
        if (!active || !isCurrent()) throw new StoreError('reconcile_required', 'snapshot_generation');
      }
      function token(input) {
        for (const [key, value] of tokens) if (value.expiresAt <= Date.now()) tokens.delete(key);
        if (input.token && !tokens.has(input.token)) throw new StoreError('replay_required', 'snapshot_connection_token');
      }
      current();
      return {
        async page(input = {}) {
          current(); token(input);
          const collection = input.collection ?? 'workspaces';
          const owned = input.token ? tokens.get(input.token) : undefined;
          const position = input.cursor ? owned?.cursors.get(input.cursor) : undefined;
          if (input.cursor != null && (!position || position.collection !== collection)) throw new StoreError('replay_required', 'snapshot_connection_cursor');
          const params = { ...input, collection, cursor: position?.cursor ?? null, ...(input.token ? {} : { collections: input.collections ?? INDEX_COLLECTIONS }) };
          const result = await store.snapshot(params);
          current();
          const state = owned ?? { expiresAt: result.expiresAt, cursors: new Map() };
          let cursor = null;
          if (result.cursor !== null) {
            cursor = randomUUID();
            state.cursors.set(cursor, { collection, cursor: result.cursor });
            while (state.cursors.size > 32) state.cursors.delete(state.cursors.keys().next().value);
          }
          tokens.set(result.token, state);
          const frame = { kind: 'snapshot', version: 1, ...binding, ...result, cursor, items: result.items.map((item) => ({ collection, ...item })) };
          encodeFrame(frame);
          return frame;
        },
        async readChunk(input) {
          current(); token(input);
          if (!input.token) throw new StoreError('invalid_request', 'snapshot_chunk_token');
          const result = await store.readChunk(input);
          current();
          return result;
        },
        async replay(input) {
          current();
          const result = await replay.frame(binding, input);
          current();
          return result;
        },
        close() { active = false; tokens.clear(); },
      };
    },
  };
}
import { randomUUID } from 'node:crypto';
