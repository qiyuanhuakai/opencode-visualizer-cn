import { requireValue } from '../../shared/runtime/capabilities.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import type { ConnectionProfileId, EnvironmentId } from '../../shared/runtime/identity.js';
import type { Binding } from '../../shared/runtime/protocol.js';
import type { IndexCollection } from '../../shared/runtime/runtimeWire.js';

export type CacheUsage = Readonly<{ residentBytes: number; reservedBytes: number; entries: number }>;
export type MemoryLease = Readonly<{ resize(bytes: number): boolean; commit(): void; release(): void }>;
export type MemoryBudget = Readonly<{
  reserve(input: Readonly<{ bytes: number; entries: number }>): MemoryLease | null;
  usage(): CacheUsage;
}>;

export function createMemoryBudget({ maxBytes, maxEntries }: Readonly<{ maxBytes: number; maxEntries: number }>): MemoryBudget {
  const valid = (value: number) => Number.isSafeInteger(value) && value >= 0;
  requireValue(valid(maxBytes) && valid(maxEntries), 'cache.limits');
  let residentBytes = 0;
  let reservedBytes = 0;
  let entries = 0;
  return {
    reserve(input) {
      requireValue(valid(input.bytes) && valid(input.entries), 'cache.reservation');
      if (input.bytes > maxBytes - residentBytes - reservedBytes || input.entries > maxEntries - entries) return null;
      let bytes = input.bytes;
      const count = input.entries;
      let resident = false;
      let released = false;
      reservedBytes += bytes; entries += input.entries;
      return {
        resize(next) {
          requireValue(valid(next), 'cache.resize');
          if (released || next - bytes > maxBytes - residentBytes - reservedBytes) return false;
          if (resident) residentBytes += next - bytes;
          else reservedBytes += next - bytes;
          bytes = next;
          return true;
        },
        commit() {
          if (released || resident) return;
          reservedBytes -= bytes; residentBytes += bytes; resident = true;
        },
        release() {
          if (released) return;
          if (resident) residentBytes -= bytes;
          else reservedBytes -= bytes;
          entries -= count; released = true;
        },
      };
    },
    usage: () => ({ residentBytes, reservedBytes, entries }),
  };
}

export const ENTITY_LIMITS = { entries: 2000, bytes: 16 * 1024 * 1024, page: 200 } as const;
export type EntityAddress = Readonly<{ profileId: ConnectionProfileId; target: EnvironmentId; collection: IndexCollection; key: string }>;
export type EntityFence = Readonly<{ binding: Binding; localGeneration: number; snapshotRevision: number; snapshotWatermark: number; applicationGeneration: number }>;
export type CachedEntity = Readonly<{ address: EntityAddress; revision: number; value?: JsonValue; chunked?: boolean; bytes?: number }>;
export type EntityLease = Readonly<{ entity: CachedEntity; release(): void }>;
type Entry = { readonly entity: CachedEntity; readonly lease: MemoryLease; references: number; retained: boolean };
type Admission = CachedEntity & Readonly<{ fence: EntityFence }>;

export function estimateRetainedBytes(value: JsonValue, ceiling = ENTITY_LIMITS.bytes): number {
  let bytes = 0;
  function record(item: JsonValue): item is Readonly<Record<string, JsonValue>> { return item !== null && typeof item === 'object' && !Array.isArray(item); }
  function visit(item: JsonValue): void {
    if (bytes > ceiling) return;
    if (typeof item === 'string') { bytes += 128 + item.length * 2; return; }
    if (item === null || typeof item !== 'object') { bytes += 8; return; }
    bytes += 128;
    if (Array.isArray(item)) {
      for (const child of item) { bytes += 64; visit(child); if (bytes > ceiling) break; }
    } else if (record(item)) {
      for (const key in item) { bytes += 64 + key.length * 2; visit(item[key]); if (bytes > ceiling) break; }
    }
  }
  visit(value);
  return bytes;
}

