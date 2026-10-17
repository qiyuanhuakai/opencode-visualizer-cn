import type { JsonValue } from '../../capabilities.js';
import type { NativeRecord } from './protocol.js';
export interface KimiTranscript {
  readonly items: readonly NativeRecord[];
  readonly tasks: readonly NativeRecord[]; readonly interactions: readonly NativeRecord[];
  readonly attachments: readonly NativeRecord[]; readonly todos: readonly NativeRecord[];
  readonly prompts: readonly NativeRecord[]; readonly agents: readonly NativeRecord[];
  readonly meta: NativeRecord; readonly hasMoreOlder: boolean;
}
export interface KimiTranscriptPage extends KimiTranscript {
  readonly seq: number; readonly cursor: string | null; readonly completeness: 'complete' | 'partial';
}
export function transcriptSnapshot(value: unknown): KimiTranscript;
export function transcriptPage(value: unknown, previousCursor?: string): KimiTranscriptPage;
export function applyTranscriptOps(previous: KimiTranscript, operations: readonly JsonValue[]): KimiTranscript;
export function mergeOlderTranscript(current: KimiTranscript, older: KimiTranscript): KimiTranscript;
