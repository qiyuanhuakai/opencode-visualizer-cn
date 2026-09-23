import { describe, expect, it, vi, afterEach } from 'vitest';
import { createKimiAccountClient, parseKimiQuota } from './kimiWebAccount';
afterEach(() => vi.unstubAllGlobals());
describe('Kimi managed account usage', () => {
  it('reads reported quota windows without inventing missing windows', () => {
    const result = parseKimiQuota({ kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.25, resetAt: '2026-09-23T00:00:00Z' } }, extraUsage: null } });
    expect(result.windows).toEqual([{ id: 'limit5h', window: { usedRatio: 0.25, resetAt: '2026-09-23T00:00:00Z' } }]);
  });
  it('rejects managed account errors instead of showing zero usage', () => {
    expect(() => parseKimiQuota({ kind: 'error', message: 'Not signed in' })).toThrow('Not signed in');
  });
  it('rejects invalid quota numbers', () => {
    expect(() => parseKimiQuota({ kind: 'ok', quota: { usages: { limit7d: { usedRatio: NaN } } } })).toThrow('Invalid account');
  });
  it('uses authenticated proxy requests and unwraps the envelope', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { kind: 'ok', quota: { usages: {}, extraUsage: null } } })));
    vi.stubGlobal('fetch', fetcher);
    expect(await createKimiAccountClient('http://localhost/kimi-web/', 'test-token').usage()).toEqual({ windows: [] });
    expect(fetcher).toHaveBeenCalledWith('http://localhost/kimi-web/api/v1/oauth/usage', expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }));
  });
});
