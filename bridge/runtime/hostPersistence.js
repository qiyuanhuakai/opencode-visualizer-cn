import { createHash, randomUUID } from 'node:crypto';
import { requireValue } from '../../shared/runtime/capabilities.js';

function encode(value) {
  if (value instanceof Map)
    return {
      $hostType: 'map',
      entries: [...value].map(([key, entry]) => [encode(key), encode(entry)]),
    };
  if (value instanceof Set) return { $hostType: 'set', entries: [...value].map(encode) };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]));
  requireValue(value !== undefined && typeof value !== 'function', 'host.state_json');
  return value;
}
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === 'object') {
    if (value.$hostType === 'map')
      return new Map(value.entries.map(([key, entry]) => [decode(key), decode(entry)]));
    if (value.$hostType === 'set') return new Set(value.entries.map(decode));
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  }
  return value;
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fullValue(store, collection, row) {
  if (!row.chunked) return row.value;
  const chunks = [];
  let offset = 0;
  do {
    const chunk = await store.readChunk({
      collection,
      key: row.key,
      revision: row.revision,
      offset,
    });
    chunks.push(Buffer.from(chunk.data, 'base64'));
    offset = chunk.nextOffset;
  } while (offset !== null);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createHostPersistence({ store, domains }) {
  const known = new Map();
  return {
    async restore() {
      for (const [domain, service] of Object.entries(domains)) {
        const records = [];
        let cursor = null;
        do {
          const page = await store.page({ collection: service.collection, cursor, limit: 100 });
          cursor = page.cursor;
          for (const row of page.items) {
            if (!row.key.startsWith(`host:v1:${domain}:`)) continue;
            const value = await fullValue(store, service.collection, row);
            requireValue(
              value?.version === 1 &&
                value.domain === domain &&
                value.digest === digest(value.payload),
              'host.restore_integrity',
              'reconcile_required',
            );
            known.set(row.key, {
              collection: service.collection,
              revision: row.revision,
              digest: value.digest,
            });
            records.push(decode(value.payload));
          }
        } while (cursor !== null);
        service.restore(records);
      }
    },
    async flush(extra = []) {
      const changes = [...extra],
        next = new Map();
      for (const [domain, service] of Object.entries(domains))
        for (const record of service.export()) {
          const id = service.id(record),
            key = `host:v1:${domain}:${id}`;
          const payload = encode(record),
            hash = digest(payload),
            prior = known.get(key);
          next.set(key, {
            collection: service.collection,
            digest: hash,
            revision: prior?.revision ?? 0,
          });
          if (prior?.digest !== hash)
            changes.push({
              collection: service.collection,
              key,
              expectedRevision: prior?.revision ?? 0,
              value: { version: 1, domain, id, payload, digest: hash },
            });
        }
      for (const [key, prior] of known)
        if (!next.has(key))
          changes.push({
            collection: prior.collection,
            key,
            expectedRevision: prior.revision,
            value: null,
          });
      if (!changes.length) return null;
      requireValue(changes.length <= 200, 'host.transaction_budget', 'source_unavailable');
      const ack = await store.mutate({ intentId: randomUUID(), changes });
      for (const [index, change] of changes.entries()) {
        if (next.has(change.key))
          next.get(change.key).revision = ack.revision - changes.length + index + 1;
      }
      known.clear();
      for (const [key, value] of next) known.set(key, value);
      return ack;
    },
  };
}
