export type KimiQuotaWindow = { readonly usedRatio: number; readonly resetAt?: string };
export type KimiQuota = { readonly windows: readonly { readonly id: string; readonly window: KimiQuotaWindow }[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseKimiQuota(value: unknown): KimiQuota {
  if (!record(value) || value.kind !== 'ok' || !record(value.quota) || !record(value.quota.usages)) {
    throw new Error(record(value) && typeof value.message === 'string' ? value.message : 'Account usage unavailable');
  }
  const windows: { id: string; window: KimiQuotaWindow }[] = [];
  for (const id of ['limit5h', 'limit7d', 'monthTotal', 'monthCode']) {
    const item = value.quota.usages[id];
    if (item === undefined) continue;
    if (!record(item) || typeof item.usedRatio !== 'number' || !Number.isFinite(item.usedRatio)) {
      throw new Error('Invalid account usage response');
    }
    windows.push({ id, window: { usedRatio: item.usedRatio, ...(typeof item.resetAt === 'string' ? { resetAt: item.resetAt } : {}) } });
  }
  return { windows };
}

export function createKimiAccountClient(baseUrl: string, token: string) {
  async function get(path: string): Promise<unknown> {
    const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/api/v1/oauth/${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Account request failed (${response.status})`);
    const body: unknown = await response.json();
    if (!record(body) || body.code !== 0) throw new Error('Account request failed');
    return body.data;
  }
  return {
    async usage() { return parseKimiQuota(await get('usage')); },
    async profile(): Promise<string> {
      const body = await get('userinfo');
      if (!record(body) || body.kind !== 'ok' || !record(body.userInfo)) throw new Error('Account profile unavailable');
      return typeof body.userInfo.userLevelName === 'string' ? body.userInfo.userLevelName : '';
    },
  };
}
