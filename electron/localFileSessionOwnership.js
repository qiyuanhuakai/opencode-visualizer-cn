export async function closeOwnedLocalFileSession(
  owners,
  localFileEditor,
  webContentsId,
  sessionId,
) {
  if (owners.get(sessionId) !== webContentsId) return false;
  await localFileEditor.close(sessionId);
  owners.delete(sessionId);
  return true;
}
