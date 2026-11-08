import type { SessionRef } from '../../identity.js';
import type { JsonValue } from '../../capabilities.js';
export interface CodexEvent {
  readonly type: string;
  readonly session?: SessionRef;
  readonly processGeneration: number;
  readonly epoch: string;
  readonly payload: JsonValue;
}
export function createCodexSubscriptions(): {
  emit(event: CodexEvent): void;
  subscribe(session?: SessionRef): AsyncIterableIterator<CodexEvent>;
  close(): void;
};
