export type HistoryJsonPath = readonly (string | number)[];
export type HistoryJsonToken =
  | Readonly<{ kind: 'start' | 'end'; container: 'object' | 'array'; path: HistoryJsonPath; raw: Uint8Array }>
  | Readonly<{ kind: 'key'; path: HistoryJsonPath; value: string; raw: Uint8Array }>
  | Readonly<{ kind: 'string-start' | 'string-end'; path: HistoryJsonPath; raw: Uint8Array }>
  | Readonly<{ kind: 'string-data'; path: HistoryJsonPath; text: string; raw: Uint8Array }>
  | Readonly<{ kind: 'scalar'; path: HistoryJsonPath; value: number | boolean | null; raw: Uint8Array }>
  | Readonly<{ kind: 'syntax'; path: HistoryJsonPath; raw: Uint8Array }>;
export const HISTORY_JSON_LIMITS: Readonly<{ inputBytes: 65536; tokenBytes: 16384; depth: 64; keyBytes: 4096; activeKeyBytes: 65536; numberBytes: 128; objectKeys: 1024 }>;
export function tokenizeHistoryJson(source: AsyncIterable<Uint8Array>, options?: Readonly<{ signal?: AbortSignal }>): AsyncGenerator<HistoryJsonToken>;
