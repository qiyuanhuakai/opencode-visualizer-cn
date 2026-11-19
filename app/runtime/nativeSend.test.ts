import { describe, expect, it } from 'vitest';
import { nativeSendArgs } from './nativeSend';
import { createNativeHistoryProjection } from './nativeHistory';

describe('instance native projections', () => {
  it('encodes each native protocol when a captured source owns the same composer input', () => {
    // Given a composer selection including native model and mode.
    const input = { text: 'question', model: 'provider/model', mode: 'build' };
    // When the source owns the encoding, then its real protocol fields are used.
    expect(nativeSendArgs('opencode', input)).toEqual({ body: { parts: [{ type: 'text', text: 'question' }], agent: 'build', model: { providerID: 'provider', modelID: 'model' } } });
    expect(nativeSendArgs('codex', input)).toEqual({ native: { input: [{ type: 'text', text: 'question' }], model: 'model', expectedModelProvider: 'provider' } });
    expect(nativeSendArgs('acp', input)).toEqual({ prompt: [{ type: 'text', text: 'question' }] });
    expect(nativeSendArgs('kimi-web', input)).toEqual({ content: [{ type: 'text', text: 'question' }], model: 'model' });
    expect(nativeSendArgs('dsh', input)).toMatchObject({ request: { content: [{ type: 'text', text: 'question' }], requestId: expect.any(String) } });
  });
  it('retains the Codex user anchor when a native item arrives on the next history page', () => {
    // The production Codex archive requests sortDirection: 'desc', so the
    // assistant arrives before its older prompt on the next native page.
    const normalize = createNativeHistoryProjection('codex', 'thread');
    normalize({ turnId: 'turn', item: { id: 'a', type: 'agentMessage', text: 'reply' } });
    // A projection replaces the complete retained window, including the user;
    // the already visible assistant must acquire its newly discovered parent.
    const entries = normalize({ turnId: 'turn', item: { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] } });
    expect(entries).toEqual([
      expect.objectContaining({ info: expect.objectContaining({ id: 'turn:user:u', role: 'user', sessionID: 'thread' }) }),
      expect.objectContaining({ info: expect.objectContaining({ role: 'assistant', parentID: 'turn:user:u', sessionID: 'thread' }) }),
    ]);
  });
});

it('preserves Kimi usage and the main-agent user root in the native transcript', () => {
  const project = createNativeHistoryProjection('kimi-web', 'kimi-session');
  const entries = project({ kind: 'turn', turnId: 'turn', ordinal: 1, state: 'done', prompt: 'question', steps: [{ stepId: 'step', frames: [{ frameId: 'text', kind: 'text', role: 'assistant', text: 'answer' }], usage: { inputOther: 9, output: 4, inputCacheRead: 6, inputCacheCreation: 3 } }] });
  expect(entries).toEqual([
    expect.objectContaining({ info: expect.objectContaining({ role: 'user', id: 'kimi-session:transcript:turn:user' }) }),
    expect.objectContaining({ info: expect.objectContaining({ agent: 'main', parentID: 'kimi-session:transcript:turn:user', tokens: { input: 9, output: 4, reasoning: 0, cache: { read: 6, write: 3 } } }) }),
  ]);
});

it('retains the native Kimi prompt identity used by checkpoint mutations', () => {
  const entries = createNativeHistoryProjection('kimi-web', 'kimi-session')({ kind: 'turn', turnId: 'turn', triggerPromptId: 'native-prompt-id', ordinal: 1, state: 'done', prompt: 'question', steps: [{ stepId: 'step', frames: [{ frameId: 'text', kind: 'text', role: 'assistant', text: 'answer' }] }] });
  expect(entries).toEqual([
    expect.objectContaining({ info: expect.objectContaining({ role: 'user', id: 'native-prompt-id', sessionID: 'kimi-session' }) }),
    expect.objectContaining({ info: expect.objectContaining({ role: 'assistant', parentID: 'native-prompt-id' }) }),
  ]);
});
