import { encodeWorkspaceKey } from '../../shared/runtime/identity.js';
import { requireValue } from '../../shared/runtime/capabilities.js';
import { createRepositoryOperation } from './repositoryOperation.js';
import { GitCommandError } from './targetGitCommand.js';
import { gitLine } from './gitOutputParser.js';

export function createWorktreeService({ command, git, store, assertCurrent }) {
  const journal = createRepositoryOperation({ store, assertCurrent });
  const running = new Map();
  async function launch(accepted, request, retainWorkspace, authorizeDestination) {
    const job = await journal.launch(accepted.operationId, async () => {
      await authorizeDestination();
      return command.start(request);
    });
    const completion = (async () => {
      try {
        await journal.observed(accepted.operationId);
        const result = await job.wait();
        if (result.exitCode !== 0) {
          // A failed create can leave a partially populated path. Keep it leased for explicit reconciliation.
          if (retainWorkspace) await journal.reconcile(accepted.operationId);
          else await journal.terminal(accepted.operationId, 'failed');
          throw new GitCommandError('exit', result);
        }
        const terminal = await journal.terminal(accepted.operationId, 'completed', retainWorkspace);
        git.invalidate(terminal.repoKey);
        return terminal;
      } catch (error) {
        const operation = await journal.get(accepted.operationId);
        if (operation.phase !== 'terminal') await journal.reconcile(accepted.operationId);
        throw error;
      }
    })().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    running.set(accepted.operationId, { job, completion });
    return accepted;
  }
  return {
    journal,
    leases: journal.leases,
    async create({ workspace, parent, name, idempotencyKey }) {
      const info = await git.repository(workspace);
      requireValue(info.kind === 'git', 'git.repository');
      const destination = await command.destination(parent, name);
      const baseCommit = gitLine(await git.checked(workspace, ['rev-parse', '--verify', 'HEAD']));
      requireValue(/^[0-9a-f]{40,64}$/.test(baseCommit), 'git.base_commit');
      const accepted = await journal.accept({
        repoKey: info.repoKey,
        workspace: destination,
        idempotencyKey,
        method: 'worktree.create',
        payload: { source: workspace, destination },
        baseCommit,
      });
      return launch(
        accepted,
        {
          workspace,
          mutation: true,
          args: ['worktree', 'add', '--detach', '--', destination.canonicalPath, baseCommit],
        },
        true,
        () => command.destination(parent, name),
      );
    },
    async remove({ workspace, worktree, idempotencyKey }) {
      const [info, selected] = await Promise.all([git.repository(workspace), git.probe(worktree)]);
      requireValue(
        info.kind === 'git' && selected.kind === 'git' && info.repoKey === selected.repoKey,
        'git.repository',
        'unauthorized',
      );
      requireValue(!selected.dirty, 'git.dirty', 'conflict');
      requireValue(!selected.bare, 'git.bare', 'conflict');
      await command.authorize(worktree, 'write');
      const entry = selected.worktrees.find((item) => item.path === worktree.canonicalPath);
      requireValue(
        entry && entry.locked === undefined && entry.prunable === undefined,
        'git.locked_or_prunable',
        'conflict',
      );
      const accepted = await journal.accept({
        repoKey: info.repoKey,
        workspace: worktree,
        idempotencyKey,
        method: 'worktree.remove',
        payload: { source: workspace, worktree },
        baseCommit: entry.head,
      });
      try {
        requireValue(
          (
            await git.checked(worktree, [
              'status',
              '--porcelain=v1',
              '-z',
              '--untracked-files=all',
              '--ignored=matching',
            ])
          ).length === 0,
          'git.dirty',
          'conflict',
        );
      } catch (error) {
        await journal.terminal(accepted.operationId, 'failed');
        throw error;
      }
      return launch(
        accepted,
        { workspace, mutation: true, args: ['worktree', 'remove', '--', worktree.canonicalPath] },
        false,
        () => command.authorize(worktree, 'write'),
      );
    },
    async wait(id) {
      const active = running.get(id);
      if (active) {
        try {
          const result = await active.completion;
          if (result.error) throw result.error;
          return result.value;
        } finally {
          running.delete(id);
        }
      }
      const operation = await journal.get(id);
      requireValue(operation.phase === 'terminal', 'git.reconcile', 'reconcile_required');
      return operation;
    },
    async cancel(id) {
      const active = running.get(id);
      requireValue(active, 'git.reconcile', 'reconcile_required');
      await active.job.cancel();
      const result = await active.completion;
      if (result.error && !(result.error instanceof GitCommandError)) throw result.error;
      return journal.get(id);
    },
    async releaseWriter(workspace, owner) {
      await journal.leases.release(encodeWorkspaceKey(workspace), owner);
    },
    async close() {
      await Promise.all([...running.keys()].map((id) => this.cancel(id)));
      running.clear();
    },
  };
}
