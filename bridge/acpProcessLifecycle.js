import { STARTUP_GRACE_MS, STOP_GRACE_MS } from './acpProcessState.js';
import { signalProcessTree } from './processTree.js';

export function createAcpProcessEntry(agent, child, status) {
  return {
    agent,
    child,
    status,
    stdoutBuffer: '',
    stdoutQueue: Promise.resolve(),
    stderr: '',
    clientGeneration: 0,
    nextAgentRequestId: 1,
    pendingAgentResponses: new Map(),
    initializeResult: undefined,
  };
}

export async function waitForStableAcpStartup(child, hasFailed) {
  if (hasFailed()) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, STARTUP_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export function stopAcpChild(child) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        signalProcessTree(child, 'SIGKILL');
      } catch {}
      resolve();
    }, STOP_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      signalProcessTree(child, 'SIGTERM');
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}
