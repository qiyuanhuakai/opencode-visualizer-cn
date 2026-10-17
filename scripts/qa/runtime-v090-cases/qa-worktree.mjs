import { execFileSync } from 'node:child_process';

// The final workspace assertion used to REQUIRE the worktree to be dirty
// (`git status --porcelain` non-empty). A case run from a clean checkout
// therefore failed at the last check even though every functional assertion
// passed — and once these files are committed, with the evidence written
// under the ignored .omo tree or outside the repository, the worktree stays
// clean by design. What the case must actually prove is that IT left the
// worktree exactly as it found it: clean stays clean, and pre-existing dirt
// is preserved unchanged.
export function readWorktreeState(root) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
}
export function worktreePreserved(root, before) {
  return readWorktreeState(root) === before;
}
