import type { CanonicalEntry } from './normalize.js';
export function normalizeToolItem(input: {
  readonly type: string;
  readonly item: Readonly<Record<string, unknown>>;
  readonly itemId: string;
  readonly itemTime: number;
  readonly assistantMessageId: string;
  readonly sessionId: string;
}): CanonicalEntry['parts'];
