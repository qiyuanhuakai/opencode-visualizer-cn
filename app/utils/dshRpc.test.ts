import { describe, expect, it, vi } from 'vitest';

import {
  DshMissingCredentialError,
  DshRemoteRpcError,
  DshRpcError,
  DshRpcForbiddenError,
  DshRpcHttpError,
  DshRpcNetworkError,
  DshRpcNotFoundError,
  DshRpcPayloadTooLargeError,
  DshRpcUnauthorizedError,
  DshRpcUnsupportedMediaTypeError,
  DshWireParseError,
  buildDshClientRequest,
  buildDshRpcUrl,
  classifyDshHttpStatusError,
  classifyDshRemoteError,
  createDshRpcClient,
  deriveDshBridgeHttpUrl,
  parseDshMultipartResponse,
  parseDshServerResponseText,
  parseDshServerResponseValue,
  unwrapDshMultipartResponse,
  unwrapDshServerResponse,
  type DshRpcCallOptions,
} from './dshRpc';

/**
 * Synthetic-fixture unit tests for the dsh RPC envelope client (Todo 4).
 *
 * Wire anchors (docs/dsh.md §5, dsh@0.2.0-rc.2):
 *   - request: POST <bridge>/<ns>/<method>, client-request envelope,
 *     payload always `{ args: { ... } }`, method echoes the URL path.
 *   - response: server-response with result.ok true/false; stable remote
 *     error codes (`gateway/input-invalid`, `gateway/signature-invalid`, …).
 *   - 415 (bad content-type), 400 (non-JSON body), 413 (>300 MiB),
 *     404 (non-POST / unknown route), 401/403 (bridge auth fence).
 *   - Uint8Array results ride a multipart/form-data body (metadata part =
 *     envelope JSON, remaining parts = raw bytes).
 *
 * No live endpoint is contacted anywhere in this file: every response is a
 * hand-built fixture, and the multipart fixtures are synthetic (the real
 * multipart endpoint has not been probed — see the dshRpc.ts module comment).
 */

const BASE = 'http://localhost:23004/dsh';
const TOKEN = 'bridge-token-abc123';
const BOUNDARY = 'dsh-test-boundary';

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function jsonResponse(body: unknown, status = 200, contentType = 'application/json') {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: vi.fn(async () => text),
    arrayBuffer: vi.fn(async () => new TextEncoder().encode(text).buffer),
  } as unknown as Response;
}

function textResponse(text: string, status = 200, contentType = 'text/html') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: vi.fn(async () => text),
    arrayBuffer: vi.fn(async () => new TextEncoder().encode(text).buffer),
  } as unknown as Response;
}

function bytesResponse(bytes: Uint8Array, contentType: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    text: vi.fn(async () => ''),
    arrayBuffer: vi.fn(async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ),
  } as unknown as Response;
}

function okEnvelope(value: unknown, rpcId = 'dsh-1') {
  return { type: 'server-response', rpcId, result: { ok: true, value } };
}

function remoteErrorEnvelope(
  code: string,
  message: string,
  rpcId = 'dsh-1',
  details?: unknown,
) {
  return {
    type: 'server-response',
    rpcId,
    result: {
      ok: false,
      error:
        details === undefined ? { code, message } : { code, message, details },
    },
  };
}

function multipartContentType() {
  return `multipart/form-data; boundary=${BOUNDARY}`;
}

