import { spawn } from 'node:child_process';
import { createAcpProcessManager } from '../acpProcessManager.js';
import { createWorkspaceService } from './workspaceService.js';
import { createAcpDriver } from './drivers/acpDriver.js';
import { requireValue } from '../../shared/runtime/capabilities.js';

export async function createWriterAcpHarness({
  environmentId,
  harnessInstanceId,
  epoch,
  store,
  agent,
  lease,
}) {
  let active = true;
  const workspace = await createWorkspaceService({
    target: environmentId,
    epoch,
    roots: [
      {
        root: lease.nativeCwd,
        permissions:
          lease.policy.worktreeAccess === 'read-only'
            ? ['read', 'reverse']
            : ['read', 'write', 'command', 'reverse'],
      },
    ],
  });
  const root = workspace.workspaces[0];
  const manager = createAcpProcessManager({
    spawnProcess: (command, args, options) => spawn(command, args, { ...options, cwd: root.root }),
  });
  const connection = workspace.connect({
    target: environmentId,
    epoch,
    generation: 1,
    subscriberId: `writer:${lease.leaseId}`,
    assertCurrent: () => requireValue(active, 'writer.acp_closed', 'reconcile_required'),
  });
  let native;
  let closing;
  const close = () =>
    (closing ??= (async () => {
      active = false;
      const errors = [];
      for (const release of [
        () => native?.close(),
        () => manager.stopAll(),
        () => connection.disconnect(),
        () => workspace.close(),
      ]) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Writer ACP shutdown failed');
    })());
  try {
    await manager.reconcile([{ ...agent, enabled: true }]);
    native = await createAcpDriver({
      target: environmentId,
      harnessInstanceId,
      epoch,
      store,
      agentId: agent.id,
      manager,
      workspace: connection,
      workspaceKey: root.key,
      cwd: root.root,
      homeDir: root.root,
    });
    return { ...native, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Writer ACP startup failed');
    }
    throw error;
  }
}
