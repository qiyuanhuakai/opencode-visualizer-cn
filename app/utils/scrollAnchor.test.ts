import { describe, expect, it, vi } from 'vitest';

import { settleScrollAnchor } from './scrollAnchor';

describe('settleScrollAnchor', () => {
  it('holds the anchor until late worker renders and two frames are stable', async () => {
    const deltas = [36, 0, 0];
    const pending = [true, false, false];
    let frame = -1;
    const applyDelta = vi.fn();

    await settleScrollAnchor({
      waitForFrame: async () => {
        frame += 1;
      },
      measureDelta: () => deltas[frame] ?? 0,
      applyDelta,
      hasPendingWork: () => pending[frame] ?? false,
      maxFrames: 10,
      requiredStableFrames: 2,
    });

    expect(applyDelta).toHaveBeenCalledOnce();
    expect(applyDelta).toHaveBeenCalledWith(36);
    expect(frame).toBe(2);
  });

  it('stops when the anchor leaves the rendered window', async () => {
    const waitForFrame = vi.fn().mockResolvedValue(undefined);

    await settleScrollAnchor({
      waitForFrame,
      measureDelta: () => null,
      applyDelta: vi.fn(),
      hasPendingWork: () => true,
    });

    expect(waitForFrame).toHaveBeenCalledOnce();
  });

  it('keeps settling when animation frames are suspended in a hidden page', async () => {
    let delta = 80;
    const applyDelta = vi.fn((applied: number) => {
      delta -= applied;
    });
    const settlement = settleScrollAnchor({
      waitForFrame: () => new Promise<void>(() => {}),
      measureDelta: () => delta,
      applyDelta,
      hasPendingWork: () => false,
      maxFrames: 3,
      requiredStableFrames: 1,
      frameTimeoutMs: 1,
    });

    const outcome = await Promise.race([
      settlement.then(() => 'settled'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 20)),
    ]);

    expect(outcome).toBe('settled');
    expect(applyDelta).toHaveBeenCalledWith(80);
  });
});
