import type { CanonicalEntry, HistoryInput } from './normalize.js';
export function normalizeCodexTurnItems(
  params: Omit<HistoryInput, 'turns'> & {
    readonly turnId: string;
    readonly items: readonly unknown[];
    readonly turnStatus?: string;
    readonly turn?: {
      readonly items?: unknown;
      readonly completedAt?: unknown;
      readonly finishedAt?: unknown;
    };
  },
): {
  readonly messages: readonly CanonicalEntry['info'][];
  readonly parts: CanonicalEntry['parts'];
};
