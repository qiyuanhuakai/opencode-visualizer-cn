import type { UnifiedTreeNode } from '../composables/useRuntimeSessionTree';
import type { TopPanelSandbox, TopPanelSession, TopPanelWorktree } from '../types/top-panel';

export function buildRuntimeTopPanelTree(nodes: readonly UnifiedTreeNode[], pins: ReadonlySet<string>, harnessInstanceId?: string, containerPins: ReadonlySet<string> = new Set()): TopPanelWorktree[] {
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

  function sandbox(node: UnifiedTreeNode, kind: TopPanelSandbox['kind']): TopPanelSandbox {
    return {
      key: node.key,
      isPinned: containerPins.has(node.key),
      directory: node.kind === 'worktree' ? node.directory : '',
      kind,
      sessions: sessions(node.children),
    };
  }

  return nodes.flatMap<TopPanelWorktree>(node => {
    if (node.kind === 'repo') {
      const sandboxes = node.children.map(child => sandbox(child, 'branch'));
      return [{ key: node.key, isPinned: containerPins.has(node.key), directory: sandboxes[0]?.directory ?? '', name: node.name, label: node.name, sandboxes }];
    }
    if (node.kind === 'worktree') {
      return [{ key: node.key, directory: node.directory, name: node.name, label: node.name, sandboxes: [sandbox(node, 'branch')] }];
    }
    if (node.kind === 'section') {
      if (node.section !== 'global') return buildRuntimeTopPanelTree(node.children, pins, harnessInstanceId, containerPins);
      const sandboxes = node.children.map(child => sandbox(child, 'folder')).filter(child => child.sessions.length > 0);
      return [{
        key: node.key, directory: '', projectId: 'global', kind: 'global',
        name: 'Global', label: 'Global', sandboxes,
      }];
    }
    return [{ key: node.key, directory: node.session.directory ?? '', label: node.session.directory ?? 'Global', sandboxes: [{ ...sandbox(node, 'global'), sessions: sessions([node]) }] }];
  }).filter(worktree => !harnessInstanceId || worktree.sandboxes.some(sandbox => sandbox.sessions.length > 0));
}
