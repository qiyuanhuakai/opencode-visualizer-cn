import { encodeFrame, parseBinding } from '../../shared/runtime/protocol.js';
import { StoreError, collection, text } from './storage/storeProtocol.js';

export function createReplayLog({ store }) {
  async function read(input) {
    const ready = await store.ready;
    if (input.epoch !== ready.epoch) throw new StoreError('replay_required', 'event_epoch');
    return store.replay(input);
  }
  function envelope(binding, patch) {
    return {
      kind: 'event', version: 1, ...binding,
      seq: patch.seq, entityRevision: patch.entityRevision,
      scope: createHash('sha256').update(JSON.stringify([patch.collection, patch.key])).digest('base64url'), type: 'entity.patch',
      payload: { collection: patch.collection, key: patch.key, deleted: patch.deleted },
    };
  }
  return {
    read,
    envelope,
    async frame(bindingInput, input) {
      const binding = parseBinding(bindingInput);
      const ready = await store.ready;
      if (binding.target !== ready.environment) throw new StoreError('unauthorized', 'replay_target');
      const result = await read({ ...input, epoch: binding.epoch });
      const frame = { kind: 'replay', version: 1, ...binding, after: input.after, through: result.through, events: result.events.map((patch) => envelope(binding, patch)) };
      encodeFrame(frame);
      return frame;
    },
    async resolve(patch) {
      const ready = await store.ready;
      if (patch.epoch !== ready.epoch) throw new StoreError('replay_required', 'event_epoch');
      collection(patch.collection); text(patch.key);
      if (!Number.isSafeInteger(patch.entityRevision) || patch.entityRevision < 1) throw new StoreError('invalid_request', 'event_revision');
      const row = await store.get({ collection: patch.collection, key: patch.key });
      if (!row || row.revision < patch.entityRevision || (row.revision === patch.entityRevision && patch.deleted !== (row.value === null))) throw new StoreError('replay_required', 'canonical_revision');
      return { collection: patch.collection, ...row };
    },
  };
}
import { createHash } from 'node:crypto';
