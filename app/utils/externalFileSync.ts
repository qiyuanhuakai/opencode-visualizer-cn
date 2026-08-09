export type ExternalFileSyncTarget = {
  baseContent: string;
};

type ExternalFileSyncDependencies = {
  readLatest(): Promise<string>;
  write(content: string): Promise<void>;
  onPersisted(): Promise<void> | void;
};

export type ExternalFileSyncResult = 'unchanged' | 'conflict' | 'saved';

export async function persistExternalFileChange(
  target: ExternalFileSyncTarget,
  content: string,
  dependencies: ExternalFileSyncDependencies,
): Promise<ExternalFileSyncResult> {
  if (content === target.baseContent) return 'unchanged';

  const latest = await dependencies.readLatest();
  if (latest !== target.baseContent) return 'conflict';

  await dependencies.write(content);
  target.baseContent = content;
  await dependencies.onPersisted();
  return 'saved';
}
