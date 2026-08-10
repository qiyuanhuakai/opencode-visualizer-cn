export type ExternalFileSyncTarget = {
  baseContent: string;
  refreshPending?: boolean;
};

type ExternalFileSyncDependencies = {
  readLatest(): Promise<string>;
  write(content: string): Promise<void>;
  onPersisted(): Promise<void> | void;
};

export type ExternalFileSyncResult = 'unchanged' | 'conflict' | 'saved' | 'saved-refresh-failed';

async function refreshPersistedFile(
  target: ExternalFileSyncTarget,
  onPersisted: ExternalFileSyncDependencies['onPersisted'],
): Promise<ExternalFileSyncResult> {
  try {
    await onPersisted();
    target.refreshPending = false;
    return 'saved';
  } catch {
    target.refreshPending = true;
    return 'saved-refresh-failed';
  }
}

export async function persistExternalFileChange(
  target: ExternalFileSyncTarget,
  content: string,
  dependencies: ExternalFileSyncDependencies,
): Promise<ExternalFileSyncResult> {
  if (content === target.baseContent) {
    return target.refreshPending
      ? refreshPersistedFile(target, dependencies.onPersisted)
      : 'unchanged';
  }

  const latest = await dependencies.readLatest();
  if (latest !== target.baseContent) return 'conflict';

  await dependencies.write(content);
  target.baseContent = content;
  target.refreshPending = true;
  return refreshPersistedFile(target, dependencies.onPersisted);
}
