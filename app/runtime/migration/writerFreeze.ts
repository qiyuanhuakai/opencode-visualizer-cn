export type LegacyWrite = Readonly<{ channel: 'storage' | 'backend-history' | 'codex-history' | 'native-history'; key: string; value: string | null }>;
export type PendingLegacyWrite = LegacyWrite & Readonly<{ clientOrigin: string; revision: number }>;
export type WriterPhase = 'legacy' | 'draining' | 'frozen' | 'paused' | 'cutover';
export class WriterFreezeError extends Error {
  constructor(readonly code: 'editing_paused' | 'pending_budget' | 'drain_busy' | 'freeze_active' | 'legacy_write_failed') { super(code); this.name = 'WriterFreezeError'; }
}
const drains = new Set<() => void | Promise<void>>();
const listeners = new Set<(phase: WriterPhase) => void>();
const pending: PendingLegacyWrite[] = [];
let phase: WriterPhase = 'legacy';
let revision = 0;
let pendingBytes = 0;
let origin = '';
let sink: ((write: PendingLegacyWrite) => Promise<void>) | undefined;
let pumping: Promise<void> | undefined;
let failure: unknown;
let sourceFrozen = false;
const MAX_PENDING_COUNT = 32;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
function change(next: WriterPhase): void { phase = next; for (const listener of listeners) listener(next); }
export function legacyWriterPhase(): WriterPhase { return phase; }
export function legacyEditingPaused(): boolean { return phase !== 'legacy' && phase !== 'draining'; }
export function onLegacyWriterPhase(listener: (phase: WriterPhase) => void): () => void { listeners.add(listener); listener(phase); return () => { listeners.delete(listener); }; }
export function registerLegacyWriter(drain: () => void | Promise<void>): () => void { drains.add(drain); return () => { drains.delete(drain); }; }
export function confirmLegacyWrite(saved: boolean): boolean { if (!saved && phase === 'draining') throw new WriterFreezeError('legacy_write_failed'); return saved; }
export function assertLegacyEditAdmission(): void { if (legacyEditingPaused()) throw new WriterFreezeError('editing_paused'); }
export function writerPendingState(): Readonly<{ count: number; bytes: number; failed: boolean }> { return { count: pending.length, bytes: pendingBytes, failed: failure !== undefined }; }
function bytes(write: LegacyWrite): number { return write.value === null ? 0 : write.value.length * 2; }
async function pump(): Promise<void> {
  if (pumping) return pumping;
  const target = sink;
  if (!target) return;
  pumping = (async () => {
    while (pending.length) {
      const write = pending[0];
      await target(write);
      pending.shift(); pendingBytes -= bytes(write);
    }
  })();
  try { await pumping; } catch (error) { failure = error; change('paused'); throw error; }
  finally { pumping = undefined; }
}
export function retainFrozenLegacyWrite(write: LegacyWrite): boolean {
  if (phase === 'legacy' || phase === 'draining') { revision++; return false; }
  const size = bytes(write);
  if (pending.length >= MAX_PENDING_COUNT || pendingBytes + size > MAX_PENDING_BYTES) {
    failure = new WriterFreezeError('pending_budget'); change('paused'); throw failure;
  }
  pending.push({ ...write, clientOrigin: origin, revision: ++revision }); pendingBytes += size;
  if (pendingBytes >= MAX_PENDING_BYTES || pending.length >= MAX_PENDING_COUNT) change('paused');
  // A rejected durable write remains in the bounded queue. Explicit drain/retry surfaces the failure.
  void pump().catch((error: unknown) => { failure = error; });
  return true;
}
export async function freezeLegacyWriters(options: Readonly<{ clientOrigin: string; persist: (write: PendingLegacyWrite) => Promise<void> }>): Promise<void> {
  if (phase !== 'legacy' && !(phase === 'paused' && !sourceFrozen)) throw new WriterFreezeError('freeze_active');
  failure = undefined;
  origin = options.clientOrigin; sink = options.persist; change('draining');
  try {
    for (let pass = 0; pass < 16; pass++) {
      const before = revision;
      for (const drain of drains) await drain();
      if (revision === before) { sourceFrozen = true; change('frozen'); return; }
    }
    throw new WriterFreezeError('drain_busy');
  } catch (error) { failure = error; change('paused'); throw error; }
}
export async function flushFrozenLegacyWrites(): Promise<void> {
  if (failure !== undefined) throw failure;
  await pump();
}
export async function retryFrozenLegacyWrites(): Promise<void> {
  if (!sourceFrozen && sink) { await freezeLegacyWriters({ clientOrigin: origin, persist: sink }); return; }
  failure = undefined; await pump(); change('frozen');
}
export async function completeLegacyCutover(): Promise<void> {
  await flushFrozenLegacyWrites(); change('cutover');
}
