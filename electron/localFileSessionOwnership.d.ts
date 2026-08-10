export function closeOwnedLocalFileSession(
  owners: Map<string, number>,
  localFileEditor: { close(sessionId: string): Promise<void> },
  webContentsId: number,
  sessionId: string,
): Promise<boolean>;
