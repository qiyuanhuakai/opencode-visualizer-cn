import type { UnifiedTreeNode } from '../composables/useRuntimeSessionTree';
import type { TopPanelSandbox, TopPanelSession, TopPanelWorktree } from '../types/top-panel';

export function buildRuntimeTopPanelTree(nodes: readonly UnifiedTreeNode[], pins: ReadonlySet<string>, harnessInstanceId?: string): TopPanelWorktree[] {
  function sessions(children: readonly UnifiedTreeNode[]): TopPanelSession[] {
    return children.flatMap(node => {
      if (node.kind !== 'session' && node.kind !== 'native') return sessions(node.children);
      const row = node.session;
      if (harnessInstanceId && row.harnessInstanceId !== harnessInstanceId) return [];
      const time = (value: number | string | null) => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) || undefined : undefined;
      const status = row.status === 'running' ? 'busy' : row.status;
      return [{
        id: row.key,
        title: row.title,
        status: status === 'busy' || status === 'idle' || status === 'retry' ? status : 'unknown',
        timeCreated: time(row.createdAt),
        timeUpdated: time(row.updatedAt),
        archivedAt: row.archived ? time(row.updatedAt) || 1 : undefined,
        isPinned: pins.has(row.key),
      }, ...sessions(node.children)];
    });
  }

  function sandbox(node: UnifiedTreeNode): TopPanelSandbox {
    return {
      key: node.key,
      directory: node.kind === 'worktree' ? node.directory : '',
      kind: node.kind === 'worktree' ? 'folder' : 'global',
      sessions: sessions(node.children),
    };
  }

  return nodes.flatMap(node => {
    if (node.kind === 'repo') {
      const sandboxes = node.children.map(sandbox);
      return [{ key: node.key, directory: sandboxes[0]?.directory ?? '', name: node.name, label: node.name, sandboxes }];
    }
    if (node.kind === 'worktree') {
      return [{ key: node.key, directory: node.directory, name: node.name, label: node.name, sandboxes: [sandbox(node)] }];
    }
    if (node.kind === 'section') return buildRuntimeTopPanelTree(node.children, pins, harnessInstanceId);
    return [{ key: node.key, directory: node.session.directory ?? '', label: node.session.directory ?? 'Global', sandboxes: [{ ...sandbox(node), sessions: sessions([node]) }] }];
  }).filter(worktree => !harnessInstanceId || worktree.sandboxes.some(sandbox => sandbox.sessions.length > 0));
}
