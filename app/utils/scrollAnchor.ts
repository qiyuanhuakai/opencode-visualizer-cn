export type ScrollAnchorSettlement = {
  waitForFrame: () => Promise<void>;
  measureDelta: () => number | null;
  applyDelta: (delta: number) => void;
  hasPendingWork: () => boolean;
  maxFrames?: number;
  requiredStableFrames?: number;
  frameTimeoutMs?: number;
};

export async function settleScrollAnchor(options: ScrollAnchorSettlement): Promise<void> {
  const maxFrames = Math.max(1, options.maxFrames ?? 90);
  const requiredStableFrames = Math.max(1, options.requiredStableFrames ?? 2);
  const frameTimeoutMs = Math.max(1, options.frameTimeoutMs ?? 50);
  let stableFrames = 0;

  for (let frame = 0; frame < maxFrames; frame += 1) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      options.waitForFrame(),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, frameTimeoutMs);
      }),
    ]).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
    const delta = options.measureDelta();
    if (delta === null) return;
    if (Math.abs(delta) > 0.5) {
      options.applyDelta(delta);
      stableFrames = 0;
      continue;
    }
    if (options.hasPendingWork()) {
      stableFrames = 0;
      continue;
    }
    stableFrames += 1;
    if (stableFrames >= requiredStableFrames) return;
  }
}
