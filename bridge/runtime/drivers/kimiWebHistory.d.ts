import type { KimiWebTransport } from './kimiWebTransport.js';
import type { KimiCursor, KimiFrame, NativeRecord } from '../../../shared/runtime/native/kimiWeb/protocol.js';
import type { KimiTranscript } from '../../../shared/runtime/native/kimiWeb/transcript.js';
export interface KimiHistoryPage {
  readonly agentId: string; readonly items: readonly NativeRecord[];
  readonly tasks: readonly NativeRecord[]; readonly interactions: readonly NativeRecord[]; readonly agents: readonly NativeRecord[];
  readonly metadata: NativeRecord; readonly cursor: string | null; readonly completeness: 'complete' | 'partial';
  readonly transcriptSeq: number; readonly durableCursor: KimiCursor | null;
}
export interface KimiWebHistory {
  selected(sessionId: string, agentId?: string): unknown;
  receive(frame: KimiFrame, connection: number): boolean;
  read(sessionId: string, options?: { readonly agentId?: string; readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<KimiHistoryPage>;
  recover(sessionId: string): Promise<{ readonly cursor: KimiCursor; readonly recovered: true }>;
  cursor(sessionId: string): KimiCursor | undefined;
  transcriptCursors(sessionId: string): Readonly<Record<string, number>>;
  inspect(sessionId: string, agentId?: string): { readonly cursor: KimiCursor | null; readonly transcriptSeq: number | null; readonly snapshot: KimiTranscript; readonly recovering: boolean };
  clear(): void;
}
export function createKimiWebHistory(options: { readonly transport: KimiWebTransport; readonly onRecovered?: (sessionId: string, value: { readonly cursor: KimiCursor; readonly buffered: number }) => void }): KimiWebHistory;
