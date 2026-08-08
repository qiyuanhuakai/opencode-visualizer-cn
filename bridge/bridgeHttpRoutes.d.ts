export type JsonBodyRequest = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'data' | 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
  destroy?(error?: Error): unknown;
};

export function readJsonBody(request: JsonBodyRequest, limit?: number): Promise<unknown>;
