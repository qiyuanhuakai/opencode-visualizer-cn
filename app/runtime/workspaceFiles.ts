import { requireValue } from '../../shared/runtime/capabilities.js';
import type { EnvironmentId, WorkspaceKey } from '../../shared/runtime/identity.js';
import type { RuntimeClient } from './client';
import type { RuntimeResults } from '../../shared/runtime/runtimeWire.js';

export function createWorkspaceFiles(client: RuntimeClient, target: EnvironmentId, workspaceKey: WorkspaceKey) {
  const scope = client.scope(target);
  const options = { selectionCurrent: scope.isCurrent };
  async function list(path: string) {
    const items: { name: string; path: string; type: 'file' | 'directory' }[] = [];
    let offset: number | null = 0;
    let version: string | undefined;
    while (offset !== null) {
      const page: RuntimeResults['runtime.workspace.list'] = await client.request(target, 'runtime.workspace.list', { workspaceKey, path, offset, ...(version ? { version } : {}) }, options);
      requireValue(version === undefined || page.version === version, 'workspace.directory_changed', 'reconcile_required');
      requireValue(items.length + page.items.length <= 10000, 'workspace.directory_budget', 'source_unavailable');
      items.push(...page.items);
      requireValue(page.nextOffset === null || page.nextOffset > offset, 'workspace.directory_cursor');
      version = page.version;
      offset = page.nextOffset;
    }
    return items;
  }
  async function read(path: string) {
    let offset: number | null = 0;
    let version: string | undefined;
    let result: Uint8Array | undefined;
    while (offset !== null) {
      const page: RuntimeResults['runtime.workspace.read'] = await client.request(target, 'runtime.workspace.read', { workspaceKey, path, offset, ...(version ? { version } : {}) }, options);
      requireValue(page.offset === offset && (version === undefined || page.version === version), 'workspace.file_changed', 'reconcile_required');
      requireValue(page.size <= 16 * 1024 * 1024, 'workspace.file_preview_budget', 'source_unavailable');
      result ??= new Uint8Array(page.size);
      requireValue(result.length === page.size, 'workspace.file_changed', 'reconcile_required');
      const bytes = Uint8Array.from(atob(page.dataBase64), character => character.charCodeAt(0));
      requireValue(offset + bytes.length <= result.length && (page.nextOffset === null ? offset + bytes.length === page.size : page.nextOffset === offset + bytes.length), 'workspace.file_chunk');
      result.set(bytes, offset);
      version = page.version;
      offset = page.nextOffset;
    }
    return result ?? new Uint8Array();
  }
  async function write(path: string, content: string) {
    const bytes = new TextEncoder().encode(content);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const channel = await client.request(target, 'runtime.channel.open', { service: 'file', workspaceKey, path, size: bytes.length, sha256, replace: true }, options);
    try {
      for (let offset = 0; offset < bytes.length; offset += channel.chunkBytes) {
        const data = bytes.subarray(offset, offset + channel.chunkBytes);
        requireValue(scope.isCurrent(), 'workspace.connection', 'reconcile_required');
        client.sendBinary({ channelId: channel.channelId, offset, data });
        await client.request(target, 'runtime.channel.ack', { channelId: channel.channelId, offset, length: data.length }, options);
      }
      return await client.request(target, 'runtime.channel.finish', { channelId: channel.channelId }, options);
    } catch (cause) {
      if (scope.isCurrent()) await client.request(target, 'runtime.channel.cancel', { channelId: channel.channelId }, options).catch(() => undefined);
      throw cause;
    }
  }
  return { list, read, write, info: () => client.request(target, 'runtime.workspace.info', { workspaceKey }, options) };
}
