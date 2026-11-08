import { createAcpTerminalManager } from '../acpTerminalManager.js';
import { requireValue } from '../../shared/runtime/capabilities.js';

// Pipe-based jobs are runtime-owned and have no legacy one-shot 30-second timer.
export function createWorkspaceOperations() {
  const terminals = createAcpTerminalManager();
  const jobs = new Map();
  const launches = new Set();
  let active = true;
  return {
    connect(scope) {
      function owned(id, mutate = false) {
        scope.assertCurrent();
        const job = jobs.get(id);
        requireValue(job !== undefined, 'operation', 'conflict');
        scope.authorize(job.workspaceKey, 'command');
        if (mutate) requireValue(job.owner === scope.subscriberId, 'operation.owner', 'unauthorized');
        return job;
      }
      return {
        async start({ workspaceKey, command, args = [], cwd = '.' }) {
          scope.authorize(workspaceKey, 'command');
          const directory = await scope.directory(workspaceKey, cwd);
          requireValue(active, 'operation.closed', 'source_unavailable');
          const launch = terminals.create({ command, args, cwd: directory, outputByteLimit: 2 * 1024 * 1024 });
          launches.add(launch);
          let result;
          try { result = await launch; } finally { launches.delete(launch); }
          requireValue(active, 'operation.closed', 'source_unavailable');
          jobs.set(result.terminalId, { workspaceKey, owner: scope.subscriberId });
          return { operationId: result.terminalId };
        },
        output(id) { owned(id); return terminals.output(id); },
        wait(id) { owned(id); return terminals.waitForExit(id); },
        cancel(id) { owned(id, true); return terminals.kill(id); },
        async remove(id) { owned(id, true); await terminals.release(id); jobs.delete(id); },
      };
    },
    async close() { active = false; await Promise.allSettled(launches); await terminals.stopAll(); jobs.clear(); },
  };
}
