import { requireValue } from '../../shared/runtime/capabilities.js';

export function parseWorktrees(output, maxBytes = 2097152) {
  requireValue(
    typeof output === 'string' && Buffer.byteLength(output) <= maxBytes,
    'git.output_size',
  );
  requireValue(output === '' || output.endsWith('\0\0'), 'git.worktree_terminator');
  const entries = [];
  let entry;
  for (const field of output.split('\0')) {
    if (!field) {
      if (entry) {
        entries.push(Object.freeze(entry));
        entry = undefined;
      }
      continue;
    }
    const separator = field.indexOf(' ');
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? '' : field.slice(separator + 1);
    if (key === 'worktree') {
      requireValue(!entry && value.length > 0, 'git.worktree_record');
      entry = { path: value, detached: false, bare: false };
    } else {
      requireValue(entry, 'git.worktree_record');
      switch (key) {
        case 'HEAD':
          requireValue(/^[0-9a-f]{40,64}$/.test(value), 'git.head');
          entry.head = value;
          break;
        case 'branch':
          entry.branch = value;
          break;
        case 'detached':
          entry.detached = true;
          break;
        case 'bare':
          entry.bare = true;
          break;
        case 'locked':
          entry.locked = value;
          break;
        case 'prunable':
          entry.prunable = value;
          break;
        default:
          requireValue(false, 'git.worktree_field');
      }
    }
  }
  return entries;
}

export function gitLine(output) {
  requireValue(
    typeof output === 'string' && output.endsWith('\n') && !output.includes('\0'),
    'git.line',
  );
  return output.slice(0, -1);
}
