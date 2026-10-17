import type { HistoryJsonPath } from './historyJsonStream.js';
export type HistoryScalar = string | number | boolean | null;
export type HistoryMetadata = Readonly<Record<string, HistoryScalar>>;
export type HistoryField = Readonly<{ name: string; path: HistoryJsonPath }>;
export type HistoryRecordRule = Readonly<{
  path: readonly (string | '*')[];
  fields: readonly HistoryField[];
  validate(metadata: HistoryMetadata): string;
}>;
export type HistoryGrammar = Readonly<{
  records: readonly HistoryRecordRule[];
  fields: readonly HistoryField[];
  validate(metadata: HistoryMetadata): void;
}>;
export type HistoryDescriptor = Readonly<{ id: string; recordId: string; totalBytes: number; sha256: string; format: 'native-json-utf8' }>;
export type HistoryPage = Readonly<{ id: string; scope: string; document: HistoryDescriptor; records: readonly HistoryDescriptor[] }>;
export type HistoryChunk = Readonly<{ bytes: Uint8Array; offset: number; nextOffset: number | null; release(): void }>;
export type HistoryDiskBudget = Readonly<{ reserve(bytes: number): Readonly<{ resize(bytes: number): boolean; release(): void }> | null; usage(): number }>;
export type HistoryStreamUsage = Readonly<{
  memoryBytes: number; peakMemoryBytes: number; diskBytes: number; reservedDiskBytes: number;
  pages: number; staging: number; fileHandles: number; pendingWrites: number; outputs: number;
}>;
export const HISTORY_STREAM_LIMITS: Readonly<{ chunkBytes: 65536; connectionDiskBytes: 268435456; globalDiskBytes: 536870912; pages: 3; records: 200; metadataBytes: 65536; workingBytes: 8388608 }>;
export function createHistoryDiskBudget(maxBytes?: number): HistoryDiskBudget;
export function createHistoryStream(options: Readonly<{
  scope: string;
  createDirectory(): Promise<string>;
  globalDisk: HistoryDiskBudget;
  secrets?: readonly string[];
  platform?: string;
}>): Readonly<{
  ingest(input: Readonly<{
    source: AsyncIterable<Uint8Array>;
    cancel(): void | Promise<void>;
    grammar: HistoryGrammar;
    signal?: AbortSignal;
    maxBytes?: number;
  }>): Promise<HistoryPage>;
  read(input: Readonly<{ pageId: string; descriptorId: string; offset: number }>): Promise<HistoryChunk>;
  release(pageId: string): Promise<void>;
  usage(): HistoryStreamUsage;
  close(): Promise<void>;
}>;
