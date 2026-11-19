import { expect, it } from 'vitest';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import { composerBodyKey, composerPreferenceKey, createThreadComposerContext } from './threadComposerContext';
import type { ComposerTransition } from './threadComposerContext';

const profileId = parseConnectionProfileId('11111111-1111-4111-8111-111111111111');
const first = { profileId, session: parseSessionRef({ environmentId: '22222222-2222-4222-8222-222222222222', harnessInstanceId: '33333333-3333-4333-8333-333333333333', nativeSessionId: 'same-native' }) };
const second = { ...first, session: parseSessionRef({ ...first.session, harnessInstanceId: '44444444-4444-4444-8444-444444444444' }) };
const thread = { profileId, environmentId: first.session.environmentId, threadId: 'thread:recipient-test' };
const loaded = (capture: ComposerTransition) => ({ bodyKey: capture.bodyKey, preferenceKey: capture.preferenceKey, sessionKey: capture.sessionKey, optionsReady: true });

it('retains one Thread body across target transitions and exits on explicit navigation', () => {
  const context = createThreadComposerContext();
  const entered = context.begin({ origin: 'thread-enter', selection: first, thread });
  for (let index = 0; index < 100; index++) {
    const next = context.begin({ origin: 'thread-target', selection: index % 2 ? first : second });
    expect(next.body).toBe(entered.body);
    expect(next.bodyKey).toBe(entered.bodyKey);
  }
  const normal = context.begin({ origin: 'session-navigation', selection: second });
  expect(normal.body.kind).toBe('session');
  expect(normal.bodyKey).toBe(composerBodyKey({ kind: 'session', selection: second }));
  expect(normal.bodyKey).not.toBe(entered.bodyKey);
  expect(() => context.begin({ origin: 'thread-target', selection: first })).toThrow('composer.thread_context');
  const reopened = context.begin({ origin: 'thread-enter', selection: first, thread });
  expect(reopened.bodyKey).toBe(entered.bodyKey);
  expect(context.begin({ origin: 'thread-close', selection: first }).body.kind).toBe('session');
});

it('qualifies body and preference identities by profile, environment, and harness', () => {
  const foreign = { ...first, session: parseSessionRef({ ...first.session, environmentId: '55555555-5555-4555-8555-555555555555' }) };
  expect(new Set([first, second, foreign].map(composerPreferenceKey)).size).toBe(3);
  const otherProfile = parseConnectionProfileId('66666666-6666-4666-8666-666666666666');
  expect(composerPreferenceKey({ ...first, profileId: otherProfile })).not.toBe(composerPreferenceKey(first));
  expect(composerBodyKey({ kind: 'thread', ...thread })).not.toBe(composerBodyKey({ kind: 'thread', ...thread, environmentId: foreign.session.environmentId }));
  expect(() => createThreadComposerContext().begin({ origin: 'thread-enter', selection: first, thread: { ...thread, profileId: otherProfile } })).toThrow('composer.profile');
});

it('rejects stale selection and receipt completion without clearing later edits', () => {
  const context = createThreadComposerContext();
  const firstCapture = context.begin({ origin: 'thread-enter', selection: first, thread });
  const firstReady = context.complete(firstCapture, loaded(firstCapture));
  if (!firstReady) throw new Error('First recipient is not ready');
  const sent = context.captureSend(firstReady, 1);
  expect(sent.mayClear(1)).toBe(true);
  expect(sent.mayClear(2)).toBe(false);
  const secondCapture = context.begin({ origin: 'thread-target', selection: second });
  expect(context.complete(firstCapture, loaded(firstCapture))).toBeNull();
  expect(context.complete(secondCapture, { ...loaded(secondCapture), sessionKey: firstCapture.sessionKey })).toBeNull();
  expect(context.complete(secondCapture, { ...loaded(secondCapture), optionsReady: false })).toBeNull();
  const secondReady = context.complete(secondCapture, loaded(secondCapture));
  if (!secondReady) throw new Error('Second recipient is not ready');
  expect(sent.mayClear(1)).toBe(false);
  expect(() => context.captureSend(firstReady, 1)).toThrow('composer.not_ready');
  const nextSend = context.captureSend(secondReady, 2);
  context.clear();
  expect(nextSend.mayClear(2)).toBe(false);
});
