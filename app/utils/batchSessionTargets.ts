export type NormalizedBatchSessionTarget = {
  sessionId: string;
  projectId?: string;
  directory: string;
};

export type BatchSessionAction = 'pin' | 'unpin' | 'archive' | 'unarchive' | 'delete';

const BATCH_SESSION_ACTIONS = new Set<BatchSessionAction>([
  'pin',
  'unpin',
  'archive',
  'unarchive',
  'delete',
]);

type RawBatchSessionTarget = {
  sessionId?: unknown;
  projectId?: unknown;
  directory?: unknown;
};

export function isBatchSessionAction(value: unknown): value is BatchSessionAction {
  return typeof value === 'string' && BATCH_SESSION_ACTIONS.has(value as BatchSessionAction);
}

export function normalizeBatchSessionTargets(entries: readonly unknown[]): NormalizedBatchSessionTarget[] {
  const normalized: NormalizedBatchSessionTarget[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as RawBatchSessionTarget;
    const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : '';
    if (!sessionId) continue;
    const projectId = typeof candidate.projectId === 'string' ? candidate.projectId.trim() : '';
    const directory = typeof candidate.directory === 'string' ? candidate.directory.trim() : '';
    if (!directory) continue;

    const dedupeKey = `${projectId}\u0000${directory}\u0000${sessionId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    normalized.push({
      sessionId,
      projectId: projectId || undefined,
      directory,
    });
  }

  return normalized;
}
