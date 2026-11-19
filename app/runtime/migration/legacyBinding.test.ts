import { describe, expect, it } from 'vitest';
import { describeLocalBinding } from './legacyBinding';
import { legacyDigest } from './legacyExport';

describe('legacy storage writer key compatibility', () => {
  for (const prefix of ['', 'opencode.']) for (const indexed of [false, true]) {
    it(`binds ${prefix || 'renderer'} ${indexed ? 'IndexedDB' : 'KV'} history keys`, async () => {
      const namespace = `backend-history-v1:${'a'.repeat(32)}`;
      const key = `${prefix}state.backendHistory.v1.${'a'.repeat(32)}.session-001`;
      const sourceKey = 'b'.repeat(64);
      expect(await describeLocalBinding({ key: indexed ? JSON.stringify([key, 'message-1']) : key, namespace }, sourceKey)).toEqual({ sourceKey, kind: 'history', nativeSessionId: 'session-001', scopeFingerprint: await legacyDigest(namespace) });
    });
  }
  it('keeps a tuple from a different scope unattached', async () => {
    const key = `state.backendHistory.v1.${'a'.repeat(32)}.session-001`;
    expect(await describeLocalBinding({ key: JSON.stringify([key, 'message-1']), namespace: `backend-history-v1:${'c'.repeat(32)}` }, 'b'.repeat(64))).toEqual({ sourceKey: 'b'.repeat(64), kind: 'local' });
  });
});
