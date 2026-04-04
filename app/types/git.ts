/**
 * Git-related type definitions shared across components and composables
 */

export type GitStatusCode = '' | 'M' | 'A' | 'D' | 'R' | 'C' | '?';

export type GitFileStatus = {
  path: string;
  index: GitStatusCode;
  worktree: GitStatusCode;
  origPath?: string;
};

export type GitBranchInfo = {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  headShort?: string;
};

export type GitDiffStatsEntry = {
  additions: number;
  deletions: number;
};

export type GitDiffStats = {
  staged: GitDiffStatsEntry;
  unstaged: GitDiffStatsEntry;
};

export type GitStatus = {
  branch: GitBranchInfo;
  files: GitFileStatus[];
  diffStats: GitDiffStats;
};

export type BranchEntry = {
  refname: string;
  refnameShort: string;
  displayName: string;
  hash: string;
  subject: string;
  isCurrent: boolean;
  isWorktree: boolean;
  isLocal: boolean;
  remote: string;
  upstream: string;
  hasLocalCounterpart: boolean;
};
