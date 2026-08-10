export async function closeTrackedLocalFileSession<T>(
  targets: Map<string, T>,
  sessionId: string,
  closeSession: (sessionId: string) => Promise<void>,
): Promise<void> {
  if (!targets.has(sessionId)) return;
  await closeSession(sessionId);
  targets.delete(sessionId);
}
