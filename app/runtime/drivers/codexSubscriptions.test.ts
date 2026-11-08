// @vitest-environment node
import { expect, it } from 'vitest';
import { parseSessionRef } from '../../../shared/runtime/identity.js';
import { createCodexSubscriptions } from '../../../shared/runtime/native/codex/subscriptions.js';

it('discards queued notifications when the native generation closes', async () => {
  const source = createCodexSubscriptions();
  const first = source.subscribe();
  const second = source.subscribe();
  source.emit({ type: 'item/completed', session: parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'old-session' }), epoch: 'old-epoch', processGeneration: 1, payload: { text: 'Old generation output' } });
  source.close();
  expect(await first.next()).toEqual({ value: undefined, done: true });
  expect(await second.next()).toEqual({ value: undefined, done: true });
  await first.return?.(); await second.return?.();
});

it('settles an awaiting observer when its native generation closes', async () => {
  const source = createCodexSubscriptions();
  const observer = source.subscribe();
  const pending = observer.next();
  source.close();
  await expect(pending).resolves.toEqual({ value: undefined, done: true });
  expect(await observer.next()).toEqual({ value: undefined, done: true });
});