export function createEntityCache({ budget }: Readonly<{ budget: MemoryBudget }>) {
  const entries = new Map<string, Entry>();
  const fences = new Map<EnvironmentId, Readonly<{ fence: EntityFence; lease: MemoryLease }>>();
  const keyOf = (address: EntityAddress) => JSON.stringify([address.profileId, address.target, address.collection, address.key]);
  function retire(key: string, entry: Entry) {
    entries.delete(key); entry.retained = false;
    if (entry.references === 0) entry.lease.release();
  }
  function evict(): boolean {
    for (const [key, entry] of entries) {
      const fence = fences.get(entry.entity.address.target)?.fence;
      if (entry.references || fence && entry.entity.revision > fence.snapshotRevision) continue;
      retire(key, entry); return true;
    }
    return false;
  }
  function reserve(input: Readonly<{ bytes: number; entries: number }>): MemoryLease | null {
    while (true) {
      const lease = budget.usage().entries + input.entries <= ENTITY_LIMITS.entries ? budget.reserve(input) : null;
      if (lease) return lease;
      if (!evict()) return null;
    }
  }
  function clear(target?: EnvironmentId) {
    for (const [key, entry] of entries) if (target === undefined || entry.entity.address.target === target) retire(key, entry);
    for (const [environment, entry] of fences) if (target === undefined || environment === target) { entry.lease.release(); fences.delete(environment); }
  }
  function admit(input: Admission): 'applied' | 'stale' | 'budget' {
    if (input.address.target !== input.fence.binding.target || fences.get(input.address.target)?.fence !== input.fence) return 'stale';
    requireValue(Number.isSafeInteger(input.revision) && input.revision >= 0, 'cache.revision');
    const key = keyOf(input.address); const previous = entries.get(key);
    if (previous && previous.entity.revision >= input.revision) return 'stale';
    const bytes = 1024 + 4 * key.length + (input.value === undefined ? 0 : estimateRetainedBytes(input.value));
    if (bytes > ENTITY_LIMITS.bytes) return 'budget';
    const lease = reserve({ bytes, entries: 1 });
    if (!lease) return 'budget';
    if (previous) retire(key, previous);
    const entity: CachedEntity = Object.freeze({ address: Object.freeze({ ...input.address }), revision: input.revision,
      ...(input.value === undefined ? {} : { value: input.value }),
      ...(input.chunked === undefined ? {} : { chunked: input.chunked }), ...(input.bytes === undefined ? {} : { bytes: input.bytes }) });
    lease.commit(); entries.set(key, { entity, lease, references: 0, retained: true });
    return 'applied';
  }
  return {
    begin(fence: EntityFence) {
      const previous = fences.get(fence.binding.target)?.fence;
      requireValue(!previous || fence.applicationGeneration > previous.applicationGeneration, 'cache.generation', 'reconcile_required');
      clear(fence.binding.target);
      const lease = reserve({ bytes: 512 + 2 * fence.binding.epoch.length, entries: 0 });
      requireValue(lease !== null, 'cache.fence_budget', 'source_unavailable');
      lease.commit(); fences.set(fence.binding.target, { fence, lease });
    },
    admit,
    remove(input: Omit<Admission, 'value'>) { return admit({ ...input, value: null }); },
    get(address: EntityAddress): EntityLease | null {
      const key = keyOf(address); const entry = entries.get(key);
      if (!entry) return null;
      const lease = budget.reserve({ bytes: 256, entries: 0 });
      if (!lease) return null;
      lease.commit(); entry.references++; entries.delete(key); entries.set(key, entry);
      let released = false;
      return {
        entity: entry.entity,
        release() {
          if (released) return;
          released = true; entry.references--; lease.release();
          if (!entry.retained && entry.references === 0) entry.lease.release();
        },
      };
    },
    reserve,
    clear,
    usage: budget.usage,
  };
}
