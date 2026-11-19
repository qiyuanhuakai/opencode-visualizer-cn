import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { resolveReadablePath } from '../workspaceFs.js';
import { requireValue } from '../../shared/runtime/capabilities.js';

const revisionOf = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

export function createWorkspaceReads(scope) {
  async function resolve(input) {
    const grant = scope.authorize(input.workspaceKey, 'read');
    const { resolved } = await resolveReadablePath(path.resolve(grant.root, input.path ?? '.'), grant.root);
    scope.assertCurrent();
    return { grant, resolved };
  }
  return {
    async info(input) {
      const grant = scope.authorize(input.workspaceKey, 'read');
      return { directory: grant.root, home: os.homedir(), platform: process.platform, shell: process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/sh' };
    },
    async list(input) {
      const { grant, resolved } = await resolve(input);
      const before = await stat(resolved);
      requireValue(before.isDirectory(), 'workspace.directory');
      const revision = revisionOf(before);
      requireValue(input.version === undefined || input.version === revision, 'workspace.directory_changed', 'reconcile_required');
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 200;
      const directory = await opendir(resolved);
      const items = [];
      let index = 0;
      let hasMore = false;
      try {
        for await (const entry of directory) {
          if (index++ < offset) continue;
          if (items.length === limit) { hasMore = true; break; }
          items.push({ name: entry.name, path: path.relative(grant.root, path.join(resolved, entry.name)).split(path.sep).join('/'), type: entry.isDirectory() ? 'directory' : 'file' });
        }
      } finally {
        await directory.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error; });
      }
      requireValue(revisionOf(await stat(resolved)) === revision, 'workspace.directory_changed', 'reconcile_required');
      scope.assertCurrent();
      return { items, version: revision, nextOffset: hasMore ? offset + items.length : null };
    },
    async read(input) {
      const { resolved } = await resolve(input);
      const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        requireValue(before.isFile(), 'workspace.file');
        const revision = revisionOf(before);
        requireValue(input.version === undefined || input.version === revision, 'workspace.file_changed', 'reconcile_required');
        const offset = input.offset ?? 0;
        requireValue(offset <= before.size, 'workspace.offset');
        const bytes = Buffer.alloc(Math.min(65536, before.size - offset));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
        requireValue(revisionOf(await handle.stat()) === revision, 'workspace.file_changed', 'reconcile_required');
        scope.assertCurrent();
        return { path: resolved, version: revision, size: before.size, offset, dataBase64: bytes.subarray(0, bytesRead).toString('base64'), nextOffset: offset + bytesRead < before.size ? offset + bytesRead : null };
      } finally { await handle.close(); }
    },
  };
}
