export function shouldPreservePendingCodexSelection(params: {
  pendingSessionLock: string;
  selectedSessionId: string;
  projectSandboxes: Record<string, { sessions: Record<string, unknown> }>;
}) {
  const { pendingSessionLock, selectedSessionId, projectSandboxes } = params;
  if (!pendingSessionLock || selectedSessionId !== pendingSessionLock) return false;
  return !Object.values(projectSandboxes).some((sandbox) => Boolean(sandbox.sessions[selectedSessionId]));
}
