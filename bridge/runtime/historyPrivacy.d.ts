import type { HistoryJsonToken } from './historyJsonStream.js';
export const HISTORY_PRIVACY_LIMITS: Readonly<{ secretCount: 32; secretUnits: 4096; urlUnits: 65536 }>;
export function redactHistoryJson(tokens: AsyncIterable<HistoryJsonToken>, options?: Readonly<{ secrets?: readonly string[]; signal?: AbortSignal }>): AsyncGenerator<HistoryJsonToken>;
