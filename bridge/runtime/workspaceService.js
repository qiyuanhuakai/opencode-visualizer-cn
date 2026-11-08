import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { encodeWorkspaceKey } from '../../shared/runtime/identity.js';
import { parseBinding } from '../../shared/runtime/protocol.js';
import { requireValue, textValue } from '../../shared/runtime/capabilities.js';
import { createWorkspaceFsManager, resolveReadablePath } from '../workspaceFs.js';
import { createFileChannels } from './fileChannels.js';
import { createWorkspaceOperations } from './workspaceOperations.js';
import { createPtyService } from './ptyService.js';
import { createWorkspaceReverseTools } from './workspaceReverseTools.js';

// Construct only on the execution target. Roots and connection callbacks come from
// the authenticated host, never from request params or a gateway's path resolver.
export async function createWorkspaceService({ target, epoch, roots }) {
  const binding = parseBinding({ target, epoch, generation: 0 });
  const grants = new Map();
  for (const grant of roots) {
    const root = await realpath(grant.root);
    const info = await stat(root);
    requireValue(info.isDirectory(), 'workspace.directory');
    const pathPolicy = grant.pathPolicy ?? { platform: process.platform === 'win32' ? 'windows' : 'posix', volumeId: String(info.dev), caseSensitive: process.platform !== 'win32' && process.platform !== 'darwin' };
    const key = encodeWorkspaceKey({ environmentId: target, canonicalPath: root, pathPolicy });
    requireValue(!grants.has(key), 'workspace.duplicate', 'conflict');
    requireValue(Array.isArray(grant.permissions) && grant.permissions.every(permission => ['read', 'write', 'command', 'pty', 'reverse'].includes(permission)), 'workspace.permissions');
    grants.set(key, { key, root, pathPolicy, permissions: new Set(grant.permissions) });
  }
  const fs = createWorkspaceFsManager();
  const files = createFileChannels();
  const operations = createWorkspaceOperations();
  const ptys = createPtyService();
  const reverse = createWorkspaceReverseTools();
  const clients = new Set();
  let active = true;
  let closing;
  function connect(context) {
    const captured = parseBinding({ target: context.target, epoch: context.epoch, generation: context.generation });
    const subscriberId = textValue(context.subscriberId, 'subscriberId');
    requireValue(typeof context.assertCurrent === 'function', 'connection.assertCurrent');
    const assertCurrent = context.assertCurrent;
    let connected = true;
    const scope = {
      binding: captured, subscriberId,
      assertCurrent() {
        requireValue(active, 'target.unavailable', 'source_unavailable');
        requireValue(connected, 'connection.closed', 'reconcile_required');
        requireValue(captured.target === binding.target, 'target', 'unauthorized');
        requireValue(captured.epoch === binding.epoch, 'epoch', 'reconcile_required');
        assertCurrent();
      },
      authorizeRuntime(workspaceKey, permission) {
        requireValue(active, 'target.unavailable', 'source_unavailable');
        requireValue(captured.target === binding.target && captured.epoch === binding.epoch, 'target', 'unauthorized');
        const grant = grants.get(workspaceKey);
        requireValue(grant?.permissions.has(permission), 'workspace.permission', 'unauthorized');
        return grant;
      },
      authorize(workspaceKey, permission) {
        scope.assertCurrent();
        return scope.authorizeRuntime(workspaceKey, permission);
      },
      async directory(workspaceKey, value) {
        const grant = scope.authorize(workspaceKey, 'read');
        const { resolved } = await resolveReadablePath(path.resolve(grant.root, value ?? '.'), grant.root);
        requireValue((await stat(resolved)).isDirectory(), 'workspace.directory');
        scope.assertCurrent();
        return resolved;
      },
    };
    scope.assertCurrent();
    const client = {
      async list({ workspaceKey, path: relative = '.' }) {
        const grant = scope.authorize(workspaceKey, 'read');
        return fs.listDirectory(relative, grant.root);
      },
      async read({ workspaceKey, path: relative }) {
        const grant = scope.authorize(workspaceKey, 'read');
        textValue(relative, 'path');
        return fs.readFile(path.resolve(grant.root, relative), grant.root);
      },
      async write({ workspaceKey, path: relative, content }) {
        const grant = scope.authorize(workspaceKey, 'write');
        textValue(relative, 'path');
        return fs.writeFile(path.resolve(grant.root, relative), grant.root, content);
      },
      files: files.connect(scope), operations: operations.connect(scope), ptys: ptys.connect(scope),
      reverse: reverse.connect(scope),
      async disconnect() {
        connected = false;
        clients.delete(client);
        ptys.disconnect(scope);
        await files.disconnect(scope);
      },
    };
    clients.add(client);
    return client;
  }
  return {
    workspaces: [...grants.values()].map(({ key, root, pathPolicy }) => Object.freeze({ key, root, pathPolicy })),
    connect,
    close() {
      active = false;
      closing ??= (async () => {
        const results = await Promise.allSettled([files.close(), operations.close(), ptys.close(), reverse.close()]);
        clients.clear();
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) { closing = undefined; throw new AggregateError(errors, 'Workspace shutdown failed'); }
      })();
      return closing;
    },
  };
}