function encodeMultipart(
  parts: ReadonlyArray<{ name: string; body: Uint8Array | string }>,
  options: { closingBoundary?: boolean } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(
      encoder.encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`),
    );
    chunks.push(typeof part.body === 'string' ? encoder.encode(part.body) : part.body);
    chunks.push(encoder.encode('\r\n'));
  }
  if (options.closingBoundary !== false) {
    chunks.push(encoder.encode(`--${BOUNDARY}--\r\n`));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

function captureFetcher(response: Response | (() => Response)) {
  const captured: CapturedRequest[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    captured.push({
      url,
      method: init.method ?? '',
      headers: init.headers as Record<string, string>,
      body: String(init.body ?? ''),
    });
    return typeof response === 'function' ? response() : response;
  });
  return { captured, fetcher };
}

function createClient(
  response: Response | (() => Response),
  token: string | null | undefined = TOKEN,
) {
  const harness = captureFetcher(response);
  const client = createDshRpcClient({
    baseUrl: BASE,
    getBridgeToken: token === null ? undefined : async () => token,
    fetcher: harness.fetcher as never,
  });
  return { client, ...harness };
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

async function catchErrorAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('deriveDshBridgeHttpUrl', () => {
  it('derives the bridge HTTP prefix from the default dsh bridge WS url', () => {
    expect(deriveDshBridgeHttpUrl('ws://localhost:23004/dsh/ws')).toBe('http://localhost:23004/dsh');
  });

  it('maps wss to https and drops a query token', () => {
    expect(deriveDshBridgeHttpUrl('wss://bridge.example:8443/dsh/ws?token=xyz')).toBe(
      'https://bridge.example:8443/dsh',
    );
  });

  it('tolerates a missing /ws suffix and trailing slashes', () => {
    expect(deriveDshBridgeHttpUrl('ws://localhost:23004/dsh')).toBe('http://localhost:23004/dsh');
    expect(deriveDshBridgeHttpUrl('ws://localhost:23004/dsh/ws/')).toBe('http://localhost:23004/dsh');
  });

  it('rejects non-ws schemes and embedded credentials', () => {
    for (const input of ['http://localhost:23004/dsh/ws', 'ws://user:pass@localhost:23004/dsh/ws']) {
      const error = catchError(() => deriveDshBridgeHttpUrl(input));
      expect(error).toBeInstanceOf(DshRpcError);
      expect((error as DshRpcError).code).toBe('invalid-bridge-url');
    }
  });
});

describe('buildDshRpcUrl', () => {
  it('joins baseUrl with namespace/method without an /api prefix', () => {
    expect(buildDshRpcUrl(BASE, 'session', 'list')).toBe('http://localhost:23004/dsh/session/list');
  });

  it('trims trailing slashes on the base', () => {
    expect(buildDshRpcUrl('http://localhost:23004/dsh/', 'session', 'get')).toBe(
      'http://localhost:23004/dsh/session/get',
    );
  });

  it('keeps the $events namespace literal (%24events is a live-probed 404)', () => {
    expect(buildDshRpcUrl(BASE, '$events', 'result')).toBe(
      'http://localhost:23004/dsh/$events/result',
    );
  });

  it('rejects empty bases, empty segments and path traversal', () => {
    const cases: Array<[string, string, string, string]> = [
      ['', 'session', 'list', 'invalid-base-url'],
      ['   ', 'session', 'list', 'invalid-base-url'],
      ['ws://localhost:23004/dsh', 'session', 'list', 'invalid-base-url'],
      [BASE, '', 'list', 'invalid-method-path'],
      [BASE, 'session', '', 'invalid-method-path'],
      [BASE, '..', 'list', 'invalid-method-path'],
      [BASE, 'session', '../etc', 'invalid-method-path'],
      [BASE, 'session', 'a b', 'invalid-method-path'],
      [BASE, 'session', 'a/b', 'invalid-method-path'],
    ];
    for (const [baseUrl, namespace, method, code] of cases) {
      const error = catchError(() => buildDshRpcUrl(baseUrl, namespace, method));
      expect(error).toBeInstanceOf(DshRpcError);
      expect((error as DshRpcError).code).toBe(code);
    }
  });
});

describe('buildDshClientRequest', () => {
  it('wraps args and echoes the URL path as the method', () => {
    const request = buildDshClientRequest('session/list', { workspaceId: 'w1' }, 'rpc-9');
    expect(request).toEqual({
      type: 'client-request',
      rpcId: 'rpc-9',
      method: 'session/list',
      payload: { args: { workspaceId: 'w1' } },
    });
  });

  it('always ships an args wrapper, even when empty', () => {
    expect(buildDshClientRequest('session/list', {}, 'rpc-1').payload).toEqual({ args: {} });
  });

  it('rejects a blank rpcId and non-JSON arg values instead of sending them', () => {
    for (const bad of ['', '   ']) {
      const error = catchError(() =>
        buildDshClientRequest('session/list', { ok: true }, bad),
      );
      expect(error).toBeInstanceOf(DshRpcError);
      expect((error as DshRpcError).code).toBe('invalid-envelope');
    }
    const error = catchError(() =>
      buildDshClientRequest('session/list', { fn: (() => 1) as never }, 'rpc-1'),
    );
    expect(error).toBeInstanceOf(DshRpcError);
    expect((error as DshRpcError).code).toBe('invalid-envelope');
  });
});

describe('parseDshServerResponseValue / Text', () => {
  it('parses a valid envelope from text and enforces the rpcId echo', () => {
    const response = parseDshServerResponseText(JSON.stringify(okEnvelope({ a: 1 }, 'rpc-1')), 'rpc-1');
    expect(unwrapDshServerResponse(response)).toEqual({ a: 1 });
    const mismatch = catchError(() =>
      parseDshServerResponseText(JSON.stringify(okEnvelope({ a: 1 }, 'other')), 'rpc-1'),
    );
    expect(mismatch).toBeInstanceOf(DshWireParseError);
    expect((mismatch as DshWireParseError).kind).toBe('bad-value');
  });

  it('rejects empty and non-JSON bodies with a not-json classification', () => {
    for (const text of ['', '   ', '<html>oops</html>']) {
      const error = catchError(() => parseDshServerResponseText(text, 'rpc-1'));
      expect(error).toBeInstanceOf(DshWireParseError);
      expect((error as DshWireParseError).kind).toBe('not-json');
    }
  });

  it('rejects garbage envelopes and the wrong ok arm with bad-value', () => {
    const garbage = [
      { type: 'server-frame', rpcId: 'rpc-1' },
      { type: 'server-response', rpcId: '' },
      { type: 'server-response', rpcId: 'rpc-1', result: { ok: 'yes', value: 1 } },
      { type: 'server-response', rpcId: 'rpc-1', result: { ok: false } },
      { type: 'server-response', rpcId: 'rpc-1', result: { ok: false, error: { message: 'x' } } },
      null,
      [1, 2],
    ];
    for (const value of garbage) {
      const error = catchError(() => parseDshServerResponseValue(value, 'rpc-1'));
      expect(error).toBeInstanceOf(DshWireParseError);
      expect((error as DshWireParseError).kind).toBe('bad-value');
    }
  });

  it('throws a classified remote error for ok:false instead of returning', () => {
    const error = catchError(() =>
      unwrapDshServerResponse(
        parseDshServerResponseValue(remoteErrorEnvelope('gateway/internal', 'boom'), 'dsh-1'),
      ),
    );
    expect(error).toBeInstanceOf(DshRemoteRpcError);
    expect((error as DshRemoteRpcError).code).toBe('gateway/internal');
    expect((error as DshRemoteRpcError).message).toContain('boom');
  });
});

describe('classifyDshRemoteError', () => {
  it('maps MISSING_CREDENTIAL to its own class and keeps other codes verbatim', () => {
    const missing = classifyDshRemoteError(
      { code: 'MISSING_CREDENTIAL', message: 'no credential' },
      'rpc-1',
    );
    expect(missing).toBeInstanceOf(DshMissingCredentialError);
    expect(missing).toBeInstanceOf(DshRemoteRpcError);
    expect(missing.code).toBe('MISSING_CREDENTIAL');
    expect(missing.rpcId).toBe('rpc-1');

    for (const code of ['gateway/input-invalid', 'gateway/signature-invalid', 'gateway/bad-request']) {
      const classified = classifyDshRemoteError({ code, message: 'nope' }, 'rpc-2');
      expect(classified).toBeInstanceOf(DshRemoteRpcError);
      expect(classified).not.toBeInstanceOf(DshMissingCredentialError);
      expect(classified.code).toBe(code);
    }
  });

  it('carries remote details on the typed error', () => {
    const details = { endpoint: 'session/list', missing: ['_request'] };
    const classified = classifyDshRemoteError(
      { code: 'gateway/arguments-invalid', message: 'args mismatch', details },
      'rpc-3',
    );
    expect(classified.details).toEqual(details);
  });
});

describe('classifyDshHttpStatusError', () => {
  it('maps each documented status to its own typed class', () => {
    const cases: Array<[number, abstract new (...args: never[]) => DshRpcHttpError, string]> = [
      [401, DshRpcUnauthorizedError, 'http-401'],
      [403, DshRpcForbiddenError, 'http-403'],
      [404, DshRpcNotFoundError, 'http-404'],
      [413, DshRpcPayloadTooLargeError, 'http-413'],
      [415, DshRpcUnsupportedMediaTypeError, 'http-415'],
    ];
    for (const [status, ctor, code] of cases) {
      const error = classifyDshHttpStatusError(status, { method: 'session/list', rpcId: 'rpc-1' });
      expect(error).toBeInstanceOf(ctor);
      expect(error).toBeInstanceOf(DshRpcHttpError);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    }
  });

  it('falls back to a generic http error for unmapped statuses', () => {
    const error = classifyDshHttpStatusError(500, { method: 'session/list', rpcId: 'rpc-1' });
    expect(error).toBeInstanceOf(DshRpcHttpError);
    expect(error).not.toBeInstanceOf(DshRpcUnauthorizedError);
    expect(error.code).toBe('http-error');
    expect(error.status).toBe(500);
  });

  it('is never classified as a business or network error', () => {
    const error = classifyDshHttpStatusError(401, { method: 'session/list', rpcId: 'rpc-1' });
    expect(error).not.toBeInstanceOf(DshRemoteRpcError);
    expect(error).not.toBeInstanceOf(DshRpcNetworkError);
  });
});

describe('createDshRpcClient — unary happy path', () => {
  it('posts the envelope to <bridge>/<ns>/<method> with the bridge token header', async () => {
    const { client, captured, fetcher } = createClient(
      jsonResponse(okEnvelope({ sessions: [] })),
    );
    const value = await client.call('session', 'list', { workspaceId: 'w1' });
    expect(value).toEqual({ sessions: [] });

    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.url).toBe('http://localhost:23004/dsh/session/list');
    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // Frontend must never carry dsh cookies or an Origin fence of its own.
    expect(Object.keys(request.headers).sort()).toEqual(['Authorization', 'content-type']);
    expect(JSON.parse(request.body)).toEqual({
      type: 'client-request',
      rpcId: 'dsh-1',
      method: 'session/list',
      payload: { args: { workspaceId: 'w1' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('omits the Authorization header when no bridge token is configured', async () => {
    const { client, captured } = createClient(jsonResponse(okEnvelope(null)), null);
    await client.call('session', 'list');
    expect(captured[0]!.headers.Authorization).toBeUndefined();
    expect(Object.keys(captured[0]!.headers)).toEqual(['content-type']);
  });

  it('auto-increments rpcId monotonically and keeps clients isolated', async () => {
    const responses = [jsonResponse(okEnvelope(1, 'dsh-1')), jsonResponse(okEnvelope(2, 'dsh-2'))];
    let index = 0;
    const { client, captured } = createClient(() => responses[index++]!);
    await client.call('session', 'list');
    await client.call('session', 'list');
    expect(JSON.parse(captured[0]!.body).rpcId).toBe('dsh-1');
    expect(JSON.parse(captured[1]!.body).rpcId).toBe('dsh-2');
    expect(client.nextRpcId()).toBe('dsh-3');

    const other = createClient(jsonResponse(okEnvelope(1)));
    await other.client.call('session', 'list');
    expect(JSON.parse(other.captured[0]!.body).rpcId).toBe('dsh-1');
  });

  it('honors an explicit rpcId (prompt binding) over auto-increment', async () => {
    const responses = [
      jsonResponse(okEnvelope('ok', 'prompt-request-42')),
      jsonResponse(okEnvelope('ok2')),
    ];
    let index = 0;
    const { client, captured } = createClient(() => responses[index++]!);
    const options: DshRpcCallOptions = { rpcId: 'prompt-request-42' };
    await client.call('session', 'prompt', { requestId: 'prompt-request-42' }, options);
    await client.call('session', 'list');
    expect(JSON.parse(captured[0]!.body).rpcId).toBe('prompt-request-42');
    // stale_state guard: an explicit id must not advance the shared counter.
    expect(JSON.parse(captured[1]!.body).rpcId).toBe('dsh-1');
  });

  it('rejects an rpcId echo that does not match the request', async () => {
    const { client } = createClient(jsonResponse(okEnvelope({ a: 1 }, 'stale-rpc')), null);
    const error = await catchErrorAsync(() => client.call('session', 'list'));
    expect(error).toBeInstanceOf(DshWireParseError);
    expect((error as DshWireParseError).kind).toBe('bad-value');
    expect((error as Error).message).toContain('rpcId echo mismatch');
  });
});

describe('createDshRpcClient — business errors are not network errors', () => {
  it('classifies gateway/input-invalid, gateway/signature-invalid and MISSING_CREDENTIAL', async () => {
    const cases: Array<[string, unknown]> = [
      ['gateway/input-invalid', DshRemoteRpcError],
      ['gateway/signature-invalid', DshRemoteRpcError],
      ['MISSING_CREDENTIAL', DshMissingCredentialError],
    ];
    for (const [code, ctor] of cases) {
      const { client } = createClient(
        jsonResponse(remoteErrorEnvelope(code, `remote said ${code}`, 'dsh-1', { hint: 1 })),
        null,
      );
      const error = await catchErrorAsync(() => client.call('session', 'list'));
      expect(error).toBeInstanceOf(ctor);
      expect(error).toBeInstanceOf(DshRemoteRpcError);
      expect(error).not.toBeInstanceOf(DshRpcHttpError);
      expect(error).not.toBeInstanceOf(DshRpcNetworkError);
      expect((error as DshRemoteRpcError).code).toBe(code);
      expect((error as DshRemoteRpcError).rpcId).toBe('dsh-1');
      expect((error as Error).message).toContain(`remote said ${code}`);
    }
  });

  it('surfaces the arguments-invalid debugging details', async () => {
    const details = { endpoint: 'session/list', missing: ['_request'] };
    const { client } = createClient(
      jsonResponse(
        remoteErrorEnvelope(
          'gateway/arguments-invalid',
          'typert gateway: session/list: args fields do not match the descriptor: missing "_request"',
          'dsh-1',
          details,
        ),
      ),
      null,
    );
    const error = await catchErrorAsync(() => client.call('session', 'list'));
    expect(error).toBeInstanceOf(DshRemoteRpcError);
    expect((error as DshRemoteRpcError).details).toEqual(details);
  });
});

describe('createDshRpcClient — HTTP status classification', () => {
  it('throws HTTP 401 immediately without retrying', async () => {
    const { client, fetcher } = createClient(textResponse('unauthorized', 401, 'text/plain'), null);
    const error = await catchErrorAsync(() => client.call('session', 'list'));
    expect(error).toBeInstanceOf(DshRpcUnauthorizedError);
    expect((error as DshRpcError).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('classifies 403/404/413/415 and unmapped statuses', async () => {
    const cases: Array<[number, abstract new (...args: never[]) => DshRpcHttpError, string]> = [
      [403, DshRpcForbiddenError, 'http-403'],
      [404, DshRpcNotFoundError, 'http-404'],
      [413, DshRpcPayloadTooLargeError, 'http-413'],
      [415, DshRpcUnsupportedMediaTypeError, 'http-415'],
      [500, DshRpcHttpError, 'http-error'],
    ];
    for (const [status, ctor, code] of cases) {
      const { client, fetcher } = createClient(
        textResponse(`status ${status}`, status, 'text/plain'),
        null,
      );
      const error = await catchErrorAsync(() => client.call('session', 'list'));
      expect(error).toBeInstanceOf(ctor);
      expect((error as DshRpcError).code).toBe(code);
      expect((error as DshRpcError).status).toBe(status);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});

describe('createDshRpcClient — malformed bodies', () => {
  it('rejects an empty body', async () => {
    const { client } = createClient(textResponse('', 200, 'application/json'), null);
    const error = await catchErrorAsync(() => client.call('session', 'list'));
    expect(error).toBeInstanceOf(DshWireParseError);
    expect((error as DshWireParseError).kind).toBe('not-json');
  });

  it('rejects a non-JSON body even when the content-type lies', async () => {
    const { client } = createClient(textResponse('<html>bridge error</html>', 200, 'text/html'), null);
    const error = await catchErrorAsync(() => client.call('session', 'list'));
    expect(error).toBeInstanceOf(DshWireParseError);
    expect((error as DshWireParseError).kind).toBe('not-json');
  });

  it('tolerates a mislabeled content-type when the envelope itself is valid', async () => {
    const { client } = createClient(textResponse(JSON.stringify(okEnvelope({ v: 7 })), 200, 'text/plain'), null);
    await expect(client.call('session', 'list')).resolves.toEqual({ v: 7 });
  });

  it('rejects a garbage envelope shape', async () => {
    const { client } = createClient(jsonResponse({ type: 'server-frame', rpcId: 'rpc-1' }), null);
    const error = await catchErrorAsync(() => client.call('session', 'list'));
    expect(error).toBeInstanceOf(DshWireParseError);
    expect((error as DshWireParseError).kind).toBe('bad-value');
  });
});

describe('createDshRpcClient — transport failures', () => {
  it('wraps a fetch rejection as a network error that keeps the cause', async () => {
    const cause = new Error('ECONNREFUSED 127.0.0.1:23004');
    const fetcher = vi.fn(async () => {
      throw cause;
    });
    const client = createDshRpcClient({ baseUrl: BASE, fetcher: fetcher as never });
    const error = await catchErrorAsync(() => client.call('session', 'list'));
    expect(error).toBeInstanceOf(DshRpcNetworkError);
    expect((error as DshRpcError).code).toBe('network-failure');
    expect((error as DshRpcNetworkError).cause).toBe(cause);
    expect((error as Error).message).toContain('session/list');
  });

  it('never leaks the bridge token into any error surface', async () => {
    const rejectingFetcher = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const networkClient = createDshRpcClient({
      baseUrl: BASE,
      getBridgeToken: async () => TOKEN,
      fetcher: rejectingFetcher as never,
    });
    const surfaces: unknown[] = [
      await catchErrorAsync(() =>
        createClient(textResponse('unauthorized', 401, 'text/plain')).client.call('session', 'list'),
      ),
      await catchErrorAsync(() =>
        createClient(jsonResponse(remoteErrorEnvelope('MISSING_CREDENTIAL', 'denied'))).client.call(
          'session',
          'list',
        ),
      ),
      await catchErrorAsync(() => networkClient.call('session', 'list')),
      catchError(() => deriveDshBridgeHttpUrl('http://localhost:23004/dsh/ws')),
      catchError(() => buildDshRpcUrl('', 'session', 'list')),
    ];
    for (const error of surfaces) {
      expect(error).toBeInstanceOf(Error);
      const rendered = `${(error as Error).message} ${String(error)} ${JSON.stringify(error)}`;
      expect(rendered).not.toContain(TOKEN);
    }
  });
});

describe('parseDshMultipartResponse', () => {
  const metadataEnvelope = {
    type: 'server-response',
    rpcId: 'rpc-1',
    result: {
      ok: true,
      value: {
        attachments: [
          { path: 'blob', codec: 'bytes', part: 'bytes-1' },
          { path: 'blob2', codec: 'bytes', part: 'bytes-2' },
        ],
      },
    },
  };

  it('splits the metadata envelope from ordered byte parts', () => {
    const first = new Uint8Array([0, 1, 2, 255]);
    const second = new Uint8Array([253, 254]);
    const body = encodeMultipart([
      { name: 'metadata', body: JSON.stringify(metadataEnvelope) },
      { name: 'bytes-1', body: first },
      { name: 'bytes-2', body: second },
    ]);
    const parsed = parseDshMultipartResponse(multipartContentType(), body);
    expect(parsed.metadata).toEqual(metadataEnvelope);
    expect(parsed.bytes).toHaveLength(2);
    expect(Array.from(parsed.bytes[0]!)).toEqual(Array.from(first));
    expect(Array.from(parsed.bytes[1]!)).toEqual(Array.from(second));
  });

  it('unwraps the metadata envelope to the ok value', () => {
    const body = encodeMultipart([
      { name: 'metadata', body: JSON.stringify(metadataEnvelope) },
      { name: 'bytes-1', body: new Uint8Array([1]) },
    ]);
    const parsed = parseDshMultipartResponse(multipartContentType(), body);
    expect(unwrapDshMultipartResponse(parsed, 'rpc-1')).toEqual(metadataEnvelope.result.value);
    const mismatch = catchError(() => unwrapDshMultipartResponse(parsed, 'other-rpc'));
    expect(mismatch).toBeInstanceOf(DshWireParseError);
    expect((mismatch as DshWireParseError).kind).toBe('bad-value');
  });

  it('throws a classified remote error when the metadata envelope says ok:false', () => {
    const body = encodeMultipart([
      {
        name: 'metadata',
        body: JSON.stringify(remoteErrorEnvelope('gateway/internal', 'multipart boom', 'rpc-1')),
      },
      { name: 'bytes-1', body: new Uint8Array([1]) },
    ]);
    const parsed = parseDshMultipartResponse(multipartContentType(), body);
    const error = catchError(() => unwrapDshMultipartResponse(parsed, 'rpc-1'));
    expect(error).toBeInstanceOf(DshRemoteRpcError);
    expect((error as DshRemoteRpcError).code).toBe('gateway/internal');
  });

  it('tolerates LF-only line endings defensively', () => {
    const encoder = new TextEncoder();
    const body = encoder.encode(
      `--${BOUNDARY}\nContent-Disposition: form-data; name="metadata"\n\n${JSON.stringify(metadataEnvelope)}\n--${BOUNDARY}\nContent-Disposition: form-data; name="bytes-1"\n\n\u0001\u0002\n--${BOUNDARY}--\n`,
    );
    const parsed = parseDshMultipartResponse(multipartContentType(), body);
    expect(parsed.metadata).toEqual(metadataEnvelope);
    expect(Array.from(parsed.bytes[0]!)).toEqual([1, 2]);
  });

  it('rejects a truncated body (missing closing boundary)', () => {
    const body = encodeMultipart(
      [
        { name: 'metadata', body: JSON.stringify(metadataEnvelope) },
        { name: 'bytes-1', body: new Uint8Array([1, 2, 3]) },
      ],
      { closingBoundary: false },
    );
    const error = catchError(() => parseDshMultipartResponse(multipartContentType(), body));
    expect(error).toBeInstanceOf(DshWireParseError);
    expect((error as DshWireParseError).kind).toBe('bad-value');
    expect((error as Error).message).toContain('truncated');
  });

  it('rejects a missing metadata part and a missing boundary parameter', () => {
    const noMetadata = encodeMultipart([{ name: 'bytes-1', body: new Uint8Array([1]) }]);
    const missingPart = catchError(() => parseDshMultipartResponse(multipartContentType(), noMetadata));
    expect(missingPart).toBeInstanceOf(DshWireParseError);
    expect((missingPart as DshWireParseError).kind).toBe('missing-field');

    const body = encodeMultipart([
      { name: 'metadata', body: JSON.stringify(metadataEnvelope) },
      { name: 'bytes-1', body: new Uint8Array([1]) },
    ]);
    const missingBoundary = catchError(() =>
      parseDshMultipartResponse('multipart/form-data', body),
    );
    expect(missingBoundary).toBeInstanceOf(DshWireParseError);
    expect((missingBoundary as DshWireParseError).kind).toBe('bad-value');
  });

  it('rejects metadata that is not JSON or not an object', () => {
    for (const metadata of ['not json at all', '"a string"', '42']) {
      const body = encodeMultipart([
        { name: 'metadata', body: metadata },
        { name: 'bytes-1', body: new Uint8Array([1]) },
      ]);
      const error = catchError(() => parseDshMultipartResponse(multipartContentType(), body));
      expect(error).toBeInstanceOf(DshWireParseError);
      expect(['not-json', 'not-object']).toContain((error as DshWireParseError).kind);
    }
  });

  it('rejects an empty body', () => {
    const error = catchError(() =>
      parseDshMultipartResponse(multipartContentType(), new Uint8Array()),
    );
    expect(error).toBeInstanceOf(DshWireParseError);
    expect((error as DshWireParseError).kind).toBe('missing-field');
  });
});

describe('createDshRpcClient — multipart responses', () => {
  const metadataEnvelope = {
    type: 'server-response',
    rpcId: 'dsh-1',
    result: {
      ok: true,
      value: { attachments: [{ path: 'blob', codec: 'bytes', part: 'bytes-1' }] },
    },
  };

  function multipartResponse(
    parts: ReadonlyArray<{ name: string; body: Uint8Array | string }>,
    options?: { closingBoundary?: boolean },
  ) {
    return bytesResponse(encodeMultipart(parts, options), multipartContentType());
  }

  it('call() unwraps the metadata envelope value', async () => {
    const { client } = createClient(
      multipartResponse([
        { name: 'metadata', body: JSON.stringify(metadataEnvelope) },
        { name: 'bytes-1', body: new Uint8Array([7, 7, 7]) },
      ]),
    );
    await expect(client.call('session', 'readFile')).resolves.toEqual(metadataEnvelope.result.value);
  });

  it('callMultipart() returns {metadata, bytes} for attachment endpoints', async () => {
    const raw = new Uint8Array([10, 20, 30]);
    const { client } = createClient(
      multipartResponse([
        { name: 'metadata', body: JSON.stringify(metadataEnvelope) },
        { name: 'bytes-1', body: raw },
      ]),
    );
    const result = await client.callMultipart('session', 'readFile');
    expect(result.metadata).toEqual(metadataEnvelope);
    expect(result.bytes).toHaveLength(1);
    expect(Array.from(result.bytes[0]!)).toEqual([10, 20, 30]);
  });

  it('callMultipart() surfaces a classified remote error from the metadata envelope', async () => {
    const { client } = createClient(
      multipartResponse([
        {
          name: 'metadata',
          body: JSON.stringify(
            remoteErrorEnvelope('gateway/input-invalid', 'bad attachment request', 'dsh-1'),
          ),
        },
        { name: 'bytes-1', body: new Uint8Array([1]) },
      ]),
    );
    const error = await catchErrorAsync(() => client.callMultipart('session', 'readFile'));
    expect(error).toBeInstanceOf(DshRemoteRpcError);
    expect((error as DshRemoteRpcError).code).toBe('gateway/input-invalid');
  });

  it('rejects a truncated multipart body end to end', async () => {
    const { client } = createClient(
      multipartResponse(
        [
          { name: 'metadata', body: JSON.stringify(metadataEnvelope) },
          { name: 'bytes-1', body: new Uint8Array([1, 2]) },
        ],
        { closingBoundary: false },
      ),
    );
    const error = await catchErrorAsync(() => client.callMultipart('session', 'readFile'));
    expect(error).toBeInstanceOf(DshWireParseError);
    expect((error as DshWireParseError).kind).toBe('bad-value');
  });
});
