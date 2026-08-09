export type JsonBodyRequest = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'data' | 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
  pause?(): unknown;
};

export class JsonBodyTooLargeError extends Error {}
export function jsonBodyErrorStatus(error: unknown, fallbackStatus: number): number;
export function readJsonBody(request: JsonBodyRequest, limit?: number): Promise<unknown>;
export function handlePtyHttpRequest(
  request: JsonBodyRequest & { readonly method?: string },
  response: {
    writeHead(statusCode: number, headers?: Record<string, string>): unknown;
    end(body?: string): unknown;
  },
  requestUrl: URL,
  manager: {
    list(): unknown;
    create(payload: unknown): unknown;
    resize(id: string, rows: unknown, cols: unknown): boolean;
    remove(id: string): boolean;
  },
): Promise<boolean>;
