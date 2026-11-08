import type { JsonValue } from '../../capabilities.js';
export interface NativeMessage {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: JsonValue;
}
export interface NativeTransport {
  send(value: string): void;
  subscribe(message: (raw: string) => void, close: () => void): () => void;
  close(): void;
}
export interface AppServerClient {
  request(method: string, params: JsonValue): Promise<JsonValue>;
  notify(method: string, params?: JsonValue): void;
  reply(id: string | number, result: JsonValue): void;
  reject(id: string | number, code: number): void;
  close(): void;
  readonly closed: boolean;
}
export function createAppServerClient(options: {
  readonly transport: NativeTransport;
  readonly onMessage: (message: NativeMessage) => void | Promise<void>;
  readonly onFailure?: (error: Error) => void;
  readonly deadlineMs?: number;
  readonly maxFrameBytes?: number;
}): AppServerClient;
