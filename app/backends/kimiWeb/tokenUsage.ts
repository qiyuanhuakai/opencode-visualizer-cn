/**
 * Kimi Web token-usage mapping for the shared Status Monitor token tab.
 *
 * The authoritative live source is the Todo 14 message bridge: `agent.status.updated`
 * writes `usage` / `contextTokens` / `maxContextTokens` into the per-session state
 * (`useKimiWebMessageBridge().sessionState(sessionId)`). The normalizer's message
 * tokens (`parts.ts buildMessage`) are only a snapshot taken when a turn group
 * opens, so the bridge state — not the message store — drives this surface.
 *
 * Wire shape (kimi, `backends/kimiWeb/wire.ts`):
 *   usage.total.{inputOther, output, inputCacheRead, inputCacheCreation}
 *   contextTokens / maxContextTokens
 * Display shape (`types/message.ts` MessageUsage/MessageTokens):
 *   tokens.{input, output, reasoning, total, cache.{read, write}}
 */

import type { MessageUsage } from '../../types/message';
import type { KimiWebUsageReport } from './wire';

export type KimiWebTokenUsage = {
  /** Display-ready usage for the shared token rows. */
  usage: MessageUsage;
  /** Current context occupancy (`contextTokens`); drives the progress bar. */
  contextUsed: number;
  /** Model context limit (`maxContextTokens`); 0 when the server omits it. */
  contextLimit: number;
};

/** Wire numbers may be absent; NaN/Infinity/negatives must never reach the UI. */
function finiteOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function kimiWebTokenUsageFromReport(
  usage: KimiWebUsageReport | undefined,
  contextTokens?: number,
  maxContextTokens?: number,
): KimiWebTokenUsage | null {
  const total = usage?.total;
  // Only the cumulative session total feeds the rows; byModel/currentTurn are
  // breakdowns of the same numbers and would double-count if merged.
  if (!total) return null;

  const input = finiteOrZero(total.inputOther);
  const output = finiteOrZero(total.output);
  const cacheRead = finiteOrZero(total.inputCacheRead);
  const cacheWrite = finiteOrZero(total.inputCacheCreation);

  return {
    usage: {
      tokens: {
        input,
        output,
        // Kimi Web reports no separate reasoning-token count — thinking deltas
        // are text, not tokens. 0 is the truthful value, not a missing mapping.
        reasoning: 0,
        total: input + output + cacheRead + cacheWrite,
        cache: { read: cacheRead, write: cacheWrite },
      },
    },
    contextUsed: finiteOrZero(contextTokens),
    contextLimit: finiteOrZero(maxContextTokens),
  };
}

/**
 * Context-only mapping for the Todo 23 REST fallback: the session status
 * endpoint reports no token counts, so the zeros are placeholders the caller
 * must suppress (tokenUsageContextOnly) instead of rendering as real values.
 */
export function kimiWebContextOnlyUsage(
  contextTokens?: number,
  maxContextTokens?: number,
): KimiWebTokenUsage {
  return {
    usage: { tokens: { input: 0, output: 0, reasoning: 0, total: 0 } },
    contextUsed: finiteOrZero(contextTokens),
    contextLimit: finiteOrZero(maxContextTokens),
  };
}
