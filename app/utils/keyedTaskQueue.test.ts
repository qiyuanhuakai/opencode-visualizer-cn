import { describe, expect, it } from 'vitest';

import { createKeyedTaskQueue } from './keyedTaskQueue';

describe('createKeyedTaskQueue', () => {
  it('serializes tasks for the same backend file while allowing other files to proceed', async () => {
    const queue = createKeyedTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run('backend:file-a', async () => {
      events.push('first:start');
      await firstBlocked;
      events.push('first:end');
    });
    const second = queue.run('backend:file-a', async () => {
      events.push('second');
    });
    const independent = queue.run('backend:file-b', async () => {
      events.push('independent');
    });

    await independent;
    expect(events).toEqual(['first:start', 'independent']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'independent', 'first:end', 'second']);
  });

  it('continues a same-key chain after rejection while other keys and later reuse progress', async () => {
    const queue = createKeyedTaskQueue();
    const events: string[] = [];
    let rejectFirst!: () => void;
    const firstRejected = new Promise<void>((resolve) => {
      rejectFirst = resolve;
    });

    const rejected = queue.run('backend:file-a', async () => {
      events.push('rejected:start');
      await firstRejected;
      throw new Error('expected task failure');
    });
    const continued = queue.run('backend:file-a', async () => {
      events.push('continued');
    });
    const independent = queue.run('backend:file-b', async () => {
      events.push('independent');
    });

    await independent;
    expect(events).toEqual(['rejected:start', 'independent']);

    rejectFirst();
    await expect(rejected).rejects.toThrow('expected task failure');
    await continued;
    expect(events).toEqual(['rejected:start', 'independent', 'continued']);

    await queue.run('backend:file-a', async () => {
      events.push('reused');
    });
    expect(events).toEqual(['rejected:start', 'independent', 'continued', 'reused']);
  });
});
