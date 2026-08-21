export type LocalPinnedSessionStore = Record<string, number>;

export function isSamePinnedSessionStore(a: LocalPinnedSessionStore, b: LocalPinnedSessionStore) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

export function normalizePinnedAt(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parsePinnedSessionStore(
  raw: string | null,
  limit: number,
): LocalPinnedSessionStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const normalized: LocalPinnedSessionStore = {};
    Object.entries(record).forEach(([key, value]) => {
      if (!key || typeof key !== 'string') return;
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return;
      normalized[key] = value;
    });
    return limitPinnedSessionStore(normalized, limit);
  } catch {
    return {};
  }
}

export function limitPinnedSessionStore(
  store: LocalPinnedSessionStore,
  limit: number,
): LocalPinnedSessionStore {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const positiveEntries = Object.entries(store)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, normalizedLimit);
  const negativeEntries = Object.entries(store)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value < 0)
    .sort((a, b) => a[1] - b[1]);
  return Object.fromEntries([...positiveEntries, ...negativeEntries]);
}

export function pinnedSessionStoreKey(projectId: string, sessionId: string) {
  const pid = projectId.trim();
  const sid = sessionId.trim();
  if (!pid || !sid) return '';
  return `${pid}:${sid}`;
}

export function projectPinKey(projectId: string) {
  const pid = projectId.trim();
  if (!pid) return '';
  return `project:${pid}`;
}

export function repoPinKey(projectId: string, root: string) {
  const pid = projectId.trim();
  const repoRoot = root.trim();
  if (!pid || !repoRoot) return '';
  return `repo:${pid}:${repoRoot}`;
}

export function sandboxPinKey(projectId: string, directory: string) {
  const pid = projectId.trim();
  const dir = directory.trim();
  if (!pid || !dir) return '';
  return `sandbox:${pid}:${dir}`;
}

export function getEffectivePinnedAt(serverPinnedAt: number | undefined, localOverride?: number) {
  if (typeof localOverride === 'number' && Number.isFinite(localOverride) && localOverride !== 0) {
    return normalizePinnedAt(localOverride);
  }
  return normalizePinnedAt(serverPinnedAt);
}
