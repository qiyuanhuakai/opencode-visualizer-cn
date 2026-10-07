import type { RuntimeStore, Ack } from '../storage/runtimeStore.js';
export type ImportBinding = Readonly<{ environmentId: string; harnessInstanceId: string; nativeSessionId: string; profileId: string }>;
export type ImportChunk = Readonly<{ sourceKey: string; offset: number; content: string; end: boolean; checksum: string; authority: string; binding: ImportBinding }>;
export type ImportBatch = Readonly<{ importId: string; environmentId: string; sourceRevision: string; offset: number; nextOffset: number; total: number; chunks: readonly ImportChunk[] }>;
export interface ImportService {
  accept(batch: ImportBatch): Promise<Ack>;
  verify(request: Readonly<{ importId: string; sourceRevision: string; expectedRecords: number; expectedChunks: number }>): Promise<Ack>;
}
export function createImportService(options: Readonly<{ store: RuntimeStore; environmentId: string }>): ImportService;
