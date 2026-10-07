import type { CanonicalEntry } from './normalize.js';
export function codexUserMessageId(turnId: string, index?: string | number): string;
export function codexAssistantMessageId(turnId: string, itemId?: string): string;
export function codexAssistantTextPartId(turnId: string, itemId?: string): string;
export function isRecord(value: unknown): value is Record<string, unknown>;
export function stringValue(value: unknown, fallback?: string): string;
export function numberValue(value: unknown, fallback: number): number;
export function asNumber(value: unknown): number | undefined;
export function wireTimestampMs(value: unknown): number | undefined;
export function codexItemId(item: Readonly<Record<string, unknown>>, fallback: string): string;
export function extractUserText(item: Readonly<Record<string, unknown>>): string;
export function extractUserFiles(item: Readonly<Record<string, unknown>>): readonly {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly mime: string;
}[];
export function commandText(item: Readonly<Record<string, unknown>>): string;
export function toolResultText(value: unknown): string;
export function extractTurnCompletedTime(turn: {
  readonly items?: unknown;
  readonly completedAt?: unknown;
  readonly finishedAt?: unknown;
}): number | undefined;
export function createUserMessage(
  params: Readonly<Record<string, unknown>>,
): CanonicalEntry['info'];
export function createAssistantMessage(
  params: Readonly<Record<string, unknown>>,
): CanonicalEntry['info'];
export function createTextPart(
  params: Readonly<Record<string, unknown>>,
): CanonicalEntry['parts'][number];
export function createToolPart(
  params: Readonly<Record<string, unknown>>,
): CanonicalEntry['parts'][number];
export function createFilePart(
  params: Readonly<Record<string, unknown>>,
): CanonicalEntry['parts'][number];
export function createReasoningPart(
  params: Readonly<Record<string, unknown>>,
): CanonicalEntry['parts'][number];
export function createCompactionPart(
  params: Readonly<Record<string, unknown>>,
): CanonicalEntry['parts'][number];
