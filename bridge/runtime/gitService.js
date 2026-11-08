import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { encodeRepoKey, encodeWorkspaceKey } from '../../shared/runtime/identity.js';
import { requireValue } from '../../shared/runtime/capabilities.js';
import { GitCommandError } from './targetGitCommand.js';
import { parseWorktrees, gitLine } from './gitOutputParser.js';

export function createGitService({ command, now = () => performance.now() }) {
  const topologies = new Map();
  const probes = new Map();
  async function checked(workspace, args) {
    const result = await command.run({ workspace, args });
    if (result.exitCode !== 0) throw new GitCommandError('exit', result);
    return result.stdout;
  }
  async function repository(workspace) {
    await command.authorize(workspace);
    const result = await command.run({
      workspace,
      args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    });
    if (result.exitCode !== 0) {
      let directory = workspace.canonicalPath;
      for (;;) {
        try {
          await lstat(path.join(directory, '.git'));
          throw new GitCommandError('corrupt', result);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      return { kind: 'non-git', workspace };
    }
    const canonicalCommonDir = await realpath(gitLine(result.stdout));
    const repo = {
      environmentId: workspace.environmentId,
      canonicalCommonDir,
      pathPolicy: await command.policyFor(canonicalCommonDir),
    };
    return { kind: 'git', workspace, repo, repoKey: encodeRepoKey(repo) };
  }
  async function topology(info) {
    const cached = topologies.get(info.repoKey);
    if (cached && cached.expiresAt > now()) return cached.pending;
    const pending = checked(info.workspace, ['worktree', 'list', '--porcelain', '-z']).then(
      parseWorktrees,
    );
    const entry = { pending, expiresAt: now() + 1000 };
    topologies.set(info.repoKey, entry);
    if (topologies.size > 64) topologies.delete(topologies.keys().next().value);
    pending.catch(() => {
      if (topologies.get(info.repoKey) === entry) topologies.delete(info.repoKey);
    });
    return pending;
  }
  async function probe(workspace) {
    const key = encodeWorkspaceKey(workspace);
    if (probes.has(key)) return probes.get(key);
    const pending = (async () => {
      const info = await repository(workspace);
      if (info.kind !== 'git') return info;
      const worktrees = await topology(info);
      const current = worktrees.find((item) => item.path === workspace.canonicalPath);
      if (current?.bare) return { ...info, worktrees, branch: null, dirty: false, bare: true };
      const [status, branch] = await Promise.all([
        checked(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        command.run({ workspace, args: ['symbolic-ref', '--quiet', '--short', 'HEAD'] }),
      ]);
      requireValue(
        branch.exitCode === 0 || branch.exitCode === 1,
        'git.branch',
        'source_unavailable',
      );
      return {
        ...info,
        worktrees,
        branch: branch.exitCode === 0 ? gitLine(branch.stdout) : null,
        dirty: status.length > 0,
        bare: false,
      };
    })();
    probes.set(key, pending);
    try {
      return await pending;
    } finally {
      probes.delete(key);
    }
  }
  return {
    repository,
    probe,
    checked,
    invalidate(repoKey) {
      topologies.delete(repoKey);
    },
    async diff(workspace) {
      return checked(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--']);
    },
  };
}
