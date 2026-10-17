import type { JsonValue } from '../../capabilities.js';
export function createSseDecoder(maxBytes?: number): { push(bytes: Uint8Array): readonly JsonValue[]; finish(): void };
export interface EventSubscriptions<T> {
  readonly bufferedBytes: number;
  subscribe(predicate?: (event: T) => boolean): AsyncIterableIterator<T>;
  publish(event: T): void;
  fail(error: Error): void;
  close(): void;
}
export function createEventSubscriptions<T>(options: { readonly maxBytes?: number; readonly onOverflow: (error: Error) => void }): EventSubscriptions<T>;
