export async function closeTrackedLocalFileSession<T>(
  targets: Map<string, T>,
  sessionId: string,
  closeSession: (sessionId: string) => Promise<void>,
): Promise<void> {
  if (!targets.has(sessionId)) return;
  await closeSession(sessionId);
  targets.delete(sessionId);
}

export function captureTrackedLocalFileChange<T>(
  targets: Map<string, T>,
  sessionId: string,
  content: string,
): { target: T; content: string } | null {
  const target = targets.get(sessionId);
  return target ? { target, content } : null;
}
