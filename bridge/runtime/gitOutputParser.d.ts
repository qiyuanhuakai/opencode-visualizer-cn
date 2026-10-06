export interface GitWorktree {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked?: string;
  readonly prunable?: string;
}
export function parseWorktrees(output: string, maxBytes?: number): readonly GitWorktree[];
export function gitLine(output: string): string;
