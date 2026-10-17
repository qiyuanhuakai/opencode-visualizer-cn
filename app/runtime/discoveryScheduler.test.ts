// @vitest-environment node
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createDiscoveryScheduler } from '../../bridge/runtime/discoveryScheduler.js';
import type { DiscoveryLease, DiscoveryPriority } from '../../bridge/runtime/discoveryScheduler.js';

const environmentId = '11111111-1111-4111-8111-111111111111';
const source = (index: number) => `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
const demand = (index: number, scope: string, priority: DiscoveryPriority = 'background') => ({ environmentId, harnessInstanceId: source(index), scope, priority });
function gate() {
  let release: () => void = () => { throw new Error('uninitialized gate'); };
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('fair discovery scheduler', () => {
  it('reserves interactive capacity beside four background slots and rejects the 257th queued scope', async () => {
    const scheduler = createDiscoveryScheduler();
    const hold = gate();
    const work: Promise<unknown>[] = [];
    try {
      for (let index = 0; index < 4; index++) work.push(scheduler.schedule(demand(Math.floor(index / 2), `running-${index}`), () => hold.promise));
      await setImmediate();
      work.push(scheduler.schedule({ ...demand(2, 'selected', 'selected'), interactive: true }, () => hold.promise));
      await setImmediate();
      expect(scheduler.state).toMatchObject({ background: 4, interactive: 1, native: 5 });
      for (let index = 0; index < 256; index++) work.push(scheduler.schedule(demand(3, `queued-${index}`), () => index));
      await expect(scheduler.schedule(demand(4, 'overflow'), () => 0)).rejects.toMatchObject({ code: 'source_unavailable', reason: 'discovery_queue_full' });
      expect(scheduler.state.queued).toBe(256);
      hold.release();
      expect(await Promise.all(work)).toHaveLength(261);
      await setImmediate();
      expect(scheduler.state).toMatchObject({ background: 0, interactive: 0, native: 0, queued: 0 });
    } finally { hold.release(); scheduler.close(); await Promise.allSettled(work); }
  });
  it('deduplicates and upgrades queued demand while rotating sources within priority', async () => {
    const scheduler = createDiscoveryScheduler();
    const hold = gate();
    const order: string[] = [];
    const work = Array.from({ length: 4 }, (_, index) => scheduler.schedule(demand(Math.floor(index / 2), `block-${index}`), () => hold.promise));
    try {
      await setImmediate();
      const first = scheduler.schedule(demand(2, 'upgrade'), () => { order.push('C-selected'); });
      const upgraded = scheduler.schedule(demand(2, 'upgrade', 'selected'), () => { throw new Error('duplicate action'); });
      expect(upgraded).toBe(first);
      work.push(first);
      work.push(scheduler.schedule(demand(2, 'C-next', 'selected'), () => { order.push('C-next'); }));
      work.push(scheduler.schedule(demand(3, 'D-selected', 'selected'), () => { order.push('D-selected'); }));
      for (const priority of ['background', 'recent', 'expanded'] satisfies DiscoveryPriority[]) work.push(scheduler.schedule(demand(4, priority, priority), () => { order.push(priority); }));
      hold.release();
      await Promise.all(work);
      expect(order).toEqual(['C-selected', 'D-selected', 'C-next', 'expanded', 'recent', 'background']);
    } finally { hold.release(); scheduler.close(); await Promise.allSettled(work); }
  });
  it('starts queued deadlines at admission and never invokes expired work', async () => {
    const scheduler = createDiscoveryScheduler();
    const hold = gate();
    const work = Array.from({ length: 4 }, (_, index) => scheduler.schedule(demand(Math.floor(index / 2), `block-${index}`), () => hold.promise));
    let calls = 0;
    try {
      await setImmediate();
      await expect(scheduler.schedule({ ...demand(2, 'waiting'), deadlineMs: 20 }, () => { calls++; })).rejects.toMatchObject({ code: 'timeout', reason: 'discovery_deadline' });
      expect(calls).toBe(0);
      expect(scheduler.state.queued).toBe(0);
    } finally { hold.release(); scheduler.close(); await Promise.allSettled(work); }
  });
  it('isolates a timed-out source without pretending its native work was cancelled', async () => {
    const scheduler = createDiscoveryScheduler();
    const hold = gate();
    const leases: DiscoveryLease[] = [];
    let acceptedLate = false;
    try {
      const slow = scheduler.schedule({ ...demand(0, 'slow'), deadlineMs: 20 }, async (lease) => {
        leases.push(lease); await hold.promise;
        if (lease.isCurrent()) acceptedLate = true;
      });
      await expect(slow).rejects.toMatchObject({ code: 'timeout' });
      expect(scheduler.state).toMatchObject({ background: 0, native: 1, abandoned: 1 });
      expect(leases[0]?.signal.aborted).toBe(true);
      await expect(scheduler.schedule(demand(0, 'retry'), () => true)).rejects.toMatchObject({ reason: 'discovery_source_draining' });
      expect(await scheduler.schedule(demand(1, 'healthy'), () => 'available')).toBe('available');
      hold.release(); await setImmediate();
      expect(acceptedLate).toBe(false);
      expect(scheduler.state.native).toBe(0);
      expect(await scheduler.schedule(demand(0, 'recovered'), () => 'recovered')).toBe('recovered');
    } finally { hold.release(); scheduler.close(); }
  });
  it('limits abandoned native work across sources and retains the independent interactive slot', async () => {
    const scheduler = createDiscoveryScheduler();
    const hold = gate();
    let nativeCalls = 0;
    try {
      for (let batch = 0; batch < 2; batch++) await Promise.all(Array.from({ length: 4 }, (_, index) => {
        const promise = scheduler.schedule({ ...demand(batch * 4 + index, 'hung'), deadlineMs: 20 }, () => { nativeCalls++; return hold.promise; });
        return expect(promise).rejects.toMatchObject({ code: 'timeout' });
      }));
      expect(scheduler.state).toMatchObject({ native: 8, abandoned: 8, background: 0 });
      await expect(scheduler.schedule({ ...demand(9, 'bounded'), deadlineMs: 20 }, () => { nativeCalls++; })).rejects.toMatchObject({ code: 'timeout' });
      expect(nativeCalls).toBe(8);
      expect(await scheduler.schedule({ ...demand(10, 'interactive', 'selected'), interactive: true }, () => 'ready')).toBe('ready');
    } finally { hold.release(); scheduler.close(); await setImmediate(); }
    expect(scheduler.state.native).toBe(0);
  });
  it('cancels obsolete queued scopes and fences active work on shutdown', async () => {
    const scheduler = createDiscoveryScheduler();
    const hold = gate();
    const active = scheduler.schedule(demand(0, 'active'), async (lease) => { await hold.promise; lease.assertCurrent(); });
    const activeFailure = expect(active).rejects.toMatchObject({ code: 'cancelled' });
    try {
      await setImmediate();
      const queued = scheduler.schedule(demand(1, 'obsolete'), () => { throw new Error('obsolete work invoked'); });
      expect(scheduler.cancel(demand(1, 'obsolete'))).toBe(true);
      await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
      scheduler.close();
      await activeFailure;
      await expect(scheduler.schedule(demand(2, 'after-close'), () => true)).rejects.toMatchObject({ reason: 'discovery_closed' });
    } finally { hold.release(); scheduler.close(); await setImmediate(); }
    expect(scheduler.state.native).toBe(0);
  });
});
